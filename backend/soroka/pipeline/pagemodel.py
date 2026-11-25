"""Page mask (MobileSAM) and flattening + shading correction (SyntheticDoc), run with onnxruntime.

Photos of pages (in particular bound / curved ones): MobileSAM, prompted with points on the page's text block,
returns the page as a mask; the mask is cleaned (largest region, holes filled, spurs removed, edge smoothed) and
kept as an editable outline (polygon). The page image is the photo with everything outside the outline set to
black, cropped to the outline's bounding box; SyntheticDoc then flattens it (backward map, low or high resolution)
and can divide out the page's shading (a lighting map: it only brightens / evens existing pixels).

Models are exported to ONNX at image build time (backend/models/export_models.py) into MODELS_DIR.
"""
import functools
import os

import cv2
import numpy as np

from ..config import settings
from . import cv as C

MODELS_DIR = os.environ.get("MODELS_DIR", "/models")
SAM_SIZE = 1024
SAM_MEAN = np.array([123.675, 116.28, 103.53], np.float32)
SAM_STD = np.array([58.395, 57.12, 57.375], np.float32)
# SyntheticDoc models: file, input width, input height (backward map 31 x 45 / 121 x 177)
FLATTEN = {"low": ("flatten_low.onnx", 512, 720), "high": ("flatten_high.onnx", 1024, 1440)}
MODEL_FILES = ("sam_encoder.onnx", "sam_decoder.onnx", FLATTEN["low"][0], FLATTEN["high"][0])


def available() -> bool:
    return all(os.path.exists(os.path.join(MODELS_DIR, f)) for f in MODEL_FILES)


@functools.lru_cache(maxsize=None)
def _session(name: str):
    import onnxruntime as ort
    o = ort.SessionOptions()
    o.intra_op_num_threads = max(1, settings().tesseract_threads)  # one worker per core: stay single-threaded
    o.inter_op_num_threads = 1
    return ort.InferenceSession(os.path.join(MODELS_DIR, name), o, providers=["CPUExecutionProvider"])


# ---------------------------------------------------------------- text block (where to point MobileSAM)
def _ink(small: np.ndarray, lab: np.ndarray) -> np.ndarray:
    ink = ((lab[..., 0] - cv2.cvtColor(small, cv2.COLOR_BGR2LAB)[..., 0].astype(np.float32)) > 40).astype(np.uint8)
    n, lbl, st, _ = cv2.connectedComponentsWithStats(ink, 8)
    keep = np.zeros(n, bool)
    keep[1:] = (st[1:, cv2.CC_STAT_HEIGHT] < 40) & (st[1:, cv2.CC_STAT_WIDTH] < 120) & (st[1:, cv2.CC_STAT_AREA] >= 3)
    return keep[lbl].astype(np.uint8)


def text_block(small: np.ndarray, lab: np.ndarray) -> np.ndarray | None:
    """Convex hull of the page's main text block (plus headings / signature blocks above or below it)."""
    ink = _ink(small, lab)
    k = max(9, small.shape[1] // 40)
    m = cv2.morphologyEx(ink, cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_RECT, (k, k // 2)))
    m = cv2.morphologyEx(m, cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_RECT, (k // 2, k)))
    n, lbl, st, _ = cv2.connectedComponentsWithStats(m, 8)
    if n < 2:
        return None
    areas = st[1:, cv2.CC_STAT_AREA]
    big = 1 + int(np.argmax(areas))
    if areas.max() < 0.02 * m.size:
        return None  # no real text block
    bx, by, bw, bh = st[big, :4]
    sel = [big]
    for i in range(1, n):
        if i == big or st[i, cv2.CC_STAT_AREA] < 0.03 * areas.max():
            continue
        x, y, w, h = st[i, :4]
        overlap = min(x + w, bx + bw) - max(x, bx)
        gapy = max(0, max(by - (y + h), y - (by + bh)))
        if overlap > 0.3 * min(w, bw) and gapy < 0.25 * bh:
            sel.append(i)
    pts = cv2.findNonZero(np.isin(lbl, sel).astype(np.uint8))
    return cv2.convexHull(pts).reshape(-1, 2).astype(np.float32)


# ---------------------------------------------------------------- MobileSAM
def _sam_masks(small: np.ndarray, points: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """3 candidate masks (bool, small's size) and their predicted quality for positive `points` (x, y in small)."""
    h, w = small.shape[:2]
    s = SAM_SIZE / max(h, w)
    nh, nw = int(h * s + 0.5), int(w * s + 0.5)
    rgb = cv2.cvtColor(cv2.resize(small, (nw, nh), interpolation=cv2.INTER_LINEAR), cv2.COLOR_BGR2RGB).astype(np.float32)
    x = np.zeros((SAM_SIZE, SAM_SIZE, 3), np.float32)
    x[:nh, :nw] = (rgb - SAM_MEAN) / SAM_STD
    emb = _session("sam_encoder.onnx").run(None, {"image": x.transpose(2, 0, 1)[None]})[0]
    coords = (points * s).astype(np.float32)[None]
    low, iou = _session("sam_decoder.onnx").run(None, {"embeddings": emb, "coords": coords,
                                                      "labels": np.ones((1, len(points)), np.float32)})
    masks = []
    for m in low[0]:
        up = cv2.resize(m, (SAM_SIZE, SAM_SIZE), interpolation=cv2.INTER_LINEAR)[:nh, :nw]
        masks.append(cv2.resize(up, (w, h), interpolation=cv2.INTER_LINEAR) > 0)
    return np.array(masks), iou[0]


def _clean(m: np.ndarray) -> np.ndarray:
    """Largest region, every hole filled, thin spurs removed, edge smoothed."""
    m = m.astype(np.uint8)
    n, lbl, st, _ = cv2.connectedComponentsWithStats(m, 8)
    if n < 2:
        return m
    m = (lbl == 1 + int(np.argmax(st[1:, cv2.CC_STAT_AREA]))).astype(np.uint8)
    cnts, _ = cv2.findContours(m, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
    m = np.zeros_like(m)
    cv2.drawContours(m, cnts, -1, 1, -1)
    k = max(5, m.shape[1] // 120) | 1
    m = cv2.morphologyEx(m, cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (k, k)))
    m = (cv2.GaussianBlur(m.astype(np.float32), (k * 2 + 1, k * 2 + 1), 0) > 0.5).astype(np.uint8)
    n, lbl, st, _ = cv2.connectedComponentsWithStats(m, 8)
    return (lbl == 1 + int(np.argmax(st[1:, cv2.CC_STAT_AREA]))).astype(np.uint8) if n >= 2 else m


def _drop_colour(m: np.ndarray, small: np.ndarray) -> np.ndarray:
    """Remove parts of the mask that are clearly not paper: a strongly coloured object the mask spilled onto
    (paper and its shadows are nearly colourless relative to the page's own paper tone). Text is removed first."""
    lab = C._paper_view(small)
    inside = m.astype(bool)
    if inside.sum() < 100:
        return m
    L = lab[..., 0]
    paper = inside & (L >= np.percentile(L[inside], 60))
    ref = np.median(lab[paper][:, 1:], axis=0)
    chroma = np.linalg.norm(lab[..., 1:] - ref, axis=2)
    out = inside & ~(chroma > 22)
    return out if out.sum() > 0.5 * inside.sum() else inside


def mask_corners(polygon: np.ndarray) -> np.ndarray:
    """The 4 page corners of an outline: its points closest to the corners of its minimum-area rectangle."""
    rect = C.order_quad(cv2.boxPoints(cv2.minAreaRect(polygon.astype(np.float32))).astype(np.float32))
    return np.array([polygon[int(np.argmin(np.linalg.norm(polygon - r, axis=1)))] for r in rect], np.float32)


ROTATE = {90: (cv2.ROTATE_90_CLOCKWISE, cv2.ROTATE_90_COUNTERCLOCKWISE), 180: (cv2.ROTATE_180, cv2.ROTATE_180),
          270: (cv2.ROTATE_90_COUNTERCLOCKWISE, cv2.ROTATE_90_CLOCKWISE)}


AGREE_IOU = 0.95  # upright and turned right agree: no tie-breaker needed
SUPPORT_IOU = 0.9  # a mask backs the voted outline when it overlaps it this much


def _iou(a: np.ndarray, b: np.ndarray) -> float:
    return float((a & b).sum() / max(1, (a | b).sum()))


def page_outline(img: np.ndarray, rotations: tuple | None = None) -> tuple[list | None, dict]:
    """Editable page outline (polygon in original pixels) found by MobileSAM from the page's text block, or None
    with the reason (no text block, no agreement, outline covering almost the whole picture, models missing).

    MobileSAM is not rotation-invariant: the same photo turned 90 degrees can be outlined differently (upright it
    sometimes spills from the page's side into the background, a peninsula, or leaves a hole in it, an island). It is
    run on the picture upright and turned right; when the two masks agree, that is the page (2 runs). Otherwise it
    also runs turned left and upside down, and the page is where at least 3 of the 4 masks agree (2 of 3 when one
    turn found no text to start from). With no clear majority (most masks far from the voted outline) there is no
    outline and the regular 4-corner crop stays. Each run hands in its best mask, also one covering nearly the whole
    picture, so the vote sees what every orientation saw. `rotations`: run exactly these (evaluation scripts)."""
    if not available():
        return None, {"reason": "models_missing"}
    small, s = C.downscale(img, 1000)
    found, per_rot = {}, {}

    def run(rot: int) -> None:
        im = small if rot == 0 else cv2.rotate(small, ROTATE[rot][0])
        m, info = _outline_mask(im)
        per_rot[str(rot)] = info
        if m is not None:
            found[rot] = (m if rot == 0 else cv2.rotate(m, ROTATE[rot][1])).astype(bool)

    if rotations is not None:
        for rot in rotations:
            run(rot)
        agreed = False
    else:
        run(0)
        run(90)
        agreed = 0 in found and 90 in found and _iou(found[0], found[90]) >= AGREE_IOU
        if not agreed:
            run(270)
            run(180)
    masks = list(found.values())
    info = {"rotations": per_rot, "runs": len(per_rot), "agreed": agreed}
    if not masks:
        return None, {"reason": per_rot[str(next(iter(per_rot)))]["reason"], **info}
    if len(masks) == 1:  # the other turns found no text to start from: nothing against this one
        m = masks[0].astype(np.uint8)
    else:
        need = 3 if len(masks) >= 4 else 2
        m = _clean(np.sum(masks, axis=0) >= need)
        support = sum(_iou(x, m.astype(bool)) >= SUPPORT_IOU for x in masks)
        info["support"] = f"{support}/{len(masks)}"
        if support < need:  # the masks split (e.g. 2 against 2): none of them is trusted
            return None, {"reason": "no_agreement", **info}
    area = float(m.mean())
    # nearly the whole picture: the page fills the frame, the regular crop already has it
    if not 0.12 <= area <= 0.95:
        return None, {"reason": "mask_area", "area": round(area, 3), **info}
    cnts, _ = cv2.findContours(m, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
    c = max(cnts, key=cv2.contourArea)
    poly = cv2.approxPolyDP(c, 0.0025 * cv2.arcLength(c, True), True).reshape(-1, 2).astype(np.float32) / s
    scores = [v["score"] for v in per_rot.values() if "score" in v]
    return [[round(float(x), 1), round(float(y), 1)] for x, y in poly], {
        "area": round(area, 3), "points": len(poly), "score": max(scores), "used": len(masks), **info}


def _outline_mask(small: np.ndarray) -> tuple[np.ndarray | None, dict]:
    """The page mask (uint8, small's size) MobileSAM finds from the text block in this orientation, or None when there
    is no text to start from or no mask holds most of it. The largest mask that holds the text block is taken, also
    one covering nearly the whole picture: whether that is the page or the whole photo is for the vote to decide."""
    hull = text_block(small, C._paper_view(small))
    if hull is None:
        return None, {"reason": "no_text_block"}
    (x0, y0), (x1, y1) = hull.min(0), hull.max(0)
    pts = np.array([hull.mean(0)] + [[x0 + (x1 - x0) * a, y0 + (y1 - y0) * b] for a in (.25, .75) for b in (.25, .75)],
                   np.float32)
    masks, scores = _sam_masks(small, pts)
    tb = np.zeros(small.shape[:2], np.uint8)
    cv2.fillPoly(tb, [hull.astype(np.int32)], 1)
    best = None
    covers = [float((m & tb.astype(bool)).sum() / max(1, tb.sum())) for m in masks]
    for m, cover in zip(masks, covers):  # the largest candidate that contains the text block
        if cover > 0.95 and (best is None or m.sum() > best.sum()):
            best = m
    if best is None:  # else MobileSAM's own best guess, if it still holds most of the text
        i = int(np.argmax(scores))
        if covers[i] >= 0.8:
            best = masks[i]
    if best is None:
        return None, {"reason": "no_plausible_mask", "scores": [round(float(v), 3) for v in scores]}
    m = _clean(_drop_colour(best, small))
    area = float(m.mean())
    if area < 0.12:
        return None, {"reason": "mask_area", "area": round(area, 3)}
    return m, {"area": round(area, 3), "score": round(float(scores.max()), 3)}


BEND_CURVED = 0.018  # flat test photos bend <= 0.016 of the diagonal, photographed book pages 0.02-0.12


def outline_bend(polygon: list) -> float:
    """How far the outline bends away from the straight lines between its 4 corners (share of the diagonal)."""
    p = np.array(polygon, np.float32)
    q = mask_corners(p)
    diag = float(np.linalg.norm(q[2] - q[0])) + 1e-9
    worst = 0.0
    for x in p:
        d = min(abs(float((q[(i + 1) % 4] - q[i])[0] * (x - q[i])[1] - (q[(i + 1) % 4] - q[i])[1] * (x - q[i])[0]))
                / (float(np.linalg.norm(q[(i + 1) % 4] - q[i])) + 1e-9) for i in range(4))
        worst = max(worst, d)
    return worst / diag


def masked_crop(img: np.ndarray, polygon: list, pad: float = 0.02) -> np.ndarray:
    """The photo with everything outside the outline set to black, cropped to the outline's box (+ pad).
    Notches in the outline (a finger over the page edge) are filled with the paper colour instead of black."""
    H, W = img.shape[:2]
    poly = np.array(polygon, np.float32)
    p = int(pad * max(H, W))
    x0, y0 = np.floor(poly.min(0)).astype(int) - p
    x1, y1 = np.ceil(poly.max(0)).astype(int) + p
    x0, y0, x1, y1 = max(0, x0), max(0, y0), min(W, x1), min(H, y1)
    crop = img[y0:y1, x0:x1]
    pts = (poly - [x0, y0]).round().astype(np.int32)
    m = np.zeros(crop.shape[:2], np.uint8)
    cv2.fillPoly(m, [pts], 1)
    hull = np.zeros_like(m)
    cv2.fillPoly(hull, [cv2.convexHull(pts)], 1)
    out = crop * m[..., None]
    notch = (hull > 0) & (m == 0)
    if notch.any() and m.any():
        g = cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY)
        inside = m > 0
        paper = np.median(crop[inside & (g >= np.percentile(g[inside], 60))], axis=0)
        out[notch] = paper
    return out


# ---------------------------------------------------------------- SyntheticDoc
def _linear_weights(n_in: int, n_out: int) -> np.ndarray:
    """n_out x n_in linear interpolation matrix, ends on ends (align_corners=True)."""
    t = np.linspace(0, n_in - 1, n_out)
    i = np.clip(np.floor(t).astype(int), 0, max(0, n_in - 2))
    f = (t - i).astype(np.float32)
    W = np.zeros((n_out, n_in), np.float32)
    W[np.arange(n_out), i] = 1 - f
    if n_in > 1:
        W[np.arange(n_out), i + 1] += f
    return W


def _upsample(a: np.ndarray, w: int, h: int) -> np.ndarray:
    """Bilinear resize with align_corners=True (as grid_sample's torch code), exact (cv2.remap would quantize the
    sample positions to 1/32 of a cell: visible wobble when a coarse map is stretched over a large page)."""
    gh, gw = a.shape
    return _linear_weights(gh, h) @ a.astype(np.float32) @ _linear_weights(gw, w).T


def _predict(img: np.ndarray, model: str) -> tuple[np.ndarray, np.ndarray]:
    """SyntheticDoc on a page image: backward map (gh x gw x 2, source positions in [-1, 1]) and shading map
    (BGR in 0..1, at the model's input size)."""
    from PIL import Image  # same downscale as the model was trained / evaluated with (PIL bilinear, antialiased)
    name, mw, mh = FLATTEN[model]
    rgb = cv2.cvtColor(img, cv2.COLOR_BGR2RGB)
    x = (np.asarray(Image.fromarray(rgb).resize((mw, mh), Image.BILINEAR), np.float32) / 255 - 0.5) / 0.5
    grid, shade = _session(name).run(None, {"image": np.ascontiguousarray(x.transpose(2, 0, 1)[None])})
    return grid[0].transpose(1, 2, 0), (shade[0].transpose(1, 2, 0) * 0.5 + 0.5)[..., ::-1]


def remove_shading(img: np.ndarray, shading: np.ndarray) -> np.ndarray:
    """Divide the page's lighting out (SyntheticDoc's own rule: weaker on already bright photos, so a bright page
    is not washed out)."""
    h, w = img.shape[:2]
    s = cv2.resize(np.ascontiguousarray(shading), (w, h), interpolation=cv2.INTER_LINEAR)
    x = img.astype(np.float32) / 255
    k = min(1.0, 0.4 / max(float(x.mean()), 1e-6))
    s = s * k + (1 - k)
    return (np.clip(x / np.maximum(s, 0.1), 0, 1) * 255 + 0.5).astype(np.uint8)


def _remap(img: np.ndarray, grid: np.ndarray) -> np.ndarray:
    """Apply a backward map (gh x gw x 2 in [-1, 1]); output keeps the input size."""
    h, w = img.shape[:2]
    gx, gy = _upsample(grid[..., 0], w, h), _upsample(grid[..., 1], w, h)
    return cv2.remap(img, (gx + 1) / 2 * (w - 1), (gy + 1) / 2 * (h - 1), cv2.INTER_LINEAR,
                     borderMode=cv2.BORDER_CONSTANT, borderValue=(0, 0, 0))


def _sample(a: np.ndarray, rows: int, cols: int, interp=cv2.INTER_LINEAR) -> np.ndarray:
    """Resample a grid (h x w x 2) to rows x cols, corners kept on corners (align_corners=True)."""
    gh, gw = a.shape[:2]
    mx, my = np.meshgrid(np.linspace(0, gw - 1, cols, dtype=np.float32), np.linspace(0, gh - 1, rows, dtype=np.float32))
    return np.dstack([cv2.remap(np.ascontiguousarray(a[..., i]).astype(np.float32), mx, my, interp,
                                borderMode=cv2.BORDER_REPLICATE) for i in range(2)])


MESH_ROWS, MESH_COLS = 11, 8  # editable control points; the full mesh is interpolated between them


def _control_mesh(grid: np.ndarray, rows: int = MESH_ROWS, cols: int = MESH_COLS) -> list:
    """rows x cols control points, each the position in the page image (0..1 of its width / height) that maps to
    that point of the flat output."""
    g = _sample(grid, rows, cols)
    return [[[round(float((x + 1) / 2), 5), round(float((y + 1) / 2), 5)] for x, y in r] for r in g]


def _spline_weights(n_in: int, n_out: int) -> np.ndarray:
    """n_out x n_in Catmull-Rom interpolation matrix, ends on ends (a smooth curve through the control points)."""
    t = np.linspace(0, n_in - 1, n_out)
    i = np.clip(np.floor(t).astype(int), 0, n_in - 2)
    f = (t - i)[:, None]
    wts = np.hstack([(-f + 2 * f ** 2 - f ** 3) / 2, (2 - 5 * f ** 2 + 3 * f ** 3) / 2,
                     (f + 4 * f ** 2 - 3 * f ** 3) / 2, (-f ** 2 + f ** 3) / 2])
    W = np.zeros((n_out, n_in), np.float32)
    for k in range(4):
        np.add.at(W, (np.arange(n_out), np.clip(i - 1 + k, 0, n_in - 1)), wts[:, k])
    return W


def apply_mesh(img: np.ndarray, mesh: list) -> np.ndarray:
    """Flatten with a control mesh (see _control_mesh); output keeps the input size."""
    h, w = img.shape[:2]
    m = np.array(mesh, np.float32)  # rows x cols x 2 in 0..1
    wy, wx = _spline_weights(m.shape[0], h), _spline_weights(m.shape[1], w)
    full = np.dstack([wy @ m[..., c] @ wx.T for c in range(2)])
    return cv2.remap(img, full[..., 0] * (w - 1), full[..., 1] * (h - 1), cv2.INTER_LINEAR,
                     borderMode=cv2.BORDER_CONSTANT, borderValue=(0, 0, 0))


def flatten_page(img: np.ndarray, model: str | None, shading: bool, mesh: list | None = None) -> tuple[np.ndarray, list | None]:
    """The flat page and the model's proposed control mesh (for the editor).
    model: None (no flattening) | "low" | "high"; shading: divide out the lighting; mesh: a hand-edited control mesh,
    used instead of the model's map (the model still provides the shading)."""
    model = model if model in FLATTEN else None
    if not (model or shading) or not available():
        return (apply_mesh(img, mesh) if mesh else img), None
    grid, shade = _predict(img, model or "high")
    src = remove_shading(img, shade) if shading else img
    if mesh:
        out = apply_mesh(src, mesh)
    elif model:
        out = _remap(src, grid)
    else:
        out = src
    return out, (_control_mesh(grid) if model else None)
