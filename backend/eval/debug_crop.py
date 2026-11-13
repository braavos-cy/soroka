"""Print boundary candidates for images and save an overlay. Usage: python -m eval.debug_crop OUT_DIR IMG..."""
import json
import os
import sys

import cv2
import numpy as np

from soroka.pipeline import cv as C

out = sys.argv[1]
man = {}
mp = os.path.join(os.path.dirname(sys.argv[2]), "manifest.json")
if os.path.exists(mp):
    man = {x["file"]: x for x in json.load(open(mp))}
for p in sys.argv[2:]:
    img = cv2.imread(p)
    cands, chosen, tier, sig = C.detect_boundary(img)
    gt = man.get(os.path.basename(p), {}).get("quad")
    print(os.path.basename(p), "chosen", chosen.method, tier, sig)
    vis = img.copy()
    for c in sorted(cands, key=lambda c: -c.score):
        iou = C.quad_iou(np.array(c.value["quad"], np.float32), np.array(gt, np.float32)) if gt else -1
        print(f"   {c.method:<18} {c.score:.3f} iou={iou:.3f}",
              {k: v for k, v in c.signals.items() if k in ("edge_sides", "contrast", "sharpness", "area", "agree_with")})
        col = (0, 0, 255) if c is chosen else (255, 0, 0)
        cv2.polylines(vis, [np.array(c.value["quad"], np.int32)], True, col, 6 if c is chosen else 2)
    if gt:
        cv2.polylines(vis, [np.array(gt, np.int32)], True, (0, 200, 0), 3)
    small, _ = C.downscale(vis, 700)
    cv2.imwrite(os.path.join(out, "crop_" + os.path.basename(p)), small)
