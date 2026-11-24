"""Classic computer-vision stages. Each estimator returns candidates (method, value, score, signals)."""
import math
import os
from dataclasses import dataclass, field

import cv2
import numpy as np

# workers run one page each, one per core: OpenCV must not start its own thread per core in every one of them
# (docker-compose.yml sets OMP_NUM_THREADS=1 for the workers; OpenCV's thread pool does not read it by itself)
if os.environ.get("OMP_NUM_THREADS", "").isdigit():
    cv2.setNumThreads(int(os.environ["OMP_NUM_THREADS"]))


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


def _quad_blank_border(img: np.ndarray) -> tuple[np.ndarray, dict] | None:
    """A sheet smaller than the scanner glass: the scanner (or its software) fills the rest of the frame with
    *pure* white (255, no noise at all), the paper itself is a touch darker (even 254). Invisible to edge and
    contrast detectors, but exact: real paper is never perfectly saturated over a large area, and a born-digital
    page has pure white paper too (nothing to tell apart -> no candidate). Returns (quad in full-res px, signals)."""
    g = gray(img)
    H, W = g.shape
    k = max(4, round(max(H, W) / 400))  # density cell
    h, w = H // k, W // k
    if h < 40 or w < 40:
        return None
    # share of not-pure-white pixels per cell: high on paper (lower right around text, where scanners brighten),
    # exactly 0 on the blank fill
    dens = (g[:h * k, :w * k] < 255).reshape(h, k, w, k).mean(axis=(1, 3))
    paper = (dens > 0.6).astype(np.uint8)
    if not 0.12 < float(paper.mean()) < 0.93:
        return None
    paper = cv2.morphologyEx(paper, cv2.MORPH_CLOSE, np.ones((15, 15), np.uint8))  # text lines inside the page
    paper = cv2.morphologyEx(paper, cv2.MORPH_OPEN, np.ones((7, 7), np.uint8))  # specks, marks in the blank area
    n, lab, stats, _ = cv2.connectedComponentsWithStats(paper, 8)
    if n < 2:
        return None
    i = 1 + int(np.argmax(stats[1:, cv2.CC_STAT_AREA]))
    comp = (lab == i).astype(np.uint8)
    cnts, _ = cv2.findContours(comp, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    (cx, cy), (rw, rh), ang = cv2.minAreaRect(max(cnts, key=cv2.contourArea))
    # contour points are cell indices: +1 cell in size, +0.5 in position = the outer edges of the cells
    box = cv2.boxPoints(((cx + 0.5, cy + 0.5), (rw + 1, rh + 1), ang)).astype(np.float32)
    inside = np.zeros_like(comp)
    cv2.fillConvexPoly(inside, box.round().astype(np.int32), 1)
    area = float(inside.sum())
    if area < 0.15 * h * w or area > 0.93 * h * w:
        return None
    # the paper edge itself (half-covered cells, a scanner shadow line) belongs to neither side
    din, dout = dens[inside > 0], dens[cv2.dilate(inside, np.ones((7, 7), np.uint8)) == 0]
    if not dout.size:
        return None
    fill = float(din.mean())  # the rectangle is paper ...
    solid = float((din > 0.95).mean())  # ... with large areas that have no pure white at all (not a digital page)
    blank = 1.0 - float(dout.mean())  # the rest is pure white ...
    busy = float((dout > 0.1).mean())  # ... with next to nothing in it (no text, no pictures)
    sig = {"area": round(area / (h * w), 3), "paper_fill": round(fill, 3), "paper_solid": round(solid, 3),
           "blank_outside": round(blank, 4), "busy_outside": round(busy, 4), "inout_contrast": 0.0}
    if fill < 0.55 or solid < 0.35 or blank < 0.985 or busy < 0 or busy > 0.02:
        return None
    box = box * k
    box[:, 0] = box[:, 0].clip(0, W - 1)
    box[:, 1] = box[:, 1].clip(0, H - 1)
    return order_quad(box), sig


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


def _line_intersection(l1, l2):
    (x1, y1, x2, y2), (x3, y3, x4, y4) = l1, l2
    d = (x1 - x2) * (y3 - y4) - (y1 - y2) * (x3 - x4)
    if abs(d) < 1e-9:
        return None
    a, b = x1 * y2 - y1 * x2, x3 * y4 - y3 * x4
    return np.array([(a * (x3 - x4) - (x1 - x2) * b) / d, (a * (y3 - y4) - (y1 - y2) * b) / d], np.float32)


def _merge_segments(segs: np.ndarray, size: float) -> list[tuple]:
    """Collinear Hough segments -> one line each (theta, rho clusters), weighted by total length."""
    out = []
    for x1, y1, x2, y2 in segs:
        th = math.atan2(y2 - y1, x2 - x1) % math.pi
        rho = x1 * math.sin(th) - y1 * math.cos(th)
        ln = math.hypot(x2 - x1, y2 - y1)
        for c in out:
            dth = min(abs(th - c["th"]), math.pi - abs(th - c["th"]))
            if dth < math.radians(4) and abs(abs(rho) - abs(c["rho"])) < size * 0.015:
                c["len"] += ln
                c["pts"] += [(x1, y1), (x2, y2)]
                break
        else:
            out.append({"th": th, "rho": rho, "len": ln, "pts": [(x1, y1), (x2, y2)]})
    lines = []
    for c in out:
        pts = np.array(c["pts"], np.float32)
        vx, vy, x0, y0 = cv2.fitLine(pts, cv2.DIST_L2, 0, 0.01, 0.01).ravel()
        lines.append(((x0 - vx * 1000, y0 - vy * 1000, x0 + vx * 1000, y0 + vy * 1000), c["len"], c["th"]))
    return lines


def _quads_hough(lab: np.ndarray) -> list[tuple[np.ndarray, float]]:
    """Page edges are long, straight and sharp; soft shadow edges and text are not. Strong straight lines on the
    text-free view, two near-horizontal + two near-vertical form a quad."""
    L = np.clip(lab[..., 0], 0, 255).astype(np.uint8)
    h, w = L.shape
    size = float(min(h, w))
    all_segs = []
    for lo, hi in ((20, 50), (8, 24)):  # normal and dim / low-contrast photos
        segs = cv2.HoughLinesP(cv2.Canny(L, lo, hi), 1, np.pi / 360, threshold=int(size * 0.08),
                               minLineLength=int(size * 0.15), maxLineGap=int(size * 0.03))
        if segs is not None:
            all_segs.append(segs.reshape(-1, 4))
    if not all_segs:
        return []
    lines = _merge_segments(np.concatenate(all_segs).astype(np.float64), size)
    hor = sorted([x for x in lines if min(x[2], math.pi - x[2]) < math.radians(45)], key=lambda x: -x[1])[:5]
    ver = sorted([x for x in lines if min(x[2], math.pi - x[2]) >= math.radians(45)], key=lambda x: -x[1])[:5]
    quads = []
    margin = 0.08 * size
    for i in range(len(hor)):
        for j in range(i + 1, len(hor)):
            for k in range(len(ver)):
                for m in range(k + 1, len(ver)):
                    pts = [_line_intersection(a[0], b[0]) for a, b in
                           ((hor[i], ver[k]), (hor[i], ver[m]), (hor[j], ver[m]), (hor[j], ver[k]))]
                    if any(p is None for p in pts):
                        continue
                    q = np.array(pts, np.float32)
                    if (q[:, 0] < -margin).any() or (q[:, 1] < -margin).any() or (q[:, 0] > w + margin).any() \
                            or (q[:, 1] > h + margin).any():
                        continue
                    q[:, 0] = q[:, 0].clip(0, w - 1)
                    q[:, 1] = q[:, 1].clip(0, h - 1)
                    q = order_quad(q)
                    if cv2.contourArea(q) < 0.1 * h * w or not _convex(q):
                        continue
                    quads.append(q)
    return quads


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


def _band_mean(m: np.ndarray, pts: np.ndarray, nrm: np.ndarray, d0: float, d1: float) -> float:
    """Mean of map m over a band parallel to a side, from d0 to d1 along the (inward) normal."""
    h, w = m.shape[:2]
    vals = []
    for d in np.linspace(d0, d1, 6):
        pp = (pts + nrm * d).astype(int)
        ok = (pp[:, 0] >= 0) & (pp[:, 0] < w) & (pp[:, 1] >= 0) & (pp[:, 1] < h)
        vals.extend(m[pp[ok, 1], pp[ok, 0]].tolist())
    return float(np.mean(vals)) if vals else 0.0


def _boundary_evidence(q: np.ndarray, lab: np.ndarray, grad: np.ndarray,
                       ink: np.ndarray | None = None) -> tuple[float, float, dict]:
    """(edge support, inside/outside contrast) along the four sides. Sides on the image border have no
    outside and are skipped for contrast (page touching the frame)."""
    h, w = lab.shape[:2]
    off = max(4.0, min(h, w) * 0.012)
    gthr = max(6.0, float(np.percentile(grad, 80)))
    edge, contrast, soft, n_out, unsupported, cuts = [], [], [], 0, 0, 0
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
        de = float(np.median(np.linalg.norm(lab[ii[:, 1], ii[:, 0]] - lab[oo[:, 1], oo[:, 0]], axis=1)))
        # sharpness: a paper edge is a step of a few px, a cast shadow a ramp of tens of px. Peak gradient
        # relative to the colour step across the side; soft sides are not page edges.
        sharp = float(np.median(g)) / (de + 1.0)
        soft.append(round(sharp, 3))
        contrast.append(0.0 if (de > 20 and sharp < 0.19) else de)
        if edge[-1] < 0.3 and de < 25:  # no edge and no colour step: the side runs through the page / desk
            unsupported += 1
            if ink is not None:  # text continues beyond the side: it cuts through the page
                band = max(off * 3, min(h, w) * 0.04)
                tin = _band_mean(ink, pts, nrm, off, off + band)
                tout = _band_mean(ink, pts, -nrm, off, off + band)
                if tin > 0.05 and tout > 0.5 * tin:
                    cuts += 1
    edge_s = float(np.mean(sorted(edge)[:3])) if edge else 0.0  # one weak side is tolerated
    # one weak side is tolerated (uneven light, a shadow along one edge), as long as the others are clear
    con = sorted(contrast)
    con_s = min(1.0, (con[1] if len(con) >= 3 else con[0]) / 18.0) if con else 0.0
    if len(con) == 1:  # a single side inside the frame is weak evidence (could be a shadow edge)
        con_s *= 0.6
    if len(con) >= 3 and con[0] < 3:  # one side with no contrast at all: probably not a page edge
        con_s *= 0.6
    return edge_s, con_s, {"edge_sides": [round(e, 2) for e in edge], "contrast": [round(c, 1) for c in contrast],
                           "sides_inside_frame": n_out, "sharpness": soft, "unsupported_sides": unsupported,
                           "cuts_text": cuts}


def _score_page_quad(q: np.ndarray, lab: np.ndarray, grad: np.ndarray,
                     ink: np.ndarray | None = None) -> tuple[float, dict]:
    area_total = float(lab.shape[0] * lab.shape[1])
    area = cv2.contourArea(q) / area_total
    area_s = 1.0 if 0.12 <= area <= 0.97 else (0.4 if area > 0.97 else 0.1)
    convex = _convex(q)
    ang = _angles_ok(q) if convex else 0.0
    asp = _aspect_score(q)
    edge, con, sig = _boundary_evidence(q, lab, grad, ink)
    score = 0.25 * edge + 0.35 * con + 0.15 * ang + 0.15 * area_s + 0.10 * asp
    if not convex:
        score *= 0.5
    # two sides without any evidence: a line inside the page (a stack edge, a table rule, a fold) paired with
    # real edges; such quads cut through the text
    if sig["unsupported_sides"] >= 2:
        score *= 0.6
    if sig["cuts_text"]:  # the crop would cut text lines off
        score *= 0.7
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
    # ink: thin dark strokes (text, rules), found as the difference between the text-free view and the photo
    ink = (lab[..., 0] - cv2.cvtColor(small, cv2.COLOR_BGR2LAB)[..., 0].astype(np.float32)) > 40
    ink = ink.astype(np.float32)
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
        sc, sig = _score_page_quad(q, lab, grad, ink)
        scored.append((name, q, sc, sig))
    hough = sorted(((q, *_score_page_quad(q, lab, grad, ink)) for q in _quads_hough(lab)), key=lambda x: -x[1])
    for q, sc, sig in hough[:3]:
        if not any(quad_iou(q, r) > 0.985 for _, r, _, _ in scored):
            scored.append(("hough_lines", q, sc, sig))
    # agreement between independent detectors -> small boost
    for i, (name, q, sc, sig) in enumerate(scored):
        agree = sorted({n for j, (n, r, _, _) in enumerate(scored) if j != i and n != name and quad_iou(q, r) > 0.92})
        sig["agree_with"] = agree
        sc = min(1.0, sc + 0.05 * min(2, len(agree)))
        cands.append(Candidate(name, {"quad": (q / s).round(1).tolist()}, round(sc, 3), sig))

    flat = _looks_flat_scan(small)
    best_quad = max((c.score for c in cands if c.signals["area"] < 0.97), default=0.0)
    # full frame: a scan / already-cropped page, or nothing convincing found
    # (a light desk also has light, uniform borders: a quad with clear contrast on >= 3 sides still wins)
    clear = max((c.signals["inout_contrast"] for c in cands if c.signals["area"] < 0.97), default=0.0)
    ff_score = (0.8 if clear < 0.7 else 0.7) if flat > 0.7 else (0.62 if best_quad < 0.6 else 0.3)
    cands.append(Candidate("full_frame", {"quad": full.round(1).tolist()}, ff_score, {"flat_scan": round(flat, 2)}))

    # a small sheet on the scanner glass, surrounded by the scanner's pure-white fill: beats the full frame
    if flat > 0.7:
        bb = _quad_blank_border(img)
        if bb is not None:
            cands.append(Candidate("blank_border", {"quad": bb[0].round(1).tolist()}, 0.88, bb[1]))

    chosen = max(cands, key=lambda c: c.score)
    best_other = sorted((c.score for c in cands if c is not chosen), reverse=True)
    margin = chosen.score - (best_other[0] if best_other else 0)
    agreeing = len(chosen.signals.get("agree_with", []))
    if chosen.score >= 0.75 and (margin > 0.1 or agreeing or chosen.method in ("full_frame", "blank_border")):
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


def _sharp_end(dist: np.ndarray, end: int, max_soft: int) -> bool:
    """Does the band end in a step (a page edge: background right next to paper) rather than a ramp (the soft
    fringe of a shadow)? `dist` is the colour distance to paper for the bin's columns, `end` the first paper row."""
    prof = np.median(dist[:end + 3], axis=1)
    level = float(np.median(prof[:max(1, end // 2)]))
    r = end
    while r > 0 and prof[r - 1] < 0.8 * level:
        r -= 1
    return end - r <= max_soft


def _edge_depths(bad: np.ndarray, maxd: int, solid: np.ndarray | None = None, far: int = 0,
                 bins: int = 24, dist: np.ndarray | None = None, ink: np.ndarray | None = None) -> tuple[float, float]:
    """Background band along the top edge of a warped page (bad = non-paper pixels, text removed):
    per column the depth of the first paper row, robust straight-line fit across the width, depths at both ends.
    Stops at the first clean row, so an edge band is trimmed but nothing beyond it (no cutting into the page).
    Bands up to maxd deep are trimmed; deeper ones (up to far) only where the band is solidly unlike paper
    (`solid`: a dark desk, not a shadow lying on the paper)."""
    h, w = bad.shape
    reach = max(maxd, far)
    band = bad[:reach + 3]
    # a column is clean from row r on when 3 consecutive rows are paper
    ok = ~(band[:-2] | band[1:-1] | band[2:])
    first = np.where(ok.any(0), ok.argmax(0), reach).astype(np.float32)
    first = np.minimum(first, reach)
    xs, ds = [], []
    for i in range(bins):
        a, b = i * w // bins, (i + 1) * w // bins
        if b <= a:
            continue
        med = float(np.median(first[a:b]))
        # no clean paper within maxd: a cast shadow or a dark printed area continuing into the page, not a band
        # (those end close to the edge) -> no evidence, unless the band is solid background all the way down
        if med >= maxd and not (solid is not None and med < reach and solid[:int(med), a:b].mean() > 0.85
                                and (dist is None or _sharp_end(dist[:, a:b], int(med), max(4, h // 80)))
                                # never trim text away: a desk has none, a page lying in shadow does
                                and (ink is None or ink[:int(med), a:b].mean() < 0.004)):
            continue
        xs.append((a + b) / 2 / w)
        ds.append(med)
    if len(ds) < bins // 3:
        return 0.0, 0.0
    xs, ds = np.array(xs), np.array(ds)
    # deep trimming only for a band along (nearly) the whole side, like a desk below the page; a dark cast
    # shadow over one corner is a wedge present on part of the side only -> keep just the shallow part
    if (ds >= maxd).any() and (ds > 1).sum() < 0.75 * bins:
        keep = ds < maxd
        xs, ds = xs[keep], ds[keep]
        if len(ds) < bins // 3:
            return 0.0, 0.0
    if ds.max() < 1:
        return 0.0, 0.0

    def fit(xs, ds):  # Theil-Sen line (robust to bins crossing a dark figure or a hand holding the page)
        slopes = [(ds[j] - ds[i]) / (xs[j] - xs[i]) for i in range(len(xs)) for j in range(i + 1, len(xs))]
        k = float(np.median(slopes)) if slopes else 0.0
        c = float(np.median(ds - k * xs))
        return c, c + k
    clip = lambda v: float(min(reach, max(0.0, v)))  # noqa: E731
    e0, e1 = fit(xs, ds)
    # a deep band must be deep along the whole side (desk below the page: both ends), not a wedge from one
    # corner (a cast shadow crossing the side diagonally) -> otherwise only the shallow part counts
    if max(e0, e1) > maxd and min(e0, e1) < maxd / 2:
        keep = ds < maxd
        if keep.sum() < bins // 3:
            return 0.0, 0.0
        e0, e1 = fit(xs[keep], ds[keep])
        return float(min(maxd, max(0.0, e0))), float(min(maxd, max(0.0, e1)))
    return clip(e0), clip(e1)


def _cuts_ink(ink: np.ndarray, near: tuple, deep: tuple) -> bool:
    """Would moving the top edge from the `near` line down to the `deep` line (depths at both ends) remove text?"""
    w = ink.shape[1]
    x = np.linspace(0, 1, w)
    lo = (near[0] + (near[1] - near[0]) * x).astype(int)
    hi = (deep[0] + (deep[1] - deep[0]) * x).astype(int)
    rows = np.arange(ink.shape[0])[:, None]
    region = (rows >= lo[None, :]) & (rows < hi[None, :])
    return bool(region.any()) and float(ink[region].mean()) > 0.002


def _paper_dist(lab: np.ndarray, ref: np.ndarray) -> np.ndarray:
    d = lab - ref
    return np.sqrt((0.6 * d[..., 0]) ** 2 + d[..., 1] ** 2 + d[..., 2] ** 2)


def refine_quad(img: np.ndarray, quad: list, max_frac: float = 0.08, max_far: float = 0.25) -> tuple[list, dict]:
    """Trim background left inside a detected page quad: along each side, a solid band whose colour differs from the
    paper next to it (table, floor, fingers) is cut off, at most max_frac of the page per side. Text and ruled lines
    are removed first (closing), and trimming stops at the first clean paper row, so the page itself is never cut."""
    q = order_quad(np.array(quad, dtype=np.float32))
    w = max(np.linalg.norm(q[1] - q[0]), np.linalg.norm(q[2] - q[3]))
    h = max(np.linalg.norm(q[3] - q[0]), np.linalg.norm(q[2] - q[1]))
    sc = 900 / max(w, h)
    W, H = max(40, int(w * sc)), max(40, int(h * sc))
    dst = np.array([[0, 0], [W - 1, 0], [W - 1, H - 1], [0, H - 1]], dtype=np.float32)
    M = cv2.getPerspectiveTransform(q, dst)
    small = cv2.warpPerspective(img, M, (W, H), flags=cv2.INTER_AREA, borderMode=cv2.BORDER_CONSTANT,
                                borderValue=(0, 0, 0))  # outside the photo counts as background
    lab = _paper_view(small)
    # text strokes: dark detail the closing removed (thin lines darker than the text-free view)
    ink = (lab[..., 0] - cv2.cvtColor(small, cv2.COLOR_BGR2LAB)[..., 0].astype(np.float32)) > 40
    depths = {}
    for side in range(4):  # top, right, bottom, left: rotate so the side is on top, ends ordered clockwise
        v = np.rot90(lab, side)
        hh = v.shape[0]
        maxd = max(2, int(max_frac * hh))
        far = int(max_far * hh)
        # reference paper colour: the band just inside the trimming zone, same side (follows shadows / tints)
        sample = lambda at: np.median(v[at + 2:at + 2 + max(4, hh // 25)].reshape(-1, 3), axis=0)  # noqa: E731
        dist = _paper_dist(v, sample(maxd))
        d0, d1 = _edge_depths(dist > 16, maxd)
        # a background band deeper than maxd (e.g. desk below the page): the near sample is still on it, so look
        # for paper further in; accepted only as a solid, sharp-edged, text-free band along the whole side
        ref_far = sample(far)
        if ref_far[0] > sample(maxd)[0] + 5:
            distf = _paper_dist(v, ref_far)
            f0, f1 = _edge_depths(distf > 16, maxd, solid=distf > 40, far=far, dist=distf, ink=np.rot90(ink, side))
            if min(f0, f1) > maxd / 2 and max(f0, f1) > maxd and not _cuts_ink(np.rot90(ink, side), (d0, d1), (f0, f1)):
                d0, d1 = max(d0, f0), max(d1, f1)
        depths[side] = (d0, d1)
    # np.rot90 is counter-clockwise: k=1 puts the right edge on top (ends top->bottom), k=2 the bottom edge
    # (right->left), k=3 the left edge (bottom->top)
    t_l, t_r = depths[0]
    r_t, r_b = depths[1]
    b_r, b_l = depths[2]
    l_b, l_t = depths[3]
    new = np.array([[l_t, t_l], [W - 1 - r_t, t_r], [W - 1 - r_b, H - 1 - b_r], [l_b, H - 1 - b_l]], np.float32)
    trimmed = float(max(max(v) for v in depths.values()))
    if trimmed < 2:
        return [[float(x), float(y)] for x, y in q], {"trimmed": 0.0}
    back = cv2.perspectiveTransform(new.reshape(-1, 1, 2), np.linalg.inv(M)).reshape(4, 2)
    info = {"trimmed": round(trimmed / max(W, H), 4),
            "depths": {k: [round(a / (H if i % 2 == 0 else W), 3), round(b / (H if i % 2 == 0 else W), 3)]
                       for i, (k, (a, b)) in enumerate(zip(("top", "right", "bottom", "left"),
                                                           (depths[0], depths[1], depths[2], depths[3])))}}
    return [[float(x), float(y)] for x, y in back], info


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


def _profile_direction(g: np.ndarray) -> float:
    _, bw = cv2.threshold(g, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)
    rows = bw.sum(1).astype(np.float64)
    cols = bw.sum(0).astype(np.float64)
    sh = float(np.sum(np.diff(rows) ** 2)) / max(1, len(rows))
    sv = float(np.sum(np.diff(cols) ** 2)) / max(1, len(cols))
    return sh / (sv + 1e-9)


def line_direction(img: np.ndarray) -> dict:
    """Text lines horizontal vs vertical (cheap, language independent).

    Letters of a word are closer to each other than to the letters of the next line, so the direction to each
    character's nearest neighbour follows the text line. Projection profiles (the old method) were fooled by
    column layouts (receipts, tables). ratio > 1: horizontal lines."""
    small, _ = downscale(img, 2000)  # letters must stay separate: at 1000 px they merge into words
    g = gray(small)
    bw = cv2.adaptiveThreshold(cv2.GaussianBlur(g, (3, 3), 0), 255, cv2.ADAPTIVE_THRESH_MEAN_C,
                               cv2.THRESH_BINARY_INV, 31, 12)
    n, _, st, cen = cv2.connectedComponentsWithStats(bw, connectivity=8)
    keep = (st[:, 4] >= 10) & (st[:, 3] >= 5) & (st[:, 3] <= 80) & (st[:, 2] >= 2) & (st[:, 2] <= 80)
    keep[0] = False
    pts = cen[keep].astype(np.float32)
    if keep.sum() >= 30:
        hc = float(np.median(np.minimum(st[keep, 3], st[keep, 2] * 3)))
        lh, lv = _line_blob_length(bw, hc), _line_blob_length(np.ascontiguousarray(bw.T), hc)
        rm = (lh + hc) / (lv + hc)
    else:
        rm = 1.0
    if len(pts) < 30:
        r = _profile_direction(downscale(g, 1000)[0])
        return {"horizontal": r > 1.0, "ratio": round(r, 3), "method": "profile"}
    if len(pts) > 2000:
        pts = pts[np.random.default_rng(0).choice(len(pts), 2000, replace=False)]
    d = pts[:, None, :] - pts[None, :, :]
    dist = np.einsum("ijk,ijk->ij", d, d)
    np.fill_diagonal(dist, np.inf)
    nn = dist.argmin(1)
    v = np.abs(pts[nn] - pts)
    h = float(np.sum(v[:, 0] > v[:, 1]))
    rn = (h + 1) / (len(v) - h + 1)
    # two independent votes: nearest neighbours (good when letters are resolved) and line blobs (good when
    # low resolution merges letters into words); the geometric mean keeps the confident one
    r = math.sqrt(rn * rm)
    return {"horizontal": r > 1.0, "ratio": round(r, 3), "nn": round(rn, 3), "blobs": round(rm, 3),
            "method": "nn+blobs", "n": int(len(pts))}


def _line_blob_length(bw: np.ndarray, hc: float) -> float:
    """Total length of thin, elongated blobs after a horizontal closing that bridges letter/word gaps."""
    k = max(3, int(hc * 1.5))
    closed = cv2.morphologyEx(bw, cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_RECT, (k, 1)))
    n, _, st, _ = cv2.connectedComponentsWithStats(closed, connectivity=8)
    w, h = st[1:, 2], st[1:, 3]
    ok = (w >= 5 * h) & (h <= 2.5 * hc) & (h >= 0.5 * hc)
    return float(w[ok].sum())


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


def paper_fill(img: np.ndarray) -> tuple | float:
    """Colour of the paper (median of the brighter part of the page), used to fill areas a rotation adds."""
    small, _ = downscale(img, 400)
    g = gray(small)
    bright = small[g >= np.percentile(g, 60)]
    if small.ndim == 2:
        return float(np.median(bright))
    return tuple(float(v) for v in np.median(bright.reshape(-1, small.shape[2]), axis=0))


def rotate_small(img: np.ndarray, angle: float) -> np.ndarray:
    if abs(angle) < 0.05:
        return img
    h, w = img.shape[:2]
    M = cv2.getRotationMatrix2D((w / 2, h / 2), angle, 1.0)
    cos, sin = abs(M[0, 0]), abs(M[0, 1])
    nw, nh = int(h * sin + w * cos), int(h * cos + w * sin)
    M[0, 2] += nw / 2 - w / 2
    M[1, 2] += nh / 2 - h / 2
    # the corners the rotation adds are filled with the paper colour; BORDER_REPLICATE smeared the edge pixels
    # across them (stretched-pixel streaks along all four edges)
    return cv2.warpAffine(img, M, (nw, nh), flags=cv2.INTER_CUBIC, borderMode=cv2.BORDER_CONSTANT,
                          borderValue=paper_fill(img))


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
