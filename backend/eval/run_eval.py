"""Run the real image-page pipeline (runner._process_image_page) on a test set, without DB or storage,
and score every stage against the ground truth written by eval.make_testset.

Usage: python -m eval.run_eval DATA_DIR [--out results.json] [--only substr] [-j N]
Metrics: acceptance (document vs rejected), orientation accuracy, crop IoU, OCR word recall, time per image.
"""
import argparse
import json
import os
import re
import sys
import time
from collections import defaultdict
from concurrent.futures import ProcessPoolExecutor

import cv2
import numpy as np

from soroka import appsettings
from soroka.pipeline import cv as C
from soroka.pipeline import runner as R
from soroka.pipeline.recipe import normalize

WORD = re.compile(r"[A-Za-zА-Яа-яЁё]{3,}")


class FakePage:
    id = 0
    kind = "image"
    render_key = thumb_key = pdf_key = words_key = None
    text = language = ""


class FakeRun(R.PageRun):
    def __init__(self):  # noqa: D107 - no DB
        self.db = None
        self.page = FakePage()
        self.from_idx = 0
        self.recipe = normalize({})
        self.old_recipe = ""
        self.stages = {}
        self.run_id = "eval"

    def candidates(self, stage, cands, chosen):
        pass


def _patch(orig_img):
    R._load_original = lambda page: orig_img
    R._store_outputs = lambda page, img, pdf, structured, text, lang, ext, img_bytes=None: (
        setattr(page, "text", text), setattr(page, "language", lang))
    appsettings.get = lambda db, key: appsettings.DEFAULTS.get(key)


def page_decision(run: FakeRun) -> str:
    """Document-level outcome for a single-page image document (mirrors finalize_document)."""
    acc = (run.stages.get("acceptance", {}).get("info", {}) or {}).get("value")
    return "rejected" if acc == "non_document" else "kept"


def run_one(path: str) -> dict:
    img = cv2.imread(path, cv2.IMREAD_COLOR)
    _patch(img)
    run = FakeRun()
    t = time.time()
    err = ""
    try:
        R._process_image_page(None, run.page, run, False)
    except Exception as e:  # noqa: BLE001
        import traceback
        err = f"{e}\n{traceback.format_exc()[-800:]}"
    return {"recipe": run.recipe, "stages": run.stages, "text": run.page.text, "time": round(time.time() - t, 2),
            "decision": page_decision(run), "error": err}


def _bag(words):
    out = defaultdict(int)
    for w in words:
        for m in WORD.findall(w):
            out[m.lower().replace("ё", "е")] += 1
    return out


def word_recall(gt_words, text) -> float:
    g, o = _bag(gt_words), _bag([text or ""])
    tot = sum(g.values())
    return sum(min(c, o.get(k, 0)) for k, c in g.items()) / tot if tot else 1.0


def score(item: dict, res: dict) -> dict:
    s = {"file": item["file"], "is_document": item["is_document"], "time": res["time"], "error": res["error"][:300]}
    s["decision"] = res["decision"]
    s["accept_ok"] = (res["decision"] == "kept") == item["is_document"]
    acc = res["stages"].get("acceptance", {})
    s["acceptance"] = (acc.get("info") or {}).get("value")
    s["accept_score"] = (acc.get("info") or {}).get("score")
    if item["is_document"]:
        rec = res["recipe"]
        s["orient_pred"] = rec["orientation"]["angle"]
        s["orient_ok"] = rec["orientation"]["angle"] == item["fix_rotation"]
        s["orient_method"] = res["stages"].get("orientation", {}).get("method")
        try:
            s["crop_iou"] = round(C.quad_iou(np.array(rec["crop"]["quad"], np.float32),
                                             np.array(item["quad"], np.float32)), 3)
        except Exception:  # noqa: BLE001
            s["crop_iou"] = 0.0
        s["crop_method"] = rec["crop"]["method"]
        s["crop_tier"] = res["stages"].get("crop", {}).get("tier")
        s["deskew"] = rec["deskew"]["angle"]
        s["recall"] = round(word_recall(item["words"], res["text"]), 3)
        s["lang_pred"] = res["stages"].get("ocr", {}).get("info", {}).get("language")
    else:
        s["n_words"] = res["stages"].get("ocr", {}).get("info", {}).get("n_words")
    return s


def _work(args):
    data, item = args
    return score(item, run_one(os.path.join(data, item["file"])))


def summarize(rows: list[dict]) -> dict:
    docs = [r for r in rows if r["is_document"]]
    nd = [r for r in rows if not r["is_document"]]
    out = {
        "n": len(rows),
        "docs_kept": f'{sum(r["accept_ok"] for r in docs)}/{len(docs)}',
        "nondocs_rejected": f'{sum(r["accept_ok"] for r in nd)}/{len(nd)}',
        "orientation_ok": f'{sum(r["orient_ok"] for r in docs)}/{len(docs)}',
        "crop_iou_mean": round(float(np.mean([r["crop_iou"] for r in docs])), 3) if docs else None,
        "crop_iou>=0.9": f'{sum(r["crop_iou"] >= 0.9 for r in docs)}/{len(docs)}',
        "word_recall_mean": round(float(np.mean([r["recall"] for r in docs])), 3) if docs else None,
        "errors": sum(bool(r["error"]) for r in rows),
        "sec_per_image": round(float(np.mean([r["time"] for r in rows])), 1),
    }
    for key in ("mode", "lang"):
        groups = defaultdict(list)
        for r in docs:
            parts = r["file"].split("_")  # doc_{lang}_{mode}_{kind}_r{rot}
            groups[parts[2] if key == "mode" else parts[1]].append(r)
        out[f"by_{key}"] = {k: {"orient": f'{sum(x["orient_ok"] for x in v)}/{len(v)}',
                                "iou": round(float(np.mean([x["crop_iou"] for x in v])), 3),
                                "recall": round(float(np.mean([x["recall"] for x in v])), 3)}
                            for k, v in sorted(groups.items())}
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("data")
    ap.add_argument("--out", default="")
    ap.add_argument("--only", default="")
    ap.add_argument("-j", type=int, default=2)
    a = ap.parse_args()
    manifest = json.load(open(os.path.join(a.data, "manifest.json")))
    items = [x for x in manifest if a.only in x["file"]]
    with ProcessPoolExecutor(a.j) as ex:
        rows = list(ex.map(_work, [(a.data, x) for x in items]))
    for r in rows:
        flag = "OK " if r["accept_ok"] and r.get("orient_ok", True) and r.get("crop_iou", 1) >= 0.9 else "BAD"
        extra = (f'ori={r["orient_pred"]}({"ok" if r["orient_ok"] else "XX"},{r["orient_method"]}) '
                 f'iou={r["crop_iou"]}({r["crop_method"]}) rec={r["recall"]} desk={r["deskew"]}'
                 if r["is_document"] else f'words={r["n_words"]}')
        print(f'{flag} {r["file"]:<40} {r["decision"]:<8} acc={r["acceptance"]}({r["accept_score"]}) {extra} '
              f't={r["time"]}s {r["error"][:120]}')
    summ = summarize(rows)
    print(json.dumps(summ, ensure_ascii=False, indent=1))
    if a.out:
        json.dump({"summary": summ, "rows": rows}, open(a.out, "w"), ensure_ascii=False, indent=1)


if __name__ == "__main__":
    sys.exit(main())
