"""Draw the MobileSAM page outline on images.

Usage: python -m eval.crop_preview OUT_DIR IMG_OR_DIR...

Each image is processed 4 times, rotated clockwise by 0, 90, 180 and 270 degrees. For each rotation writes
OUT_DIR/<name>_rot<angle>.jpg: the rotated image with the outline from pagemodel.page_outline() in green.
Also OUT_DIR/<name>_pipeline.jpg: the outline the pipeline uses (0, 90 and 270 degrees intersected) on the original image.
To test changes to the pipeline code without rebuilding, also mount it: -v "$PWD/backend/soroka:/app/soroka".
"""
import os
import sys

import cv2
import numpy as np

from soroka.pipeline import pagemodel as PM

EXTS = (".jpg", ".jpeg", ".png", ".webp", ".bmp", ".tif", ".tiff")


def _inputs(args):
    for a in args:
        if os.path.isdir(a):
            yield from sorted(os.path.join(a, f) for f in os.listdir(a) if f.lower().endswith(EXTS))
        else:
            yield a


def main():
    out = sys.argv[1]
    os.makedirs(out, exist_ok=True)
    for p in _inputs(sys.argv[2:]):
        img = cv2.imread(p)
        if img is None:
            print(p, ": cannot read")
            continue
        name = os.path.splitext(os.path.basename(p))[0]
        for angle, rot in ((0, None), (90, cv2.ROTATE_90_CLOCKWISE), (180, cv2.ROTATE_180),
                           (270, cv2.ROTATE_90_COUNTERCLOCKWISE)):
            im = img.copy() if rot is None else cv2.rotate(img, rot)
            polygon, info = PM.page_outline(im, rotations=(0,))
            if polygon:
                th = max(2, round(max(im.shape[:2]) / 300))
                cv2.polylines(im, [np.array(polygon, np.int32)], True, (0, 255, 0), th, cv2.LINE_AA)
            else:
                print(f"{name} rot{angle}: no outline", info)
            cv2.imwrite(os.path.join(out, f"{name}_rot{angle}.jpg"), im)
        # what the pipeline uses: 0, 90 and 270 degrees, intersected
        im = img.copy()
        polygon, info = PM.page_outline(im)
        if polygon:
            th = max(2, round(max(im.shape[:2]) / 300))
            cv2.polylines(im, [np.array(polygon, np.int32)], True, (0, 255, 0), th, cv2.LINE_AA)
        else:
            print(f"{name} pipeline: no outline", info)
        cv2.imwrite(os.path.join(out, f"{name}_pipeline.jpg"), im)


if __name__ == "__main__":
    main()
