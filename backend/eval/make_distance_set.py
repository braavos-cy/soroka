"""Synthetic photos of a document taken from different distances, with the page's true corners.

Distances:
  full    - the page fills the whole picture: its corners are the picture's corners
  close   - taken up close: the page fills 88-97 % of the frame, a thin strip of desk around it
  medium  - the page fills 60-80 % of the frame
  far     - the page fills 25-45 % of the frame
Photos other than `full` are taken at an angle (perspective) about 2 times in 3, slightly turned, on a random desk
(wood, dark, fabric, stone or light), with a soft shadow, uneven light, noise and blur. The page is upright.

manifest.json per image: file, distance, lang, kind, angled, quad (true page corners TL, TR, BR, BL in pixels).

Usage: python -m eval.make_distance_set OUT_DIR [--seed N] [--per N]
"""
import argparse
import json
import math
import os
import random

import cv2
import numpy as np

from eval.make_testset import jpeg, light_gradient, render_page, table_texture

DISTANCES = {"full": None, "close": (0.88, 0.97), "medium": (0.6, 0.8), "far": (0.25, 0.45)}


def shoot(page: np.ndarray, distance: str, rnd: random.Random) -> tuple[np.ndarray, np.ndarray, bool]:
    ph, pw = page.shape[:2]
    src = np.array([[0, 0], [pw - 1, 0], [pw - 1, ph - 1], [0, ph - 1]], np.float32)
    angled = False
    if distance == "full":  # the frame has the page's shape, the corners are the frame's corners
        H = 2400
        W = int(round(H * pw / ph))
        dst = np.array([[0, 0], [W - 1, 0], [W - 1, H - 1], [0, H - 1]], np.float32)
    else:
        H, W = 2400, 1800
        lo, hi = DISTANCES[distance]
        fill = rnd.uniform(lo, hi)
        s = min(W * fill / pw, H * fill / ph)
        cw, ch = pw * s, ph * s
        free_x, free_y = (W - cw) / 2, (H - ch) / 2
        cx, cy = W / 2 + rnd.uniform(-0.7, 0.7) * free_x, H / 2 + rnd.uniform(-0.7, 0.7) * free_y
        ang = math.radians(rnd.uniform(-5, 5))
        base = np.array([[-cw / 2, -ch / 2], [cw / 2, -ch / 2], [cw / 2, ch / 2], [-cw / 2, ch / 2]])
        rot = np.array([[math.cos(ang), -math.sin(ang)], [math.sin(ang), math.cos(ang)]])
        dst = base @ rot.T + [cx, cy]
        if rnd.random() < 0.67:  # camera tilted: the far side of the page shrinks
            angled = True
            side = rnd.choice([(0, 1), (3, 2), (0, 3), (1, 2)])
            k = rnd.uniform(0.08, 0.2)
            i, j = side
            mid = (dst[i] + dst[j]) / 2
            dst[i] += (mid - dst[i]) * k * 2
            dst[j] += (mid - dst[j]) * k * 2
            dst += np.array([[rnd.uniform(-20, 20), rnd.uniform(-20, 20)] for _ in range(4)])
        # keep the whole page inside the frame (a few pixels of margin)
        c = dst.mean(0)
        lim = min([1.0] + [(c[0] - 4) / max(1e-6, c[0] - x) for x in dst[:, 0] if x < 4]
                  + [(W - 5 - c[0]) / max(1e-6, x - c[0]) for x in dst[:, 0] if x > W - 5]
                  + [(c[1] - 4) / max(1e-6, c[1] - y) for y in dst[:, 1] if y < 4]
                  + [(H - 5 - c[1]) / max(1e-6, y - c[1]) for y in dst[:, 1] if y > H - 5])
        dst = ((dst - c) * lim + c).astype(np.float32)

    M = cv2.getPerspectiveTransform(src, dst)
    warped = cv2.warpPerspective(page, M, (W, H), flags=cv2.INTER_LINEAR)
    mask = cv2.warpPerspective(np.full((ph, pw), 255, np.uint8), M, (W, H), flags=cv2.INTER_LINEAR)
    bg = table_texture(H, W, rnd, rnd.choice(["wood", "dark", "fabric", "stone", "light"]))
    sh = cv2.GaussianBlur(mask, (0, 0), 25).astype(np.float32)[..., None] / 255
    off = np.roll(np.roll(sh, 18, 0), 12, 1)
    img = bg.astype(np.float32) * (1 - 0.45 * off)
    a = mask.astype(np.float32)[..., None] / 255
    img = img * (1 - a) + warped.astype(np.float32) * a
    img *= light_gradient(H, W, rnd, rnd.uniform(0.15, 0.45))
    img += np.random.default_rng(rnd.randint(0, 1 << 30)).normal(0, 4, img.shape)
    img *= np.array([rnd.uniform(0.92, 1.0), rnd.uniform(0.96, 1.0), rnd.uniform(0.97, 1.05)], np.float32)
    img = cv2.GaussianBlur(np.clip(img, 0, 255).astype(np.uint8), (0, 0), rnd.uniform(0.5, 1.1))
    return img, dst, angled


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("out")
    ap.add_argument("--seed", type=int, default=11)
    ap.add_argument("--per", type=int, default=2, help="images per distance, language and document kind")
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)
    rnd = random.Random(a.seed)
    manifest = []
    for distance in DISTANCES:
        for lang in ("en", "ru"):
            for kind in ("letter", "table", "receipt"):
                for n in range(a.per):
                    page, _ = render_page(kind, lang, rnd)
                    img, quad, angled = shoot(page, distance, rnd)
                    name = f"{distance}_{lang}_{kind}_{n}.jpg"
                    open(os.path.join(a.out, name), "wb").write(jpeg(img, 88))
                    manifest.append({"file": name, "distance": distance, "lang": lang, "kind": kind,
                                     "angled": angled, "quad": quad.round(1).tolist()})
    json.dump(manifest, open(os.path.join(a.out, "manifest.json"), "w"), indent=1)
    print(f"{len(manifest)} images -> {a.out}")


if __name__ == "__main__":
    main()
