"""A/B of OCR input variants on ground-truth-cropped, upright pages. Usage: python -m eval.ab_cleanup DIR [substr]"""
import json
import os
import sys
import tempfile

import cv2
import numpy as np

from eval.run_eval import word_recall
from soroka.pipeline import cv as C
from soroka.pipeline import ocr as O


def stretch_soft(g):
    lo, hi = np.percentile(g, 0.2), np.percentile(g, 99.5)
    if hi - lo > 30:
        g = np.clip((g.astype(np.float32) - lo) * 255.0 / (hi - lo), 0, 255).astype(np.uint8)
    return g


VARIANTS = {
    "current": lambda img: C.cleanup(img, "gray", 1.0),
    "whiten_only": lambda img: C.gray(C.whiten(img)),
    "whiten_soft": lambda img: stretch_soft(C.gray(C.whiten(img))),
    "raw_gray": lambda img: C.gray(img),
}
d = sys.argv[1]
sub = sys.argv[2] if len(sys.argv) > 2 else "doc_"
tot = {k: [] for k in VARIANTS}
for x in json.load(open(f"{d}/manifest.json")):
    if not x["is_document"] or sub not in x["file"]:
        continue
    img = C.rotate90(C.warp(cv2.imread(f"{d}/{x['file']}"), x["quad"]), x["fix_rotation"])
    row = []
    for k, fn in VARIANTS.items():
        with tempfile.TemporaryDirectory() as t:
            p = os.path.join(t, "p.png")
            cv2.imwrite(p, fn(img))
            dpi = int(max(150, min(600, img.shape[1] / 8.27)))
            r = O.ocr(p, "rus+eng", dpi, want_pdf=False)
        rc = word_recall(x["words"], O.words_to_text(r["words"]))
        tot[k].append(rc)
        row.append(f"{k}={rc:.2f}")
    print(x["file"], " ".join(row), flush=True)
print({k: round(float(np.mean(v)), 3) for k, v in tot.items()})
