"""Classic computer-vision stages. Each estimator returns candidates (method, value, score, signals)."""
import math
from dataclasses import dataclass, field

import cv2
import numpy as np


@dataclass
class Candidate:
    method: str
    value: dict
    score: float
    signals: dict = field(default_factory=dict)


def downscale(img: np.ndarray, max_side: int) -> tuple[np.ndarray, float]:
    h, w = img.shape[:2]
    s = min(1.0, max_side / max(h, w))
    if s < 1.0:
        img = cv2.resize(img, (int(w * s), int(h * s)), interpolation=cv2.INTER_AREA)
    return img, s


def gray(img: np.ndarray) -> np.ndarray:
    return img if img.ndim == 2 else cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)


# ---------------------------------------------------------------- 1. quality
def quality(img: np.ndarray) -> dict:
    small, _ = downscale(img, 1200)
    g = gray(small)
    blur = float(cv2.Laplacian(g, cv2.CV_64F).var())
    mean = float(g.mean())
    glare = float((g > 250).mean())
    dark = float((g < 30).mean())
    h, w = img.shape[:2]
    flags = []
    if blur < 60:
        flags.append("blurry")
    if mean < 70 or dark > 0.4:
        flags.append("dark")
    if glare > 0.08:
        flags.append("glare")
    if min(h, w) < 900:
        flags.append("low_resolution")
    tier = "high" if not flags else ("medium" if len(flags) == 1 else "low")
    return {"blur": round(blur, 1), "brightness": round(mean, 1), "glare": round(glare, 4), "dark": round(dark, 4),
            "width": w, "height": h, "flags": flags, "tier": tier}


# ---------------------------------------------------------------- 3. page boundary
def order_quad(pts: np.ndarray) -> np.ndarray:
    pts = np.asarray(pts, dtype=np.float32).reshape(4, 2)
    s, d = pts.sum(1), np.diff(pts, axis=1).ravel()
    return np.array([pts[np.argmin(s)], pts[np.argmin(d)], pts[np.argmax(s)], pts[np.argmax(d)]], dtype=np.float32)


def _convex(q: np.ndarray) -> bool:
    return bool(cv2.isContourConvex(q.astype(np.float32).reshape(-1, 1, 2)))


def quad_iou(a: np.ndarray, b: np.ndarray) -> float:
    a, b = order_quad(a), order_quad(b)
    if not (_convex(a) and _convex(b)):  # intersectConvexConvex returns garbage for non-convex input: rasterize
        x0, y0 = np.minimum(a.min(0), b.min(0))
        x1, y1 = np.maximum(a.max(0), b.max(0))
        s = 400.0 / max(1.0, x1 - x0, y1 - y0)
        sz = (int((y1 - y0) * s) + 2, int((x1 - x0) * s) + 2)
        ma, mb = np.zeros(sz, np.uint8), np.zeros(sz, np.uint8)
        cv2.fillPoly(ma, [((a - [x0, y0]) * s).astype(np.int32)], 1)
        cv2.fillPoly(mb, [((b - [x0, y0]) * s).astype(np.int32)], 1)
        u = int((ma | mb).sum())
        return float((ma & mb).sum() / u) if u else 0.0
    inter, _ = cv2.intersectConvexConvex(a, b)
    union = cv2.contourArea(a) + cv2.contourArea(b) - inter
    return float(min(1.0, inter / union)) if union > 0 else 0.0


def _angles_ok(q: np.ndarray) -> float:
    worst = 0.0
    for i in range(4):
        p0, p1, p2 = q[i - 1], q[i], q[(i + 1) % 4]
        v1, v2 = p0 - p1, p2 - p1
        c = np.dot(v1, v2) / (np.linalg.norm(v1) * np.linalg.norm(v2) + 1e-9)
        ang = math.degrees(math.acos(max(-1, min(1, c))))
        worst = max(worst, abs(90 - ang))
    return 1.0 if worst < 25 else (0.5 if worst < 35 else 0.0)


def _aspect_score(q: np.ndarray) -> float:
    w = (np.linalg.norm(q[1] - q[0]) + np.linalg.norm(q[2] - q[3])) / 2
    h = (np.linalg.norm(q[3] - q[0]) + np.linalg.norm(q[2] - q[1])) / 2
    r = max(w, h) / max(1.0, min(w, h))
    if 2.2 <= r <= 6:  # receipts
        return 0.9
    return max(math.exp(-abs(r - t) / 0.15) for t in (1.414, 1.294, 1.586, 1.0, 1.75))


def _edge_contrast(grad: np.ndarray, q: np.ndarray) -> float:
    vals = []
    for i in range(4):
        p0, p1 = q[i], q[(i + 1) % 4]
        n = int(max(8, np.linalg.norm(p1 - p0) / 3))
        xs = np.clip(np.linspace(p0[0], p1[0], n).astype(int), 0, grad.shape[1] - 1)
        ys = np.clip(np.linspace(p0[1], p1[1], n).astype(int), 0, grad.shape[0] - 1)
        # max in a small neighbourhood tolerates 1-2 px corner error
        vals.append(float(np.mean([grad[max(0, y - 2):y + 3, max(0, x - 2):x + 3].max() for x, y in zip(xs, ys)])))
    ratio = min(vals) / (float(grad.mean()) + 1e-6)
    return min(1.0, ratio / 4.0)


def _score_quad(q: np.ndarray, area_total: float, grad: np.ndarray) -> tuple[float, dict]:
    area = cv2.contourArea(q) / area_total
    area_s = 1.0 if 0.15 <= area <= 0.97 else (0.4 if area > 0.97 else 0.1)
    convex = cv2.isContourConvex(q.astype(np.int32).reshape(-1, 1, 2))
    ang = _angles_ok(q) if convex else 0.0
    asp = _aspect_score(q)
    edge = _edge_contrast(grad, q)
    score = 0.35 * edge + 0.25 * ang + 0.25 * area_s + 0.15 * asp
    return score, {"area": round(area, 3), "angles": ang, "aspect": round(asp, 3), "edge": round(edge, 3),
                   "convex": bool(convex)}


def _approx_quad(contour: np.ndarray) -> np.ndarray | None:
    peri = cv2.arcLength(contour, True)
    for eps in (0.01, 0.02, 0.03, 0.05, 0.08):
        ap = cv2.approxPolyDP(contour, eps * peri, True)
        if len(ap) == 4:
            return ap.reshape(4, 2).astype(np.float32)
    hull = cv2.convexHull(contour)
    for eps in (0.02, 0.05, 0.08):
        ap = cv2.approxPolyDP(hull, eps * peri, True)
        if len(ap) == 4:
            return ap.reshape(4, 2).astype(np.float32)
    return None


def _quad_canny(g: np.ndarray) -> np.ndarray | None:
    b = cv2.GaussianBlur(g, (5, 5), 0)
    med = float(np.median(b))
    e = cv2.Canny(b, int(max(10, 0.66 * med)), int(min(255, 1.33 * med + 40)))
    e = cv2.dilate(e, np.ones((3, 3), np.uint8), iterations=2)
    cnts, _ = cv2.findContours(e, cv2.RETR_LIST, cv2.CHAIN_APPROX_SIMPLE)
    area = g.shape[0] * g.shape[1]
    for c in sorted(cnts, key=cv2.contourArea, reverse=True)[:8]:
        if cv2.contourArea(c) < 0.1 * area:
            break
        q = _approx_quad(c)
        if q is not None:
            return q
    return None


def _quad_threshold(g: np.ndarray) -> np.ndarray | None:
    b = cv2.GaussianBlur(g, (7, 7), 0)
    _, th = cv2.threshold(b, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    k = max(5, g.shape[1] // 60)
    th = cv2.morphologyEx(th, cv2.MORPH_CLOSE, np.ones((k, k), np.uint8))
    th = cv2.morphologyEx(th, cv2.MORPH_OPEN, np.ones((k, k), np.uint8))
    cnts, _ = cv2.findContours(th, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if not cnts:
        return None
    c = max(cnts, key=cv2.contourArea)
    if cv2.contourArea(c) < 0.1 * g.shape[0] * g.shape[1]:
        return None
    q = _approx_quad(c)
    if q is None:
        q = cv2.boxPoints(cv2.minAreaRect(c)).astype(np.float32)
    return q


def _looks_flat_scan(small: np.ndarray) -> float:
    """'Already cropped' detector: document content reaches the borders, borders are light and uniform."""
    g = gray(small)
    h, w = g.shape
    bw = max(3, int(min(h, w) * 0.03))
    strips = [g[:bw], g[-bw:], g[:, :bw], g[:, -bw:]]
    light = np.mean([float(s.mean()) > 170 for s in strips])
    uniform = np.mean([float(s.std()) < 35 for s in strips])
    return float(0.5 * light + 0.5 * uniform)


def _odd(n: int) -> int:
    return int(n) | 1


def _paper_view(small: np.ndarray) -> np.ndarray:
    """Text removed by a morphological closing (dark strokes on light paper disappear), result in LAB.
    Page boundaries survive, text, table grid lines and noise do not."""
    k = _odd(max(9, min(small.shape[:2]) // 45))
    closed = cv2.morphologyEx(small, cv2.MORPH_CLOSE, np.ones((k, k), np.uint8))
    closed = cv2.GaussianBlur(closed, (5, 5), 0)
    return cv2.cvtColor(closed, cv2.COLOR_BGR2LAB).astype(np.float32)


def _contour_quads(mask: np.ndarray, min_area: float, limit: int = 3) -> list[np.ndarray]:
    cnts, _ = cv2.findContours(mask, cv2.RETR_LIST, cv2.CHAIN_APPROX_SIMPLE)
    out = []
    for c in sorted(cnts, key=cv2.contourArea, reverse=True)[:limit * 3]:
        if cv2.contourArea(c) < min_area:
            break
        q = _approx_quad(c)
        if q is None:
            q = cv2.boxPoints(cv2.minAreaRect(c)).astype(np.float32)
        out.append(order_quad(q))
        if len(out) >= limit:
            break
    return out


def _quads_paper_edges(lab: np.ndarray) -> list[np.ndarray]:
    """Canny on every LAB channel of the text-free view, several sensitivities (catches white-on-light-desk)."""
    area = lab.shape[0] * lab.shape[1]
    out = []
    for lo, hi in ((10, 30), (25, 70)):
        e = np.zeros(lab.shape[:2], np.uint8)
        for ch in range(3):
            e |= cv2.Canny(np.clip(lab[..., ch], 0, 255).astype(np.uint8), lo, hi)
        e = cv2.dilate(e, np.ones((3, 3), np.uint8), iterations=2)
        out += _contour_quads(e, 0.1 * area, 2)
    return out


def _paper_likeness(lab: np.ndarray) -> np.ndarray:
    L = lab[..., 0]
    chroma = np.hypot(lab[..., 1] - 128, lab[..., 2] - 128)
    mu = cv2.blur(L, (15, 15))
    sd = np.sqrt(np.maximum(cv2.blur(L * L, (15, 15)) - mu * mu, 0))
    paper = L - 2.0 * chroma - 3.0 * sd
    return cv2.normalize(paper, None, 0, 255, cv2.NORM_MINMAX).astype(np.uint8)


def _offset_quad(q: np.ndarray, d: float) -> np.ndarray:
    """Move every side of a convex quad outwards by d px (undo an erosion)."""
    c = q.mean(0)
    lines = []
    for i in range(4):
        p0, p1 = q[i], q[(i + 1) % 4]
        t = p1 - p0
        n = np.array([t[1], -t[0]]) / (np.linalg.norm(t) + 1e-9)
        if np.dot(c - p0, n) > 0:
            n = -n
        lines.append((p0 + n * d, t))
    out = []
    for i in range(4):
        (a, ta), (b, tb) = lines[i - 1], lines[i]
        m = np.array([ta, -tb]).T
        if abs(np.linalg.det(m)) < 1e-6:
            out.append(q[i])
            continue
        u = np.linalg.solve(m, b - a)
        out.append(a + ta * u[0])
    return np.array(out, np.float32)


def _separated_quads(mask: np.ndarray, min_area: float) -> list[np.ndarray]:
    """The page often touches another bright object (a second sheet, a white keyboard): erode until they
    separate, fit the quad, then push its sides back out by the erosion depth."""
    out = []
    for k in (9, 21, 35):
        er = cv2.erode(mask, np.ones((k, k), np.uint8))
        for q in _contour_quads(er, min_area * 0.7, 1):
            if _convex(q) and _angles_ok(q) > 0:
                out.append(order_quad(_offset_quad(q, k / 2)))
    return out


def _quads_paper_threshold(lab: np.ndarray) -> list[np.ndarray]:
    """Bright, low-chroma, smooth region = paper. Otsu on a paper-likeness map."""
    paper = _paper_likeness(lab)
    _, th = cv2.threshold(paper, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    k = max(5, lab.shape[1] // 80)
    th = cv2.morphologyEx(th, cv2.MORPH_OPEN, np.ones((k, k), np.uint8))
    th = cv2.morphologyEx(th, cv2.MORPH_CLOSE, np.ones((k, k), np.uint8))
    area = 0.1 * lab.shape[0] * lab.shape[1]
    return _contour_quads(th, area, 2) + _separated_quads(th, area)


def _quads_grabcut(small: np.ndarray, lab: np.ndarray) -> list[np.ndarray]:
    """Colour-model segmentation (GrabCut) seeded by paper-likeness: separates white paper from a light but
    differently tinted / textured desk where edges are too weak for Canny."""
    sm, s = downscale(small, 360)
    pl = cv2.resize(_paper_likeness(lab), (sm.shape[1], sm.shape[0]), interpolation=cv2.INTER_AREA)
    t, _ = cv2.threshold(pl, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    mask = np.where(pl > t, cv2.GC_PR_FGD, cv2.GC_PR_BGD).astype(np.uint8)
    b = max(2, int(min(sm.shape[:2]) * 0.015))
    mask[:b], mask[-b:], mask[:, :b], mask[:, -b:] = cv2.GC_BGD, cv2.GC_BGD, cv2.GC_BGD, cv2.GC_BGD
    if not (mask == cv2.GC_PR_FGD).any():
        return []
    bgd, fgd = np.zeros((1, 65), np.float64), np.zeros((1, 65), np.float64)
    try:
        cv2.grabCut(sm, mask, None, bgd, fgd, 4, cv2.GC_INIT_WITH_MASK)
    except cv2.error:
        return []
    fg = np.where((mask == cv2.GC_FGD) | (mask == cv2.GC_PR_FGD), 255, 0).astype(np.uint8)
    fg = cv2.morphologyEx(fg, cv2.MORPH_OPEN, np.ones((5, 5), np.uint8))
    area = 0.1 * fg.shape[0] * fg.shape[1]
    qs = _contour_quads(fg, area, 1) + _separated_quads(fg, area)[:1]
    return [q / s for q in qs]


def _side_samples(q: np.ndarray, i: int, n: int = 40):
    p0, p1 = q[i], q[(i + 1) % 4]
    t = np.linspace(0.1, 0.9, n)[:, None]
    pts = p0 + (p1 - p0) * t
    d = p1 - p0
    nrm = np.array([d[1], -d[0]]) / (np.linalg.norm(d) + 1e-9)
    c = q.mean(0)
    if np.dot(c - (p0 + p1) / 2, nrm) < 0:  # make the normal point inwards
        nrm = -nrm
    return pts, nrm


def _boundary_evidence(q: np.ndarray, lab: np.ndarray, grad: np.ndarray) -> tuple[float, float, dict]:
    """(edge support, inside/outside contrast) along the four sides. Sides on the image border have no
    outside and are skipped for contrast (page touching the frame)."""
    h, w = lab.shape[:2]
    off = max(4.0, min(h, w) * 0.012)
    gthr = max(6.0, float(np.percentile(grad, 80)))
    edge, contrast, n_out = [], [], 0
    for i in range(4):
        pts, nrm = _side_samples(q, i)
        inside = pts + nrm * off
        outside = pts - nrm * off
        on_border = np.mean((outside[:, 0] < 1) | (outside[:, 1] < 1) | (outside[:, 0] > w - 2) |
                            (outside[:, 1] > h - 2)) > 0.5
        xs = np.clip(pts[:, 0].astype(int), 0, w - 1)
        ys = np.clip(pts[:, 1].astype(int), 0, h - 1)
        g = np.array([grad[max(0, y - 2):y + 3, max(0, x - 2):x + 3].max() for x, y in zip(xs, ys)])
        edge.append(float(np.mean(g > gthr)))
        if on_border:
            continue
        n_out += 1
        ii = np.clip(inside.astype(int), 0, [w - 1, h - 1])
        oo = np.clip(outside.astype(int), 0, [w - 1, h - 1])
        de = np.linalg.norm(lab[ii[:, 1], ii[:, 0]] - lab[oo[:, 1], oo[:, 0]], axis=1)
        contrast.append(float(np.median(de)))
    edge_s = float(np.mean(sorted(edge)[:3])) if edge else 0.0  # one weak side is tolerated
    # one weak side is tolerated (uneven light, a shadow along one edge), as long as the others are clear
    con = sorted(contrast)
    con_s = min(1.0, (con[1] if len(con) >= 3 else con[0]) / 18.0) if con else 0.0
    if len(con) >= 3 and con[0] < 3:  # one side with no contrast at all: probably not a page edge
        con_s *= 0.6
    return edge_s, con_s, {"edge_sides": [round(e, 2) for e in edge], "contrast": [round(c, 1) for c in contrast],
                           "sides_inside_frame": n_out}


def _score_page_quad(q: np.ndarray, lab: np.ndarray, grad: np.ndarray) -> tuple[float, dict]:
    area_total = float(lab.shape[0] * lab.shape[1])
    area = cv2.contourArea(q) / area_total
    area_s = 1.0 if 0.12 <= area <= 0.97 else (0.4 if area > 0.97 else 0.1)
    convex = _convex(q)
    ang = _angles_ok(q) if convex else 0.0
    asp = _aspect_score(q)
    edge, con, sig = _boundary_evidence(q, lab, grad)
    score = 0.25 * edge + 0.35 * con + 0.15 * ang + 0.15 * area_s + 0.10 * asp
    if not convex:
        score *= 0.5
    sig.update({"area": round(area, 3), "angles": ang, "aspect": round(asp, 3), "edge": round(edge, 3),
                "inout_contrast": round(con, 3), "convex": convex})
    return score, sig


def detect_boundary(img: np.ndarray) -> tuple[list[Candidate], Candidate, str, dict]:
    """Returns (candidates, chosen, tier, signals). Quads are in full-resolution pixel coords.

    Candidates come from several detectors (Canny on the photo, Canny on the text-free LAB view at two
    sensitivities, Otsu threshold, paper-likeness threshold) and are scored on the *evidence for a page boundary*:
    edge support along each side and colour contrast between just inside and just outside each side. A table or
    text block inside a scan has paper on both sides of its border -> no contrast -> it loses to the full frame."""
    small, s = downscale(img, 1000)
    g = gray(small)
    lab = _paper_view(small)
    gl = cv2.GaussianBlur(lab, (3, 3), 0)
    grad = np.zeros(g.shape, np.float32)
    for ch in range(3):
        grad = np.maximum(grad, cv2.magnitude(cv2.Sobel(gl[..., ch], cv2.CV_32F, 1, 0),
                                              cv2.Sobel(gl[..., ch], cv2.CV_32F, 0, 1)) / 4)
    H, W = img.shape[:2]
    full = np.array([[0, 0], [W - 1, 0], [W - 1, H - 1], [0, H - 1]], dtype=np.float32)

    raw: list[tuple[str, np.ndarray]] = []
    for name, fn in (("contour_canny", lambda: [x for x in [_quad_canny(g)] if x is not None]),
                     ("contour_threshold", lambda: [x for x in [_quad_threshold(g)] if x is not None]),
                     ("paper_edges", lambda: _quads_paper_edges(lab)),
                     ("paper_region", lambda: _quads_paper_threshold(lab)),
                     ("grabcut", lambda: _quads_grabcut(small, lab))):
        for q in fn():
            q = order_quad(q)
            if any(quad_iou(q, r) > 0.985 for _, r in raw):  # duplicate
                continue
            raw.append((name, q))

    cands: list[Candidate] = []
    scored = []
    for name, q in raw:
        sc, sig = _score_page_quad(q, lab, grad)
        scored.append((name, q, sc, sig))
    # agreement between independent detectors -> small boost
    for i, (name, q, sc, sig) in enumerate(scored):
        agree = sorted({n for j, (n, r, _, _) in enumerate(scored) if j != i and n != name and quad_iou(q, r) > 0.92})
        sig["agree_with"] = agree
        sc = min(1.0, sc + 0.05 * min(2, len(agree)))
        cands.append(Candidate(name, {"quad": (q / s).round(1).tolist()}, round(sc, 3), sig))

    flat = _looks_flat_scan(small)
    best_quad = max((c.score for c in cands if c.signals["area"] < 0.97), default=0.0)
    # full frame: a scan / already-cropped page, or nothing convincing found
    ff_score = 0.8 if flat > 0.7 else (0.62 if best_quad < 0.6 else 0.3)
    cands.append(Candidate("full_frame", {"quad": full.round(1).tolist()}, ff_score, {"flat_scan": round(flat, 2)}))

    chosen = max(cands, key=lambda c: c.score)
    best_other = sorted((c.score for c in cands if c is not chosen), reverse=True)
    margin = chosen.score - (best_other[0] if best_other else 0)
    agreeing = len(chosen.signals.get("agree_with", []))
    if chosen.score >= 0.75 and (margin > 0.1 or agreeing or chosen.method == "full_frame"):
        tier = "high"
    elif chosen.score >= 0.55:
        tier = "medium"
    else:
        tier = "low"
    signals = {"flat_scan": round(flat, 2), "margin": round(margin, 3), "n_candidates": len(cands)}
    return cands, chosen, tier, signals


def warp(img: np.ndarray, quad: list) -> np.ndarray:
    q = order_quad(np.array(quad, dtype=np.float32))
    H, W = img.shape[:2]
    if cv2.contourArea(q) > 0.985 * W * H:
        return img
    w = int(max(np.linalg.norm(q[1] - q[0]), np.linalg.norm(q[2] - q[3])))
    h = int(max(np.linalg.norm(q[3] - q[0]), np.linalg.norm(q[2] - q[1])))
    sc = min(1.0, 4500 / max(w, h))
    w, h = max(10, int(w * sc)), max(10, int(h * sc))
    dst = np.array([[0, 0], [w - 1, 0], [w - 1, h - 1], [0, h - 1]], dtype=np.float32)
    M = cv2.getPerspectiveTransform(q, dst)
    return cv2.warpPerspective(img, M, (w, h), flags=cv2.INTER_CUBIC, borderMode=cv2.BORDER_REPLICATE)


# ---------------------------------------------------------------- 4. acceptance
def _text_lines(bw: np.ndarray) -> tuple[int, int]:
    """Count horizontal text-line blobs in a binarized (text = white) image."""
    k = max(9, bw.shape[1] // 90)
    closed = cv2.morphologyEx(bw, cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_RECT, (k, 1)))
    cnts, _ = cv2.findContours(closed, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    text_area, lines = 0, 0
    for c in cnts:
        x, y, w, h = cv2.boundingRect(c)
        if 4 <= h <= 60 and w > 3 * h and cv2.contourArea(c) / (w * h) > 0.3:
            text_area += w * h
            lines += 1
    return text_area, lines


def acceptance_signals(img: np.ndarray, boundary_score: float) -> dict:
    small, _ = downscale(img, 1600)
    g = gray(small)
    bw = cv2.adaptiveThreshold(cv2.GaussianBlur(g, (3, 3), 0), 255, cv2.ADAPTIVE_THRESH_MEAN_C,
                               cv2.THRESH_BINARY_INV, 31, 15)
    area = g.shape[0] * g.shape[1]
    # orientation-independent: text may still be sideways at this point
    text_area, lines = max(_text_lines(bw), _text_lines(cv2.rotate(bw, cv2.ROTATE_90_CLOCKWISE)),
                           key=lambda r: r[1])
    hsv = cv2.cvtColor(small, cv2.COLOR_BGR2HSV) if small.ndim == 3 else None
    colorful = float(((hsv[..., 1] > 80) & (hsv[..., 2] > 50)).mean()) if hsv is not None else 0.0
    td = min(1.0, (text_area / area) / 0.12)
    lines_s = min(1.0, lines / 25)
    doc_color = 1 - min(1.0, colorful / 0.35)
    score = 0.35 * td + 0.15 * lines_s + 0.25 * boundary_score + 0.25 * doc_color
    return {"text_density": round(td, 3), "text_lines": lines, "boundary": round(boundary_score, 3),
            "colorfulness": round(colorful, 3), "score": round(score, 3)}


# ---------------------------------------------------------------- 5. orientation helpers
def rotate90(img: np.ndarray, angle_cw: int) -> np.ndarray:
    a = angle_cw % 360
    if a == 90:
        return cv2.rotate(img, cv2.ROTATE_90_CLOCKWISE)
    if a == 180:
        return cv2.rotate(img, cv2.ROTATE_180)
    if a == 270:
        return cv2.rotate(img, cv2.ROTATE_90_COUNTERCLOCKWISE)
    return img


def line_direction(img: np.ndarray) -> dict:
    """Text lines horizontal vs vertical from projection-profile sharpness (cheap, language independent)."""
    small, _ = downscale(img, 1000)
    g = gray(small)
    _, bw = cv2.threshold(g, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)
    rows = bw.sum(1).astype(np.float64)
    cols = bw.sum(0).astype(np.float64)
    sh = float(np.sum(np.diff(rows) ** 2)) / max(1, len(rows))
    sv = float(np.sum(np.diff(cols) ** 2)) / max(1, len(cols))
    ratio = sh / (sv + 1e-9)
    return {"horizontal": ratio > 1.0, "ratio": round(ratio, 3)}


# ---------------------------------------------------------------- 7. deskew
def _profile_score(bw: np.ndarray, angle: float) -> float:
    h, w = bw.shape
    M = cv2.getRotationMatrix2D((w / 2, h / 2), angle, 1.0)
    r = cv2.warpAffine(bw, M, (w, h), flags=cv2.INTER_NEAREST, borderValue=0)
    rows = r.sum(1).astype(np.float64)
    return float(np.sum(np.diff(rows) ** 2))


def estimate_deskew(img: np.ndarray) -> tuple[float, str, dict]:
    small, _ = downscale(img, 1400)
    g = gray(small)
    _, bw = cv2.threshold(g, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)
    # ignore page borders (shadows) that dominate the profile
    m = int(min(bw.shape) * 0.04)
    bw = bw[m:-m, m:-m] if m > 0 else bw
    if bw.mean() < 1:
        return 0.0, "medium", {"reason": "empty"}
    coarse = {a: _profile_score(bw, a) for a in np.arange(-10, 10.01, 0.5)}
    best = max(coarse, key=coarse.get)
    fine = {a: _profile_score(bw, a) for a in np.arange(best - 0.5, best + 0.51, 0.1)}
    best = float(max(fine, key=fine.get))
    base = coarse[0.0] if 0.0 in coarse else min(coarse.values())
    vals = np.array(list(coarse.values()))
    peak = float((fine[max(fine, key=fine.get)] - np.median(vals)) / (np.median(vals) + 1e-9))
    tier = "high" if peak > 0.25 or abs(best) < 0.3 else ("medium" if peak > 0.08 else "low")
    return round(best, 2), tier, {"peak": round(peak, 3), "gain_vs_zero": round(fine[max(fine, key=fine.get)] / (base + 1e-9), 3)}


def rotate_small(img: np.ndarray, angle: float) -> np.ndarray:
    if abs(angle) < 0.05:
        return img
    h, w = img.shape[:2]
    M = cv2.getRotationMatrix2D((w / 2, h / 2), angle, 1.0)
    cos, sin = abs(M[0, 0]), abs(M[0, 1])
    nw, nh = int(h * sin + w * cos), int(h * cos + w * sin)
    M[0, 2] += nw / 2 - w / 2
    M[1, 2] += nh / 2 - h / 2
    return cv2.warpAffine(img, M, (nw, nh), flags=cv2.INTER_CUBIC, borderMode=cv2.BORDER_REPLICATE)


def text_line_curvature(img: np.ndarray) -> float:
    """Rough curvature measure: how much text-line blobs deviate from straight lines (0 = flat)."""
    small, _ = downscale(img, 1200)
    g = gray(small)
    _, bw = cv2.threshold(g, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)
    bw = cv2.morphologyEx(bw, cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_RECT, (25, 3)))
    cnts, _ = cv2.findContours(bw, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
    devs = []
    for c in cnts:
        x, y, w, h = cv2.boundingRect(c)
        if w < small.shape[1] * 0.3 or h > 80:
            continue
        pts = c.reshape(-1, 2)
        xs, ys = pts[:, 0].astype(np.float64), pts[:, 1].astype(np.float64)
        try:
            fit = np.polyfit(xs, ys, 1)
            devs.append(float(np.abs(ys - np.polyval(fit, xs)).mean()) / max(1, h))
        except (np.linalg.LinAlgError, ValueError):
            continue
    return round(float(np.median(devs)), 3) if devs else 0.0


# ---------------------------------------------------------------- 8. cleanup
def _background(ch: np.ndarray) -> np.ndarray:
    small, s = downscale(ch, 900)
    k = max(3, int(min(small.shape) / 60) | 1)
    bg = cv2.dilate(small, np.ones((k, k), np.uint8))
    bg = cv2.medianBlur(bg, 21)
    return cv2.resize(bg, (ch.shape[1], ch.shape[0]), interpolation=cv2.INTER_LINEAR)


def whiten(img: np.ndarray) -> np.ndarray:
    chans = cv2.split(img) if img.ndim == 3 else [img]
    out = []
    for ch in chans:
        bg = _background(ch).astype(np.float32)
        n = np.clip(ch.astype(np.float32) / np.maximum(bg, 1) * 255.0, 0, 255)
        out.append(n.astype(np.uint8))
    return cv2.merge(out) if len(out) > 1 else out[0]


def choose_cleanup_mode(whitened: np.ndarray) -> tuple[str, dict]:
    if whitened.ndim == 2:
        return "gray", {"colored": 0.0}
    small, _ = downscale(whitened, 800)
    hsv = cv2.cvtColor(small, cv2.COLOR_BGR2HSV)
    colored = float(((hsv[..., 1] > 70) & (hsv[..., 2] < 245) & (hsv[..., 2] > 40)).mean())
    return ("color" if colored > 0.006 else "gray"), {"colored": round(colored, 4)}


def cleanup(img: np.ndarray, mode: str, strength: float) -> np.ndarray:
    w = whiten(img)
    if strength < 1.0:
        w = cv2.addWeighted(img, 1 - strength, w, strength, 0)
    if mode == "color":
        return w
    g = gray(w)
    # gentle contrast stretch
    lo, hi = np.percentile(g, 1), np.percentile(g, 99.5)
    if hi - lo > 30:
        g = np.clip((g.astype(np.float32) - lo) * 255.0 / (hi - lo), 0, 255).astype(np.uint8)
    if mode == "gray":
        return g
    _, bw = cv2.threshold(g, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    return bw
