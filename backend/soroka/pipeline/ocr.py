"""Tesseract wrappers (CLI): OSD, OCR with word boxes + searchable PDF in one call, Russian post-fixes."""
import csv
import io
import os
import re
import subprocess
import tempfile
from pathlib import Path

import cv2
import numpy as np

from ..config import settings

ENV = {**os.environ, "OMP_THREAD_LIMIT": str(settings().tesseract_threads)}
CYR = re.compile(r"[А-Яа-яЁё]")
LAT = re.compile(r"[A-Za-z]")

# Latin <-> Cyrillic look-alikes (§5.2)
LAT2CYR = str.maketrans("aeopcxyAEOPCXBKMHT", "аеорсхуАЕОРСХВКМНТ")
CYR2LAT = str.maketrans("аеорсхуАЕОРСХВКМНТ", "aeopcxyAEOPCXBKMHT")
LAT_LOOK = set("aeopcxyAEOPCXBKMHT")
CYR_LOOK = set("аеорсхуАЕОРСХВКМНТ")
_EDGE_PUNCT = ".,;:!?«»\"'()[]{}—–-…“”„"


def _run(args: list[str], timeout: int = 600) -> subprocess.CompletedProcess:
    return subprocess.run(args, capture_output=True, timeout=timeout, env=ENV)


def osd(img: np.ndarray) -> dict | None:
    """Tesseract OSD. Returns {rotate (clockwise deg to fix), orientation_conf, script, script_conf}."""
    small = img
    h, w = img.shape[:2]
    if max(h, w) > 2200:
        s = 2200 / max(h, w)
        small = cv2.resize(img, (int(w * s), int(h * s)), interpolation=cv2.INTER_AREA)
    with tempfile.TemporaryDirectory() as d:
        p = os.path.join(d, "in.png")
        cv2.imwrite(p, small)
        r = _run(["tesseract", p, "stdout", "--psm", "0", "-l", "osd"], timeout=120)
    out = r.stdout.decode(errors="replace")
    vals = dict(re.findall(r"^([A-Za-z ]+):\s*(.+)$", out, re.M))
    if "Rotate" not in vals:
        return None
    try:
        return {"rotate": int(vals["Rotate"]) % 360, "orientation_conf": float(vals.get("Orientation confidence", 0)),
                "script": vals.get("Script", "").strip(), "script_conf": float(vals.get("Script confidence", 0))}
    except ValueError:
        return None


def parse_tsv(tsv: str) -> list[dict]:
    rows = []
    for r in csv.DictReader(io.StringIO(tsv), delimiter="\t", quoting=csv.QUOTE_NONE):
        try:
            rows.append({k: (int(float(v)) if k not in ("text", "conf") else v) for k, v in r.items() if k})
        except (TypeError, ValueError):
            continue
    return rows


def ocr(image_path: str, langs: str, dpi: int, want_pdf: bool = True, psm: int = 3) -> dict:
    """One tesseract call -> TSV (words, boxes, confidences) and optionally a 1-page searchable PDF."""
    with tempfile.TemporaryDirectory() as d:
        base = os.path.join(d, "out")
        args = ["tesseract", image_path, base, "-l", langs, "--psm", str(psm), "--dpi", str(dpi),
                "-c", "tessedit_create_tsv=1", "-c", "preserve_interword_spaces=1"]
        if want_pdf:
            args += ["-c", "tessedit_create_pdf=1"]
        r = _run(args)
        if r.returncode != 0:
            raise RuntimeError("tesseract failed: " + r.stderr.decode(errors="replace")[-500:])
        tsv = Path(base + ".tsv").read_text(encoding="utf-8", errors="replace")
        pdf = Path(base + ".pdf").read_bytes() if want_pdf else None
    rows = parse_tsv(tsv)
    words = []
    for r in rows:
        if r.get("level") != 5:
            continue
        t = (r.get("text") or "").strip()
        if not t:
            continue
        try:
            conf = float(r.get("conf", -1))
        except ValueError:
            conf = -1
        words.append({"text": fix_lookalikes(t), "raw": t, "conf": round(conf, 1),
                      "box": [r["left"], r["top"], r["width"], r["height"]],
                      "block": r["block_num"], "par": r["par_num"], "line": r["line_num"]})
    blocks = {}
    for r in rows:
        if r.get("level") == 2:
            blocks[r["block_num"]] = {"id": r["block_num"], "type": "text",
                                      "box": [r["left"], r["top"], r["width"], r["height"]]}
    return {"words": words, "blocks": list(blocks.values()), "pdf": pdf, **score_words(words)}


def score_words(words: list[dict]) -> dict:
    confs = [w["conf"] for w in words if w["conf"] >= 0]
    mean_conf = float(np.mean(confs)) if confs else 0.0
    # share of the word-like tokens that read as real words. Only tokens with letters count: numbers, prices and
    # dot leaders ("321,00", "........", a receipt is full of them) are no sign of garbled text; punctuation around
    # a word («ПРОДУКТЫ», "покупку!") does not make it less of a word
    tokens, plausible = [], []
    for w in words:
        core = w["text"].strip(_EDGE_PUNCT)
        if len(core) < 3 or not any(c.isalpha() for c in core):
            continue
        tokens.append(w)
        if core.replace("-", "").isalpha() and w["conf"] >= 70 and not (CYR.search(core) and LAT.search(core)):
            plausible.append(w)
    valid_ratio = len(plausible) / len(tokens) if tokens else 0.0
    return {"mean_conf": round(mean_conf, 1), "valid_ratio": round(valid_ratio, 3), "n_words": len(words),
            "real_words": real_words(words)}


VOWELS = set("aeiouyAEIOUYаеёиоуыэюяАЕЁИОУЫЭЮЯ")
WORDLIKE = re.compile(r"^[^\w]*([A-Za-z]+|[А-Яа-яЁё]+)(?:-([A-Za-z]+|[А-Яа-яЁё]+))?[^\w]*$")


def real_words(words: list[dict], min_conf: float = 60) -> float:
    """How many OCR words look like real words: one script, >= 3 letters, a vowel, confident. Numbers with
    >= 3 digits count half. Texture/photo noise yields short, mixed, vowel-less or low-confidence tokens."""
    n = 0.0
    for w in words:
        t, conf = w["text"], w["conf"]
        if conf < min_conf:
            continue
        m = WORDLIKE.match(t)
        if m:
            core = m.group(1) + (m.group(2) or "")
            if len(core) >= 3 and any(c in VOWELS for c in core) and not (CYR.search(core) and LAT.search(core)):
                n += 1
        elif sum(c.isdigit() for c in t) >= 3 and conf >= 70:
            n += 0.5
    return n


def fix_lookalikes(word: str) -> str:
    """Mixed-script word: convert look-alike letters to the word's dominant script (word-level context)."""
    c, lat = len(CYR.findall(word)), len(LAT.findall(word))
    if not c or not lat:
        return word
    if c >= lat and all(ch in LAT_LOOK for ch in word if LAT.match(ch)):
        return word.translate(LAT2CYR)
    if lat > c and all(ch in CYR_LOOK for ch in word if CYR.match(ch)):
        return word.translate(CYR2LAT)
    return word


def script_stats(text: str) -> dict:
    c, lat = len(CYR.findall(text)), len(LAT.findall(text))
    tot = c + lat
    return {"cyr": c / tot if tot else 0.0, "lat": lat / tot if tot else 0.0, "letters": tot}


def detect_language(text: str) -> tuple[str, float]:
    """Script-based language ID (ru/en only for now; fastText/Lingua can replace this later)."""
    s = script_stats(text)
    if s["letters"] < 20:
        return "", 0.0
    if s["cyr"] >= 0.6:
        return "ru", s["cyr"]
    if s["lat"] >= 0.6:
        return "en", s["lat"]
    return "mixed", max(s["cyr"], s["lat"])


def words_to_text(words: list[dict]) -> str:
    out, last = [], None
    for w in words:
        key = (w["block"], w["par"], w["line"])
        if last is not None:
            if key[:2] != last[:2]:
                out.append("\n\n")
            elif key != last:
                out.append("\n")
            else:
                out.append(" ")
        out.append(w["text"])
        last = key
    return "".join(out)


def quick_ocr_score(img: np.ndarray, langs: str, max_side: int = 1600) -> dict:
    """Cheap OCR used by the orientation fallback and consistency check.

    Tesseract's layout analysis also reads *sideways* text (it detects vertical lines and rotates them), so a page
    turned by 90 degrees can read as well as the upright one. Such words come back with boxes taller than wide:
    the score is multiplied by the share of words read horizontally. Small pages are upscaled (Tesseract wants
    an x-height of ~20 px), large ones downscaled."""
    h, w = img.shape[:2]
    s = min(2.0, max_side / max(h, w))
    small = cv2.resize(img, (int(w * s), int(h * s)), interpolation=cv2.INTER_AREA if s < 1 else cv2.INTER_CUBIC) \
        if abs(s - 1) > 0.05 else img
    with tempfile.TemporaryDirectory() as d:
        p = os.path.join(d, "q.png")
        cv2.imwrite(p, small)
        res = ocr(p, langs, 200, want_pdf=False, psm=3)
    # words of 3+ letters: a page of one short line ("АКТ № 5") has no longer ones to tell sideways reading by
    long_words = [x for x in res["words"] if len(x["text"].strip(_EDGE_PUNCT)) >= 3 and x["conf"] >= 50]
    vertical = sum(x["box"][3] > x["box"][2] for x in long_words) / len(long_words) if long_words else 0.0
    base = res["valid_ratio"] * 0.7 + res["mean_conf"] / 100 * 0.3
    return {"mean_conf": res["mean_conf"], "valid_ratio": res["valid_ratio"], "n_words": res["n_words"],
            "real_words": res["real_words"], "vertical": round(vertical, 2),
            "score": round(base * (1 - vertical), 3)}
