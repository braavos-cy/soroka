"""Check C.refine_quad against ground truth: (a) an exact crop must not be cut deeper, (b) a loose crop
(corners pushed outward 1-5% of the page) should be trimmed back towards the true edges.
Usage: python -m eval.check_refine DATA_DIR [DATA_DIR ...]"""
import json
import os
import sys

import cv2
import numpy as np

from soroka.pipeline import cv as C


def loosen(q: np.ndarray, rng, lo=0.01, hi=0.05) -> np.ndarray:
    c = q.mean(0)
    diag = np.linalg.norm(q[2] - q[0])
    out = []
    for p in q:
        d = (p - c) / np.linalg.norm(p - c)
        out.append(p + d * diag * rng.uniform(lo, hi) + rng.normal(0, diag * 0.005, 2))
    return np.array(out, np.float32)


def main():
    rng = np.random.default_rng(3)
    rows = []
    for data in sys.argv[1:]:
        for it in json.load(open(os.path.join(data, "manifest.json"))):
            if not it["is_document"]:
                continue
            img = cv2.imread(os.path.join(data, it["file"]))
            H, W = img.shape[:2]
            gt = np.array(it["quad"], np.float32)
            exact, _ = C.refine_quad(img, gt.tolist())
            loose = loosen(gt, rng)
            loose[:, 0] = loose[:, 0].clip(0, W - 1)
            loose[:, 1] = loose[:, 1].clip(0, H - 1)
            fixed, info = C.refine_quad(img, loose.tolist())
            r = {"file": it["file"], "exact": C.quad_iou(np.array(exact, np.float32), gt),
                 "loose": C.quad_iou(loose, gt), "fixed": C.quad_iou(np.array(fixed, np.float32), gt)}
            rows.append(r)
            print(f'{it["file"]:<42} exact->{r["exact"]:.3f}  loose {r["loose"]:.3f} -> {r["fixed"]:.3f}')
    ex = np.array([r["exact"] for r in rows]); lo = np.array([r["loose"] for r in rows])
    fx = np.array([r["fixed"] for r in rows])
    print(f"n={len(rows)} exact: mean {ex.mean():.3f} min {ex.min():.3f} (<0.97: {(ex < 0.97).sum()})")
    print(f"loose: mean {lo.mean():.3f} -> {fx.mean():.3f}; improved {(fx > lo + 0.005).sum()}, "
          f"worse {(fx < lo - 0.005).sum()}; >=0.95 before {(lo >= 0.95).sum()} after {(fx >= 0.95).sum()}")


if __name__ == "__main__":
    main()
