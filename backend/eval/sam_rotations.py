"""MobileSAM page outline in all four orientations, scored against the true page corners.

Each image is rotated 0, 90, 180 and 270 degrees clockwise, page_outline() is run on it, and the outline is turned
back into the original picture. Every outline, and combinations of them (intersections, majority), is compared
with the true page (manifest quad):
  iou   - overlap / union with the true page
  leak  - area outside the true page, as a share of the page (the "blob on the side")
  miss  - share of the true page left out
  fail  - no outline at all (page_outline returned None; the reason is printed)
For a combination, rotations that returned no outline are left out; it fails only if all of them did.

Writes OUT_DIR/results.json and OUT_DIR/<name>.jpg: panels with each rotation's outline (red) and the true page
(blue), and the combinations (filled cyan).

Usage: python -m eval.sam_rotations SET_DIR OUT_DIR [NAME_FILTER]
"""
import json
import os
import sys
from collections import defaultdict

import cv2
import numpy as np

from soroka.pipeline import pagemodel as PM

ROTS = {0: None, 90: cv2.ROTATE_90_CLOCKWISE, 180: cv2.ROTATE_180, 270: cv2.ROTATE_90_COUNTERCLOCKWISE}
COMBOS = {"0&180": (0, 180), "90&270": (90, 270), "0&90": (0, 90), "all4&": (0, 90, 180, 270)}
MAJ = "3of4"
EVAL_SIDE = 1000  # masks are compared at this size


def unrotate(poly: np.ndarray, rot: int, w: int, h: int) -> np.ndarray:
    """Points of the picture rotated `rot` degrees clockwise -> points of the original (w x h) picture."""
    x, y = poly[:, 0], poly[:, 1]
    if rot == 90:
        return np.stack([y, h - 1 - x], 1)
    if rot == 180:
        return np.stack([w - 1 - x, h - 1 - y], 1)
    if rot == 270:
        return np.stack([w - 1 - y, x], 1)
    return poly


def fill(poly: np.ndarray, shape, s: float) -> np.ndarray:
    m = np.zeros(shape, np.uint8)
    cv2.fillPoly(m, [np.round(poly * s).astype(np.int32)], 1)
    return m.astype(bool)


def score(pred: np.ndarray | None, gt: np.ndarray) -> dict:
    if pred is None:
        return {"iou": 0.0, "leak": 0.0, "miss": 1.0, "fail": True}
    g = gt.sum()
    return {"iou": round(float((pred & gt).sum() / max(1, (pred | gt).sum())), 4),
            "leak": round(float((pred & ~gt).sum() / g), 4), "miss": round(float((gt & ~pred).sum() / g), 4),
            "fail": False}


def combine(masks: list) -> np.ndarray | None:
    ok = [m for m in masks if m is not None]
    return np.logical_and.reduce(ok) if ok else None


def main():
    set_dir, out = sys.argv[1], sys.argv[2]
    flt = sys.argv[3] if len(sys.argv) > 3 else ""
    os.makedirs(out, exist_ok=True)
    man = [x for x in json.load(open(os.path.join(set_dir, "manifest.json"))) if flt in x["file"]]
    results = []
    for item in man:
        img = cv2.imread(os.path.join(set_dir, item["file"]))
        h, w = img.shape[:2]
        s = EVAL_SIDE / max(h, w)
        shape = (round(h * s), round(w * s))
        gt_quad = np.array(item["quad"], np.float32)
        gt = fill(gt_quad, shape, s)
        polys, masks, reasons = {}, {}, {}
        for rot, code in ROTS.items():
            im = img if code is None else cv2.rotate(img, code)
            poly, info = PM.page_outline(im, rotations=(0,))
            if poly:
                polys[rot] = unrotate(np.array(poly, np.float32), rot, w, h)
                masks[rot] = fill(polys[rot], shape, s)
            else:
                masks[rot] = None
                reasons[rot] = info.get("reason")
        sc = {str(r): score(masks[r], gt) for r in ROTS}
        combo_masks = {k: combine([masks[r] for r in rs]) for k, rs in COMBOS.items()}
        ok = [m for m in masks.values() if m is not None]
        combo_masks[MAJ] = (np.sum(ok, 0) >= min(3, len(ok))) if ok else None
        for k, m in combo_masks.items():
            sc[k] = score(m, gt)
        results.append({**{k: item[k] for k in ("file", "distance", "kind", "angled")}, "scores": sc,
                        "fail_reasons": {str(k): v for k, v in reasons.items()}})
        line = "  ".join(f"{k}:{'FAIL' if v['fail'] else format(v['iou'], '.3f')}" for k, v in sc.items())
        print(f"{item['file']:<26} {line}" + (f"   fails: {reasons}" if reasons else ""), flush=True)

        # panels: each rotation's outline (red) over the true page (blue), then the combinations (cyan fill)
        small = cv2.resize(img, (shape[1], shape[0]), interpolation=cv2.INTER_AREA)
        th = max(2, shape[0] // 250)
        panels = []
        for rot in ROTS:
            p = small.copy()
            cv2.polylines(p, [np.round(gt_quad * s).astype(np.int32)], True, (255, 0, 0), th, cv2.LINE_AA)
            if rot in polys:
                cv2.polylines(p, [np.round(polys[rot] * s).astype(np.int32)], True, (0, 0, 255), th, cv2.LINE_AA)
            panels.append(_label(p, f"rot{rot}", sc[str(rot)]))
        for k in list(COMBOS)[:2] + [MAJ]:
            p = small.copy()
            if combo_masks[k] is not None:
                p[combo_masks[k]] = (0.55 * p[combo_masks[k]] + 0.45 * np.array([255, 255, 0])).astype(np.uint8)
            cv2.polylines(p, [np.round(gt_quad * s).astype(np.int32)], True, (255, 0, 0), th, cv2.LINE_AA)
            panels.append(_label(p, k, sc[k]))
        panels.append(np.full_like(panels[0], 255))
        grid = np.vstack([np.hstack(panels[:4]), np.hstack(panels[4:])])
        grid = cv2.resize(grid, None, fx=0.5, fy=0.5, interpolation=cv2.INTER_AREA)
        cv2.imwrite(os.path.join(out, os.path.splitext(item["file"])[0] + ".jpg"), grid, [cv2.IMWRITE_JPEG_QUALITY, 85])

    json.dump(results, open(os.path.join(out, "results.json"), "w"), indent=1, ensure_ascii=False)
    _summary(results)


def _label(p: np.ndarray, title: str, s: dict) -> np.ndarray:
    txt = f"{title} FAIL" if s["fail"] else f"{title} iou {s['iou']:.3f} leak {s['leak']:.3f} miss {s['miss']:.3f}"
    sz = p.shape[0] / 900
    cv2.putText(p, txt, (10, int(40 * sz)), cv2.FONT_HERSHEY_SIMPLEX, sz, (0, 0, 0), max(4, int(6 * sz)), cv2.LINE_AA)
    cv2.putText(p, txt, (10, int(40 * sz)), cv2.FONT_HERSHEY_SIMPLEX, sz, (255, 255, 255), max(1, int(2 * sz)),
                cv2.LINE_AA)
    return p


def _summary(results: list) -> None:
    keys = list(results[0]["scores"])
    groups = defaultdict(list)
    for r in results:
        groups[r["distance"]].append(r)
        groups["ALL"].append(r)
    for metric, label in (("iou", "mean IoU (fail = 0)"), ("good", "IoU >= 0.95"), ("leak", "leak > 2%"),
                          ("fail", "no outline")):
        print(f"\n{label}")
        print(f"{'':<8}{'n':>4}" + "".join(f"{k:>9}" for k in keys))
        for g, rs in groups.items():
            row = []
            for k in keys:
                v = [r["scores"][k] for r in rs]
                if metric == "iou":
                    row.append(f"{np.mean([x['iou'] for x in v]):.3f}")
                elif metric == "good":
                    row.append(f"{sum(x['iou'] >= 0.95 for x in v)}")
                elif metric == "leak":
                    row.append(f"{sum(x['leak'] > 0.02 for x in v)}")
                else:
                    row.append(f"{sum(x['fail'] for x in v)}")
            print(f"{g:<8}{len(rs):>4}" + "".join(f"{x:>9}" for x in row))


if __name__ == "__main__":
    main()
