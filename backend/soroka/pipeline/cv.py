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


def quad_iou(a: np.ndarray, b: np.ndarray) -> float:
    a, b = order_quad(a), order_quad(b)
    inter, _ = cv2.intersectConvexConvex(a, b)
    union = cv2.contourArea(a) + cv2.contourArea(b) - inter
    return float(inter / union) if union > 0 else 0.0


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


def detect_boundary(img: np.ndarray) -> tuple[list[Candidate], Candidate, str, dict]:
    """Returns (candidates, chosen, tier, signals). Quads are in full-resolution pixel coords."""
    small, s = downscale(img, 1000)
    g = gray(small)
    gx = cv2.Sobel(cv2.GaussianBlur(g, (3, 3), 0), cv2.CV_32F, 1, 0)
    gy = cv2.Sobel(cv2.GaussianBlur(g, (3, 3), 0), cv2.CV_32F, 0, 1)
    grad = cv2.magnitude(gx, gy)
    area_total = float(g.shape[0] * g.shape[1])
    H, W = img.shape[:2]
    full = np.array([[0, 0], [W - 1, 0], [W - 1, H - 1], [0, H - 1]], dtype=np.float32)

    cands: list[Candidate] = []
    raw = {}
    for name, fn in (("contour_canny", _quad_canny), ("contour_threshold", _quad_threshold)):
        q = fn(g)
        if q is None:
            continue
        q = order_quad(q)
        sc, sig = _score_quad(q, area_total, grad)
        raw[name] = q
        cands.append(Candidate(name, {"quad": (q / s).round(1).tolist()}, round(sc, 3), sig))

    agreement = quad_iou(raw["contour_canny"], raw["contour_threshold"]) if len(raw) == 2 else 0.0
    flat = _looks_flat_scan(small)
    big = max([c.signals["area"] for c in cands], default=0.0)
    ff_score = 0.85 if flat > 0.7 else (0.7 if not cands or big > 0.95 else 0.25)
    cands.append(Candidate("full_frame", {"quad": full.round(1).tolist()}, ff_score, {"flat_scan": round(flat, 2)}))

    if len(raw) == 2 and agreement > 0.9:  # fusion: agreeing methods -> average corners, boost
        fused = (order_quad(raw["contour_canny"]) + order_quad(raw["contour_threshold"])) / 2
        sc, sig = _score_quad(fused, area_total, grad)
        sig["agreement"] = round(agreement, 3)
        cands.append(Candidate("fused", {"quad": (fused / s).round(1).tolist()}, round(min(1.0, sc + 0.15), 3), sig))

    chosen = max(cands, key=lambda c: c.score)
    best_other = sorted((c.score for c in cands if c is not chosen), reverse=True)
    margin = chosen.score - (best_other[0] if best_other else 0)
    if chosen.score >= 0.75 and (chosen.method in ("fused", "full_frame") or margin > 0.15):
        tier = "high"
    elif chosen.score >= 0.55:
        tier = "medium"
    else:
        tier = "low"
    signals = {"agreement": round(agreement, 3), "flat_scan": round(flat, 2), "margin": round(margin, 3)}
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
