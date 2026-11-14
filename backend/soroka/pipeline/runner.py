"""Pipeline orchestration (§5.4). Jobs run in RQ workers.

process_document: split sources into pages (stage 0), run every page, finalize.
process_page:     run stages from `from_stage` on, keeping manual recipe values; render outputs.
finalize_document: aggregate text/tier, acceptance outcome, combined searchable PDF, search index."""
import io
import json
import logging
import os
import secrets
import socket
import struct
import tempfile
import traceback
from datetime import timedelta

import cv2
import numpy as np
import pikepdf
from sqlalchemy import text as sa_text

from .. import appsettings
from .. import models as m
from ..config import settings
from ..db import SessionLocal, now
from ..jobs import enqueue_document, enqueue_page
from ..search import index_document
from ..storage import storage
from . import cv as C
from . import ocr as O
from . import pagemodel as PM
from .recipe import STAGES, normalize, stage_index
from .sources import (decode_images, encode_image, office_to_pdf, pdf_page_kinds, pdf_page_words, render_pdf_page,
                      render_pdf_scan)

log = logging.getLogger("soroka.pipeline")
TIER_RANK = {"high": 0, "medium": 1, "low": 2}
PHOTO_MIMES = {"image/jpeg", "image/heic", "image/webp", "image/avif"}


def worst(tiers) -> str:
    ts = [t for t in tiers if t in TIER_RANK]
    return max(ts, key=TIER_RANK.get) if ts else "high"


# ---------------------------------------------------------------- malware scan (clamd INSTREAM)
def clamav_scan(data: bytes) -> str | None:
    host = settings().clamav_host
    if not host:
        return None
    with socket.create_connection((host, settings().clamav_port), timeout=120) as s:
        s.sendall(b"zINSTREAM\0")
        for i in range(0, len(data), 1 << 16):
            chunk = data[i:i + (1 << 16)]
            s.sendall(struct.pack("!L", len(chunk)) + chunk)
        s.sendall(struct.pack("!L", 0))
        resp = b""
        while not resp.endswith(b"\0"):
            part = s.recv(4096)
            if not part:
                break
            resp += part
    r = resp.decode(errors="replace").strip("\0").strip()
    if r.endswith("FOUND"):
        return r
    if not r.endswith("OK"):
        raise RuntimeError("clamav: " + r)
    return None


# ---------------------------------------------------------------- stage 0: split into pages
def _new_page(db, fo: m.FileOriginal, index: int, kind: str, img: np.ndarray | None, photo: bool) -> m.Page:
    p = m.Page(file_original_id=fo.id, source_index=index, kind=kind, pipeline_version=settings().pipeline_version)
    db.add(p)
    db.flush()
    if img is not None:
        data, ext = encode_image(img, photo)
        p.original_key = storage().put(f"pages/{p.id}/original.{ext}", data)
        p.height, p.width = img.shape[:2]
    r = m.Recipe(page_id=p.id, version=1, data=normalize({}), note="initial")
    db.add(r)
    db.flush()
    p.current_recipe_id = r.id
    return p


def split_document(db, doc: m.Document) -> list[int]:
    page_ids = []
    kinds = set()
    for fid in doc.source_file_ids:
        fo = db.get(m.FileOriginal, fid)
        data = storage().get(fo.blob_key)
        from ..formats import sniff
        kind, _ = sniff(fo.filename, data)
        kinds.add(kind)
        if kind == "image":
            for i, img in enumerate(decode_images(data)):
                page_ids.append(_new_page(db, fo, i, "image", img, fo.mime in PHOTO_MIMES).id)
        elif kind in ("pdf", "office"):
            pdf = data
            if kind == "office":
                pdf = office_to_pdf(data, fo.filename)
                fo.rendition_key = storage().put(f"renditions/{fo.id}.pdf", pdf)
            # scanned pages are rendered later by their own page job (in parallel, one bitmap at a time)
            for pg in pdf_page_kinds(pdf):
                page_ids.append(_new_page(db, fo, pg["index"], pg["kind"], None, False).id)
    doc.file_type = kinds.pop() if len(kinds) == 1 else "mixed"
    v = m.DocumentVersion(document_id=doc.id, number=1, page_ids=page_ids, note="ingest")
    db.add(v)
    db.flush()
    doc.current_version_id = v.id
    doc.page_count = len(page_ids)
    db.commit()
    return page_ids


def source_pdf_bytes(fo: m.FileOriginal) -> bytes:
    return storage().get(fo.rendition_key or fo.blob_key)


# ---------------------------------------------------------------- page processing
class PageRun:
    def __init__(self, db, page: m.Page, from_stage: str):
        self.db, self.page = db, page
        self.from_idx = stage_index(from_stage)
        rec = db.get(m.Recipe, page.current_recipe_id) if page.current_recipe_id else None
        self.recipe = normalize(rec.data if rec else {})
        self.old_recipe = json.dumps(self.recipe, sort_keys=True)
        self.stages = {k: v for k, v in (page.stages or {}).items() if stage_index(k) < self.from_idx}
        self.run_id = secrets.token_hex(6)

    def auto(self, stage: str) -> bool:
        if stage_index(stage) < self.from_idx:
            return False
        r = self.recipe.get(stage)
        return not (r and r.get("manual"))

    def record(self, stage: str, status: str, tier: str | None, method: str = "", **info):
        prev = self.stages.get(stage, {})
        self.stages[stage] = {"status": status, "tier": tier, "method": method, "info": info,
                              "auto": prev.get("auto")}

    def set_auto_value(self, stage: str, value):
        self.stages.setdefault(stage, {})["auto"] = value

    def candidates(self, stage: str, cands: list[C.Candidate], chosen: C.Candidate | None):
        self.db.query(m.StageCandidate).filter_by(page_id=self.page.id, stage=stage).delete()
        for c in cands:
            self.db.add(m.StageCandidate(page_id=self.page.id, stage=stage, method=c.method, params=c.value,
                                         score=c.score, signals=c.signals, chosen=c is chosen, chosen_by="auto",
                                         run_id=self.run_id, pipeline_version=settings().pipeline_version))


def _load_original(page: m.Page) -> np.ndarray:
    if page.original_key is None:  # scanned PDF page, not rendered yet: render it now and keep it as the original
        img = render_pdf_scan(source_pdf_bytes(page.file), page.source_index)
        data, ext = encode_image(img, False)
        page.original_key = storage().put(f"pages/{page.id}/original.{ext}", data)
        page.height, page.width = img.shape[:2]
        return img
    buf = np.frombuffer(storage().get(page.original_key), np.uint8)
    return cv2.imdecode(buf, cv2.IMREAD_COLOR)


def process_page(db, page: m.Page, from_stage: str = "quality", forced: bool = False) -> None:
    page.status = "processing"
    db.commit()
    try:
        run = PageRun(db, page, from_stage)
        if page.kind == "pdf_text":
            _process_text_page(db, page, run)
        else:
            _process_image_page(db, page, run, forced)
        page.stages = run.stages
        if json.dumps(run.recipe, sort_keys=True) != run.old_recipe:
            last = db.query(m.Recipe).filter_by(page_id=page.id).order_by(m.Recipe.version.desc()).first()
            r = m.Recipe(page_id=page.id, version=(last.version + 1) if last else 1, data=run.recipe, note="auto")
            db.add(r)
            db.flush()
            page.current_recipe_id = r.id
        page.rendered_recipe_id = page.current_recipe_id
        page.tier = worst(s.get("tier") for s in run.stages.values() if s.get("status") != "skipped")
        page.status = "ready"
        page.error = ""
        page.pipeline_version = settings().pipeline_version
        db.commit()
    except Exception as e:  # noqa: BLE001
        db.rollback()
        log.exception("page %s failed", page.id)
        page = db.get(m.Page, page.id)
        page.status, page.error, page.tier = "error", f"{e}\n{traceback.format_exc()[-1500:]}", "low"
        db.commit()


def _process_text_page(db, page: m.Page, run: PageRun) -> None:
    fo = page.file
    pdf = source_pdf_bytes(fo)
    img = render_pdf_page(pdf, page.source_index, 150)
    page.height, page.width = img.shape[:2]
    text, words = pdf_page_words(pdf, page.source_index, 150)
    for s in ("quality", "acceptance", "crop", "orientation", "dewarp", "deskew", "cleanup"):
        run.record(s, "skipped", None, reason="born_digital_page")
    run.record("ocr", "done", "high", "pdf_text_layer", words=len(words))
    run.record("layout", "skipped", None, reason="phase2")
    run.record("consistency", "skipped", None)
    lang, _ = O.detect_language(text)
    # single-page pdf copied from the source (keeps vector text)
    src = pikepdf.open(io.BytesIO(pdf))
    out = pikepdf.new()
    out.pages.append(src.pages[page.source_index])
    buf = io.BytesIO()
    out.save(buf)
    _store_outputs(page, img, buf.getvalue(), {"words": words, "blocks": [], "width": img.shape[1],
                                              "height": img.shape[0]}, text, lang, ".jpg")
    run.record("outputs", "done", "high")


def _process_image_page(db, page: m.Page, run: PageRun, forced: bool, rescue: list | None = None) -> None:
    rec = run.recipe
    orig = _load_original(page)

    # 1. quality (cheap, informational)
    q = C.quality(orig) if run.auto("quality") or "quality" not in run.stages else None
    if q:
        qt = q.pop("tier")
        run.record("quality", "done", qt, "classic", **q)

    # 3. boundary candidates (computed before acceptance: boundary success is an acceptance signal)
    boundary_score = 0.5
    if rescue:  # another pass: no text inside the chosen page -> maybe the wrong boundary, try the next candidate
        alt = rescue[0]
        quad, _ = C.refine_quad(orig, alt["quad"])
        rec["crop"].update({"quad": quad, "method": alt["method"], "mode": "quad", "polygon": None})
        run.set_auto_value("crop", quad)
        prev = run.stages.get("crop", {}).get("info", {})
        run.record("crop", "done", "low", alt["method"], score=alt["score"], reason="no_text_in_first_choice",
                   candidates=prev.get("candidates", []))
        boundary_score = alt["score"]
    elif run.auto("crop"):
        cands, chosen, tier, sig = C.detect_boundary(orig)
        run.candidates("crop", cands, chosen)
        # trim background bands still inside the chosen quad (desk strips along an edge)
        quad, refine = C.refine_quad(orig, chosen.value["quad"])
        rec["crop"].update({"quad": quad, "method": chosen.method, "mode": "quad", "polygon": None})
        method, page_mask = chosen.method, None
        # photos: the page outline from MobileSAM (follows curved and partly covered pages; editable)
        # curved pages (bound books, curls) use it with flattening; flat pages and scans keep the exact 4-corner
        # crop (their outline is straight or the whole image), the outline is kept for the editor
        # not on scans (the page is the whole frame): there MobileSAM outlines the text area instead of the page
        is_scan = chosen.method == "full_frame" and sig.get("flat_scan", 0.0) > 0.7
        polygon, page_mask = (None, {"reason": "scan"}) if is_scan else PM.page_outline(orig)
        if polygon:
            bend = PM.outline_bend(polygon)
            page_mask["bend"] = round(bend, 4)
            rec["crop"]["polygon"] = polygon
            if bend >= PM.BEND_CURVED:
                corners = PM.mask_corners(np.array(polygon, np.float32))
                rec["crop"].update({"mode": "mask", "quad": corners.round(1).tolist()})
                method = "page_mask"
        run.set_auto_value("crop", rec["crop"]["polygon"] if rec["crop"]["mode"] == "mask" else quad)
        run.record("crop", "done", tier, method, score=chosen.score, **sig, refine=refine, page_mask=page_mask,
                   candidates=[{"method": c.method, "score": c.score, "quad": c.value["quad"]} for c in cands])
        boundary_score = chosen.score
    elif rec["crop"]["quad"] is None:
        h, w = orig.shape[:2]
        rec["crop"]["quad"] = [[0, 0], [w - 1, 0], [w - 1, h - 1], [0, h - 1]]
    else:
        if stage_index("crop") >= run.from_idx:
            run.record("crop", "done", "high", "manual")
        boundary_score = (run.stages.get("crop", {}).get("info", {}) or {}).get("score", 0.5)

    # 4. page image: outline mode = outside blacked out, cropped to the outline's box; 4-corner mode = perspective
    base = _page_base(orig, rec["crop"])

    # 6. flattening + shading correction (SyntheticDoc; model, shading and mesh editable): right after the crop,
    # so everything after sees the flat page. Curved pages (outline crop): high-res model with shading.
    d = rec["dewarp"]
    if run.auto("dewarp"):
        curved = rec["crop"].get("mode") == "mask" and PM.available()
        d.update({"model": "high" if curved else None, "shading": curved, "mesh": None, "mesh_edited": False})
        run.set_auto_value("dewarp", {"model": d["model"], "shading": d["shading"]})
    img, proposed = _flattened(base, d)
    if not d["mesh_edited"]:
        d["mesh"] = proposed  # the model's map as an editable mesh
    flat = img
    if stage_index("dewarp") >= run.from_idx:
        curv = C.text_line_curvature(img)
        tier = "high" if curv < 0.15 else ("medium" if curv < 0.3 else "low")
        on = bool(d["model"] or d["shading"] or d["mesh_edited"])
        run.record("dewarp", "done" if on else "skipped", tier,
                   ("manual" if d["manual"] else "syntheticdoc") if on else "none", curvature=curv,
                   model=d["model"], shading=d["shading"], mesh_edited=d["mesh_edited"])

    # 2. acceptance (§4): text/colour signals measured on the cropped page, not the background
    if run.auto("acceptance"):
        sig = C.acceptance_signals(img, boundary_score)
        doc_t = appsettings.get(db, "accept_doc_threshold")
        rej_t = appsettings.get(db, "accept_reject_threshold")
        if forced:
            val, tier = "document", "high"
        elif sig["score"] >= doc_t:
            val, tier = "document", "high"
        elif sig["score"] >= rej_t:
            val, tier = "uncertain", "low"
        else:
            val, tier = "non_document", "high"
        rec["acceptance"]["value"] = val
        run.set_auto_value("acceptance", val)
        run.record("acceptance", "done", tier, "heuristic_v1", value=val, forced=forced, **sig)
        run.candidates("acceptance", [C.Candidate("heuristic_v1", {"value": val}, sig["score"], sig)], None)
    elif stage_index("acceptance") >= run.from_idx:
        run.record("acceptance", "done", "high", "manual", value=rec["acceptance"]["value"])

    # 5. orientation (+ script)
    if run.auto("orientation"):
        angle, tier, info = _estimate_orientation(img)
        rec["orientation"]["angle"] = angle
        run.set_auto_value("orientation", angle)
        run.record("orientation", "done", tier, info.pop("method"), **info)
    elif stage_index("orientation") >= run.from_idx:
        run.record("orientation", "done", "high", "manual", angle=rec["orientation"]["angle"])
    img = C.rotate90(img, rec["orientation"]["angle"])

    # 7. fine deskew
    if run.auto("deskew"):
        ang, tier, info = C.estimate_deskew(img)
        rec["deskew"]["angle"] = ang
        run.set_auto_value("deskew", ang)
        run.record("deskew", "done", tier, "projection_profile", angle=ang, **info)
    elif stage_index("deskew") >= run.from_idx:
        run.record("deskew", "done", "high", "manual", angle=rec["deskew"]["angle"])
    img = C.rotate_small(img, rec["deskew"]["angle"])

    # 8. cleanup
    if run.auto("cleanup"):
        mode, info = C.choose_cleanup_mode(C.whiten(C.downscale(img, 1200)[0]))
        rec["cleanup"].update({"mode": mode, "strength": 1.0})
        run.set_auto_value("cleanup", mode)
        run.record("cleanup", "done", "high", "background_division", mode=mode, **info)
    elif stage_index("cleanup") >= run.from_idx:
        run.record("cleanup", "done", "high", "manual", mode=rec["cleanup"]["mode"])
    clean = C.cleanup(img, rec["cleanup"]["mode"] or "gray", float(rec["cleanup"]["strength"]))

    # 9-12: OCR, layout, consistency, outputs
    result = _ocr_and_outputs(db, page, run, clean)

    # 11. consistency check: low valid-word ratio despite confident orientation -> reopen orientation once
    ori = run.stages.get("orientation", {})
    if (result["valid_ratio"] < 0.35 and result["n_words"] >= 15 and not rec["orientation"]["manual"]
            and ori.get("method") != "ocr_4_rotations" and stage_index("orientation") >= run.from_idx):
        base = flat
        angle, tier, info = _orientation_fallback(_normalized(base), "rus+eng")
        if angle != rec["orientation"]["angle"] and info["best_score"] > result["valid_ratio"] + 0.1:
            rec["orientation"]["angle"] = angle
            run.record("orientation", "done", "low", "ocr_4_rotations", angle=angle, reopened=True, **info)
            img = C.rotate90(base, angle)
            if not rec["deskew"]["manual"]:
                rec["deskew"]["angle"], _, _ = C.estimate_deskew(img)
            img = C.rotate_small(img, rec["deskew"]["angle"])
            clean = C.cleanup(img, rec["cleanup"]["mode"] or "gray", float(rec["cleanup"]["strength"]))
            result = _ocr_and_outputs(db, page, run, clean)
            run.record("consistency", "done", "low", "valid_word_ratio", reopened_orientation=True,
                       valid_ratio=result["valid_ratio"])
        else:
            run.record("consistency", "done", "medium", "valid_word_ratio", valid_ratio=result["valid_ratio"])
    else:
        tier = "high" if result["valid_ratio"] >= 0.5 or result["n_words"] < 15 else "medium"
        run.record("consistency", "done", tier, "valid_word_ratio", valid_ratio=result["valid_ratio"],
                   n_words=result["n_words"])

    # 2b. acceptance, final decision with OCR evidence (§4): the pre-OCR heuristic only sees blobs and colours;
    # a page on which OCR finds no real words is not a document, whatever its shape or colour.
    if run.auto("acceptance") and not forced:
        if result.get("real_words", 0) <= 2 and run.auto("crop") and stage_index("crop") >= run.from_idx:
            alts = _rescue_candidates(run, rec["crop"]["quad"]) if rescue is None else rescue[1:]
            if alts:
                return _process_image_page(db, page, run, forced, rescue=alts)
        _acceptance_with_ocr(db, run, result)


def _page_base(orig: np.ndarray, crop: dict) -> np.ndarray:
    if crop.get("mode") == "none" or not crop.get("quad") and not crop.get("polygon"):
        return orig
    if crop.get("mode") == "mask" and crop.get("polygon"):
        return PM.masked_crop(orig, crop["polygon"])
    return C.warp(orig, crop["quad"])


def _flattened(base: np.ndarray, d: dict) -> tuple[np.ndarray, list | None]:
    return PM.flatten_page(base, d.get("model"), bool(d.get("shading")), d.get("mesh") if d.get("mesh_edited") else None)


def page_base_image(page: m.Page, recipe: dict) -> np.ndarray:
    """The cropped page before flattening (the image the flattening mesh is drawn on in the editor)."""
    return _page_base(_load_original(page), normalize(recipe)["crop"])


def _rescue_candidates(run: PageRun, chosen_quad: list, limit: int = 2) -> list[dict]:
    """Before rejecting a page for having no text, the next-best boundary candidates that differ from the chosen
    one get a chance (a wrong crop, e.g. following a shadow, also yields no text)."""
    cands = sorted((run.stages.get("crop", {}).get("info", {}) or {}).get("candidates", []),
                   key=lambda c: -c["score"])
    out, seen = [], [np.array(chosen_quad, np.float32)]
    for c in cands:
        q = np.array(c["quad"], np.float32)
        if c["score"] < 0.45 or any(C.quad_iou(q, x) > 0.8 for x in seen):
            continue
        seen.append(q)
        out.append(c)
        if len(out) >= limit:
            break
    return out


def _acceptance_with_ocr(db, run: PageRun, result: dict) -> None:
    st = run.stages.get("acceptance") or {}
    info = dict(st.get("info") or {})
    prior = float(info.get("score", 0.0))
    doc_t = appsettings.get(db, "accept_doc_threshold")
    rej_t = appsettings.get(db, "accept_reject_threshold")
    n = result.get("real_words", O.real_words(result.get("words", [])))
    if n >= 10:
        val, tier = "document", "high"
    elif n <= 2:
        # text-like structure but nothing readable (very blurry / tiny text): let a human decide
        # (OCR must have seen many tokens it could not read: brick walls and stripes give none)
        if prior >= doc_t and info.get("text_lines", 0) >= 10 and result.get("n_words", 0) >= 20:
            val, tier = "uncertain", "low"
        else:
            val, tier = "non_document", "high"
    elif prior >= doc_t:
        val, tier = "document", "medium"
    else:
        val, tier = "uncertain", "low"
    info.update({"value": val, "real_words": n, "prior_score": prior})
    run.recipe["acceptance"]["value"] = val
    run.set_auto_value("acceptance", val)
    run.record("acceptance", "done", tier, "heuristic_v2_ocr", **info)


def _normalized(img: np.ndarray, max_side: int = 2200) -> np.ndarray:
    """Background-normalized grey page (shadows, low light and colour casts removed) for OSD / quick OCR."""
    small, _ = C.downscale(img, max_side)
    return C.gray(C.whiten(small))


def _estimate_orientation(img: np.ndarray) -> tuple[int, str, dict]:
    img = _normalized(img)
    o = O.osd(img)
    ld = C.line_direction(img)
    if o and o["orientation_conf"] >= 1.5:
        horiz_expected = o["rotate"] in (0, 180)
        agree = horiz_expected == ld["horizontal"]
        tier = "high" if o["orientation_conf"] >= 4 and agree else "medium"
        if o["orientation_conf"] >= 4 or agree:
            return o["rotate"], tier, {"method": "tesseract_osd", **o, "line_direction": ld, "agree": agree}
    langs = "rus+eng"
    if o and o.get("script") == "Latin" and o.get("script_conf", 0) > 1:
        langs = "eng"
    elif o and o.get("script") == "Cyrillic" and o.get("script_conf", 0) > 1:
        langs = "rus"
    angle, tier, info = _orientation_fallback(img, langs, ld)
    return angle, tier, {"method": "ocr_4_rotations", "osd": o, "line_direction": ld, **info}


def _orientation_fallback(img: np.ndarray, langs: str, ld: dict | None = None) -> tuple[int, str, dict]:
    """OCR the page in each candidate rotation and keep the one that reads best.

    Tesseract's layout analysis reads sideways text almost as well as upright text (0 and 270 can score the
    same), so it can only tell 0 from 180 (or 90 from 270) reliably. The text-line direction decides the axis
    when it is clear; ties go to the rotation that makes lines horizontal."""
    ld = ld or C.line_direction(img)
    r = ld["ratio"]
    if r >= 1.6:
        angles = (0, 180)
    elif r <= 1 / 1.6:
        angles = (90, 270)
    else:
        angles = (0, 90, 180, 270)
    scores = {a: O.quick_ocr_score(C.rotate90(img, a), langs) for a in angles}
    horiz_first = (0, 180) if r >= 1 else (90, 270)
    ranked = sorted(scores, key=lambda a: (scores[a]["score"], a in horiz_first), reverse=True)
    best, second = ranked[0], ranked[1]
    b, s = scores[best]["score"], scores[second]["score"]
    tier = "medium" if b > 0.3 and b - s > 0.15 else "low"
    if b < 0.05:  # no text at all: keep upright
        best, tier = 0, "low"
    return best, tier, {"scores": {str(k): v for k, v in scores.items()}, "best_score": b, "langs": langs}


def _ocr_and_outputs(db, page: m.Page, run: PageRun, clean: np.ndarray) -> dict:
    rec = run.recipe
    h, w = clean.shape[:2]
    dpi = int(max(150, min(600, w / 8.27)))  # assume an A4-ish page width for the PDF page size
    ext = ".png" if rec["cleanup"]["mode"] == "bw" else ".jpg"
    with tempfile.TemporaryDirectory() as d:
        path = os.path.join(d, "page" + ext)
        params = [cv2.IMWRITE_JPEG_QUALITY, 85] if ext == ".jpg" else []
        cv2.imwrite(path, clean, params)
        _set_dpi(path, dpi)
        langs = rec["ocr"]["langs"]
        res = O.ocr(path, langs, dpi)
        text = O.words_to_text(res["words"])
        lang, conf = O.detect_language(text)
        passes = [{"langs": langs, "mean_conf": res["mean_conf"], "valid_ratio": res["valid_ratio"]}]
        # pass 2 (expensive on doubt): exact language model when language is confident and quality is doubtful
        if run.auto("ocr") and res["mean_conf"] < 80 and conf >= 0.9 and lang in ("ru", "en"):
            exact = {"ru": "rus", "en": "eng"}[lang]
            if exact != langs:
                res2 = O.ocr(path, exact, dpi)
                passes.append({"langs": exact, "mean_conf": res2["mean_conf"], "valid_ratio": res2["valid_ratio"]})
                if res2["valid_ratio"] + res2["mean_conf"] / 200 > res["valid_ratio"] + res["mean_conf"] / 200:
                    res = res2
                    text = O.words_to_text(res["words"])
        img_bytes = open(path, "rb").read()
    ocr_tier = "high" if res["mean_conf"] >= 80 else ("medium" if res["mean_conf"] >= 60 else "low")
    if res["n_words"] == 0:
        ocr_tier = "medium"
    run.record("ocr", "done", ocr_tier, "tesseract_lstm", mean_conf=res["mean_conf"], valid_ratio=res["valid_ratio"],
               n_words=res["n_words"], language=lang, passes=passes)
    # layout (basic: tesseract blocks; PP-Structure in phase 2)
    blocks = res["blocks"]
    for b in blocks:
        bw = [x for x in res["words"] if x["block"] == b["id"]]
        b["text"] = O.words_to_text(bw)
        b["lang"] = O.detect_language(b["text"])[0]
    run.record("layout", "done", "high", "tesseract_blocks", blocks=len(blocks))
    structured = {"width": w, "height": h, "dpi": dpi, "language": lang, "blocks": blocks, "words": res["words"]}
    _store_outputs(page, None, res["pdf"], structured, text, lang, ext, img_bytes=img_bytes)
    run.record("outputs", "done", "high", "searchable_pdf")
    return res


def _set_dpi(path: str, dpi: int) -> None:
    from PIL import Image
    im = Image.open(path)
    im.load()
    if path.endswith(".jpg"):
        im.save(path, quality=85, dpi=(dpi, dpi))
    else:
        im.save(path, dpi=(dpi, dpi))


def _store_outputs(page: m.Page, img: np.ndarray | None, pdf: bytes, structured: dict, text: str, lang: str,
                   ext: str, img_bytes: bytes | None = None) -> None:
    st = storage()
    v = secrets.token_hex(4)  # unique render id (cache busting)
    for k in (page.render_key, page.thumb_key, page.pdf_key, page.words_key):
        st.delete(k)
    if img_bytes is None:
        _, buf = cv2.imencode(".jpg", img, [cv2.IMWRITE_JPEG_QUALITY, 85])
        img_bytes = buf.tobytes()
        ext = ".jpg"
    page.render_key = st.put(f"pages/{page.id}/render-{v}{ext}", img_bytes)
    arr = cv2.imdecode(np.frombuffer(img_bytes, np.uint8), cv2.IMREAD_COLOR)
    th, _ = C.downscale(arr, 400)
    _, tb = cv2.imencode(".jpg", th, [cv2.IMWRITE_JPEG_QUALITY, 80])
    page.thumb_key = st.put(f"pages/{page.id}/thumb-{v}.jpg", tb.tobytes())
    page.pdf_key = st.put(f"pages/{page.id}/page-{v}.pdf", pdf)
    page.words_key = st.put(f"pages/{page.id}/words-{v}.json", json.dumps(structured, ensure_ascii=False).encode())
    page.text = text
    page.language = lang


# ---------------------------------------------------------------- document level
def build_document_pdf(db, doc: m.Document) -> None:
    v = db.get(m.DocumentVersion, doc.current_version_id)
    out = pikepdf.new()
    for pid in v.page_ids:
        p = db.get(m.Page, pid)
        if p and p.pdf_key and storage().exists(p.pdf_key):
            src = pikepdf.open(io.BytesIO(storage().get(p.pdf_key)))
            out.pages.extend(src.pages)
    if len(out.pages) == 0:
        return
    buf = io.BytesIO()
    out.save(buf)
    old = doc.pdf_key
    doc.pdf_key = storage().put(f"documents/{doc.id}/doc-{secrets.token_hex(4)}.pdf", buf.getvalue())
    if old and old != doc.pdf_key:
        storage().delete(old)


def finalize_document(document_id: int) -> None:
    db = SessionLocal()
    try:
        # row lock: page jobs finishing at the same time finalize one after the other, not interleaved
        db.execute(sa_text("SELECT id FROM document WHERE id = :i FOR UPDATE"), {"i": document_id})
        doc = db.get(m.Document, document_id)
        if doc is None or doc.current_version_id is None or doc.trashed_at is not None or doc.status == "stopped":
            return
        v = db.get(m.DocumentVersion, doc.current_version_id)
        pages = [db.get(m.Page, pid, populate_existing=True) for pid in v.page_ids]
        pages = [p for p in pages if p]
        if any(p.status in ("queued", "processing") for p in pages):
            return  # another job will finalize
        doc.page_count = len(pages)
        doc.content = "\n\f\n".join(p.text or "" for p in pages)
        doc.tier = worst(p.tier for p in pages)
        langs = [p.language for p in pages if p.language]
        doc.language = max(set(langs), key=langs.count) if langs else ""
        doc.needs_review = any(p.tier == "low" and not p.reviewed for p in pages)
        errors = [p for p in pages if p.status == "error"]

        forced = bool(doc.ingest_event and doc.ingest_event.forced)
        accept = [("non_document" if _marked_non_document(db, p) else
                   ((p.stages or {}).get("acceptance", {}).get("info", {}) or {}).get("value")) for p in pages
                  if p.kind == "image"]
        manual_doc = any(normalize(db.get(m.Recipe, p.current_recipe_id).data)["acceptance"]["manual"] and
                         normalize(db.get(m.Recipe, p.current_recipe_id).data)["acceptance"]["value"] == "document"
                         for p in pages if p.current_recipe_id)
        all_image = pages and all(p.kind == "image" for p in pages)
        if all_image and not forced and not manual_doc and accept and all(a == "non_document" for a in accept):
            _reject(db, doc, "classified_non_document")
            db.commit()
            return
        build_document_pdf(db, doc)
        if doc.status != "rejected":
            doc.status = "error" if errors and len(errors) == len(pages) else "ready"
            doc.status_detail = f"{len(errors)} page(s) failed" if errors else ""
        index_document(db, doc)
        db.commit()
    finally:
        db.close()


def _reject(db, doc: m.Document, reason: str) -> None:
    doc.status = "rejected"
    size = sum(db.get(m.FileOriginal, f).size for f in doc.source_file_ids if db.get(m.FileOriginal, f))
    days = appsettings.get(db, "rejected_days")
    ri = db.query(m.RejectedItem).filter_by(document_id=doc.id).one_or_none()
    if ri is None:
        ri = m.RejectedItem(document_id=doc.id)
        db.add(ri)
    ri.reason, ri.size, ri.rejected_at, ri.expires_at = reason, size, now(), now() + timedelta(days=days)
    ri.scores = {}
    index_document(db, doc)


# ---------------------------------------------------------------- stop / resume
def halted(doc: m.Document | None) -> bool:
    """Trashed, rejected or deleted documents are not processed; restore / rescue resumes them."""
    return doc is None or doc.trashed_at is not None or doc.status == "rejected"


def _docs_of_page(db, page_id: int) -> list[m.Document]:
    ids = [r[0] for r in db.execute(sa_text(
        "SELECT d.id FROM document d JOIN document_version v ON v.id = d.current_version_id "
        "WHERE v.page_ids @> jsonb_build_array(CAST(:p AS int))"), {"p": page_id}).all()]
    return [db.get(m.Document, i) for i in ids]


def _cancel_jobs(page_ids: set[int], doc_id: int | None = None) -> None:
    """Remove waiting jobs for these pages (and the document's split job) from the queues and kill running ones.
    Killing ends the worker's DB transaction, which releases its lock on the page row."""
    from rq.command import send_stop_job_command
    from rq.job import Job
    from rq.registry import StartedJobRegistry

    from ..jobs import queue, redis

    def ours(job) -> bool:
        fn = job.func_name or ""
        return bool(job.args) and ((fn.endswith("process_page_job") and job.args[0] in page_ids)
                                   or (doc_id is not None and fn.endswith("process_document") and job.args[0] == doc_id))

    for name in ("high", "default", "low"):
        # waiting jobs are removed: left in the queue they would run after a restore, ahead of (and twice with)
        # the pages the restore queues, starting the document somewhere in the middle
        q = queue(name)
        ids = q.get_job_ids()
        for i in range(0, len(ids), 500):
            for job in Job.fetch_many(ids[i:i + 500], connection=redis()):
                if job is not None and ours(job):
                    q.remove(job.id)
                    job.delete()
        reg = StartedJobRegistry(queue=q)
        for job_id in reg.get_job_ids():
            try:
                job = q.fetch_job(job_id.split(":")[0])  # registry entries are 'job_id:execution_id' in RQ 2
                if job is not None and ours(job):
                    send_stop_job_command(redis(), job.id)
            except Exception:  # noqa: BLE001 - the job may have finished meanwhile
                log.warning("could not stop job %s", job_id, exc_info=True)


def _pages_in_active_docs(db, exclude_doc: int) -> set[int]:
    rows = db.execute(sa_text(
        "SELECT DISTINCT CAST(jsonb_array_elements(v.page_ids) AS int) FROM document d "
        "JOIN document_version v ON v.id = d.current_version_id "
        "WHERE d.id <> :d AND d.trashed_at IS NULL AND d.status <> 'rejected'"), {"d": exclude_doc}).all()
    return {r[0] for r in rows}


def stop_processing(db, doc: m.Document) -> int:
    """Stop a document's processing: unfinished pages become 'stopped' (no partial result is kept: a page that was
    being processed starts from its first stage when the document is resumed), waiting page jobs are removed and
    running ones killed. Commits."""
    page_ids = set()
    for v in db.query(m.DocumentVersion).filter_by(document_id=doc.id).all():
        page_ids.update(v.page_ids or [])
    page_ids -= _pages_in_active_docs(db, doc.id)  # a page shared with a live document keeps going
    if doc.status in ("queued", "processing"):
        doc.status = "stopped"
    db.commit()  # the document is halted from here on: page jobs starting now skip it
    # kill before touching page rows: a running page job holds its page row locked until it finishes (~15 s)
    _cancel_jobs(page_ids, doc.id)
    if not page_ids:
        return 0
    # serializes with process_document's fan-out (and a concurrent restore) on the document row
    db.execute(sa_text("SELECT id FROM document WHERE id = :i FOR UPDATE"), {"i": doc.id})
    n = db.execute(sa_text("UPDATE page SET status = 'stopped' WHERE id = ANY(:ids) AND status NOT IN "
                           "('ready', 'excluded')"), {"ids": list(page_ids)}).rowcount
    db.commit()
    return n


def stop_page(db, page: m.Page) -> None:
    """A page marked 'not a document' is not processed (further); the result of a finished page is kept."""
    _cancel_jobs({page.id})
    db.refresh(page)
    if page.status != "ready":
        page.status = "excluded"
    db.commit()


def _marked_non_document(db, page: m.Page) -> bool:
    rec = db.get(m.Recipe, page.current_recipe_id) if page.current_recipe_id else None
    acc = normalize(rec.data if rec else {})["acceptance"]
    return bool(acc.get("manual")) and acc.get("value") == "non_document"


def resume_processing(db, doc: m.Document) -> bool:
    """Continue a stopped document: finished pages are kept, the others are processed from the start."""
    if doc.status != "stopped":
        return False
    doc.status = "processing"
    db.commit()
    enqueue_document(doc.id, doc.queue or "high")
    return True


def process_document(document_id: int) -> None:
    db = SessionLocal()
    try:
        doc = db.get(m.Document, document_id)
        if halted(doc):
            return
        doc.status = "processing"
        db.commit()
        try:
            for fid in doc.source_file_ids:
                fo = db.get(m.FileOriginal, fid)
                hit = clamav_scan(storage().get(fo.blob_key))
                if hit:
                    doc.status, doc.status_detail = "infected", hit
                    db.add(m.AuditLog(action="malware_detected", target=str(doc.id), details={"result": hit}))
                    db.commit()
                    return
            if doc.current_version_id is None:
                split_document(db, doc)
            v = db.get(m.DocumentVersion, doc.current_version_id)
            forced = bool(doc.ingest_event and doc.ingest_event.forced)
            db.execute(sa_text("SELECT id FROM document WHERE id = :i FOR UPDATE"), {"i": doc.id})
            db.refresh(doc)
            if halted(doc):  # trashed / rejected while splitting
                db.commit()
                return
            todo = [p for p in (db.get(m.Page, pid) for pid in v.page_ids)
                    if p.status != "ready" or p.pipeline_version != settings().pipeline_version]
            # one job per page: every worker (one per core) takes pages, so a long document uses all CPUs;
            # the last page job to finish finalizes the document (finalize_document waits for queued pages)
            for p in todo:
                p.status = "queued"
            db.commit()
            for i, p in enumerate(todo):
                # a long document should not hold up live ingest: beyond the first pages it goes to the backlog
                prio = doc.queue if i < 4 else "low"
                enqueue_page(p.id, "quality", prio, forced=forced)
        except Exception as e:  # noqa: BLE001
            db.rollback()
            log.exception("document %s failed", document_id)
            doc = db.get(m.Document, document_id)
            doc.status, doc.status_detail = "error", str(e)[:2000]
            db.commit()
            return
        if todo:
            return
    finally:
        db.close()
    finalize_document(document_id)


def process_page_job(page_id: int, from_stage: str, forced: bool = False) -> None:
    db = SessionLocal()
    try:
        p = db.get(m.Page, page_id)
        if p is None:
            return
        docs = _docs_of_page(db, page_id)
        if docs and all(halted(d) for d in docs):  # trashed / rejected meanwhile: resume will pick it up
            if p.status != "ready":
                p.status = "stopped"
                db.commit()
            return
        if _marked_non_document(db, p):  # the user said: not a document -> do not process it
            if p.status != "ready":
                p.status = "excluded"
                db.commit()
        else:
            process_page(db, p, from_stage, forced)
        doc_ids = [d.id for d in docs]
    finally:
        db.close()
    for d in doc_ids:
        finalize_document(d)
