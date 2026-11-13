"""Line-direction estimator vs ground truth on the upright-axis of each document. Usage: python -m eval.check_linedir DIR"""
import json
import sys

import cv2

from soroka.pipeline import cv as C
from soroka.pipeline.runner import _normalized

d = sys.argv[1]
wrong = unsure = 0
for x in json.load(open(f"{d}/manifest.json")):
    if not x["is_document"]:
        continue
    img = _normalized(C.warp(cv2.imread(f"{d}/{x['file']}"), x["quad"]))
    r = C.line_direction(img)
    rr = r["ratio"] if x["rotated_cw"] in (0, 180) else 1 / r["ratio"]
    flag = "WRONG" if rr <= 1 / 1.6 else ("unsure" if rr < 1.6 else "")
    wrong += flag == "WRONG"
    unsure += flag == "unsure"
    print(f"{x['file']:<40} {rr:7.3f} n={r.get('n')} {flag}")
print("wrong", wrong, "unsure", unsure)
