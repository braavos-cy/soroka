"""Stage 0: decode and normalize sources into pages (images, PDF pages, office via LibreOffice)."""
import io
import os
import subprocess
import tempfile

import cv2
import numpy as np
import pypdfium2 as pdfium
from PIL import Image, ImageOps, ImageSequence

try:
    import pillow_heif
    pillow_heif.register_heif_opener()
except ImportError:  # pragma: no cover
    pass

MAX_PIXELS = 60_000_000
Image.MAX_IMAGE_PIXELS = 200_000_000


def decode_images(data: bytes) -> list[np.ndarray]:
    """All frames for multi-page TIFF, first frame for GIF; EXIF orientation applied (and thus stripped)."""
    im = Image.open(io.BytesIO(data))
    fmt = (im.format or "").upper()
    frames = [im] if fmt == "GIF" else list(ImageSequence.Iterator(im))
    out = []
    for fr in frames:
        try:
            fr = ImageOps.exif_transpose(fr)  # returns a transposed copy; EXIF orientation dropped
        except Exception:  # noqa: BLE001 - broken EXIF must not block ingest
            fr = fr.copy()
        if fr.mode in ("RGBA", "LA", "P"):
            fr = fr.convert("RGBA")
            bg = Image.new("RGB", fr.size, (255, 255, 255))
            bg.paste(fr, mask=fr.split()[-1])
            fr = bg
        elif fr.mode != "RGB":
            fr = fr.convert("RGB")
        if fr.width * fr.height > MAX_PIXELS:
            s = (MAX_PIXELS / (fr.width * fr.height)) ** 0.5
            fr = fr.resize((int(fr.width * s), int(fr.height * s)), Image.LANCZOS)
        out.append(cv2.cvtColor(np.asarray(fr), cv2.COLOR_RGB2BGR))
    return out


def encode_image(img: np.ndarray, photo: bool) -> tuple[bytes, str]:
    if photo:
        ok, buf = cv2.imencode(".jpg", img, [cv2.IMWRITE_JPEG_QUALITY, 95])
        return buf.tobytes(), "jpg"
    ok, buf = cv2.imencode(".png", img, [cv2.IMWRITE_PNG_COMPRESSION, 3])
    return buf.tobytes(), "png"


def _page_has_text(page) -> bool:
    tp = page.get_textpage()
    txt = tp.get_text_bounded() or ""
    tp.close()
    return sum(ch.isalnum() for ch in txt) >= 30 and text_layer_garbage(txt) < 0.08


def _render_scan(page) -> np.ndarray:
    w, h = page.get_size()
    scale = 300 / 72
    if w * h * scale * scale > MAX_PIXELS:
        scale = (MAX_PIXELS / (w * h)) ** 0.5
    bmp = page.render(scale=scale)
    return cv2.cvtColor(np.asarray(bmp.to_pil().convert("RGB")), cv2.COLOR_RGB2BGR)


def pdf_page_kinds(data: bytes) -> list[dict]:
    """Per page: has a real text layer? -> pdf_text, else image (rendered later, per page, by render_pdf_scan).
    Cheap: nothing is rendered, so a 200-page scan is split in seconds and without holding 200 bitmaps."""
    doc = pdfium.PdfDocument(data)
    try:
        out = []
        for i in range(len(doc)):
            page = doc[i]
            out.append({"kind": "pdf_text" if _page_has_text(page) else "image", "index": i})
            page.close()
        return out
    finally:
        doc.close()


def render_pdf_scan(data: bytes, index: int) -> np.ndarray:
    """One image page of a PDF at 300 dpi (capped at MAX_PIXELS)."""
    doc = pdfium.PdfDocument(data)
    try:
        page = doc[index]
        try:
            return _render_scan(page)
        finally:
            page.close()
    finally:
        doc.close()


def render_pdf_page(data: bytes, index: int, dpi: int = 150) -> np.ndarray:
    doc = pdfium.PdfDocument(data)
    try:
        page = doc[index]
        img = page.render(scale=dpi / 72).to_pil().convert("RGB")
        page.close()
        return cv2.cvtColor(np.asarray(img), cv2.COLOR_RGB2BGR)
    finally:
        doc.close()


def pdf_page_words(data: bytes, index: int, dpi: int = 150) -> tuple[str, list[dict]]:
    """Text and word boxes (in pixels at `dpi`) from a PDF text layer."""
    doc = pdfium.PdfDocument(data)
    try:
        page = doc[index]
        _, ph = page.get_size()
        tp = page.get_textpage()
        n = tp.count_chars()
        text = tp.get_text_bounded() or ""
        s = dpi / 72
        words, cur, box, line = [], [], None, 0
        prev_y = None

        def flush():
            if cur:
                x0, y0, x1, y1 = box
                words.append({"text": "".join(cur), "conf": 100.0, "line": line, "block": 1, "par": 1,
                              "box": [int(x0 * s), int((ph - y1) * s), int((x1 - x0) * s), int((y1 - y0) * s)]})

        for i in range(n):
            ch = tp.get_text_range(i, 1)
            if not ch or ch.isspace():
                flush()
                cur, box = [], None
                if ch in ("\n", "\r"):
                    line += 1
                continue
            l, b, r, t = tp.get_charbox(i)
            if prev_y is not None and abs(b - prev_y) > (t - b) * 0.8 and cur:
                flush()
                cur, box = [], None
                line += 1
            prev_y = b
            cur.append(ch)
            box = (l, b, r, t) if box is None else (min(box[0], l), min(box[1], b), max(box[2], r), max(box[3], t))
        flush()
        tp.close()
        page.close()
        return text, words
    finally:
        doc.close()


_BOMS = ((b"\xef\xbb\xbf", "utf-8"), (b"\xff\xfe\x00\x00", "utf-32-le"), (b"\x00\x00\xfe\xff", "utf-32-be"),
         (b"\xff\xfe", "utf-16-le"), (b"\xfe\xff", "utf-16-be"))


def decode_text(data: bytes) -> tuple[str, str]:
    """A plain-text file as (text, encoding). A BOM decides; else UTF-8 when it decodes; else the legacy
    single-byte encoding (Russian Windows / DOS, Latin) whose result has the most letters."""
    for bom, enc in _BOMS:
        if data.startswith(bom):
            return _clean_text(data[len(bom):].decode(enc, errors="replace")), enc
    try:
        return _clean_text(data.decode("utf-8")), "utf-8"
    except UnicodeDecodeError:
        pass

    def score(s: str) -> float:
        # Cyrillic decoded with the wrong code page mixes case oddly and box-drawing / symbol characters; the right
        # one gives mostly letters, with lowercase after lowercase
        letters = sum(c.isalpha() for c in s)
        odd = sum(not (c.isalnum() or c.isspace() or c in ".,;:!?-–—()[]\"'«»№%/\\+=*&@#$_<>|~`^{}") for c in s)
        low_pairs = sum(a.islower() and b.islower() for a, b in zip(s, s[1:]))
        return letters + low_pairs - 3 * odd

    cands = [(data.decode(enc, errors="replace"), enc) for enc in ("cp1251", "cp866", "koi8-r", "cp1252")]
    best = max(cands, key=lambda c: score(c[0][:20000]))
    return _clean_text(best[0]), best[1]


def _clean_text(s: str) -> str:
    return s.replace("\r\n", "\n").replace("\r", "\n").replace("\x00", "")


def office_to_pdf(data: bytes, filename: str) -> bytes:
    ext = os.path.splitext(filename)[1].lower() or ".bin"
    with tempfile.TemporaryDirectory() as d:
        src = os.path.join(d, "input" + ext)
        with open(src, "wb") as f:
            f.write(data)
        prof = f"file://{d}/profile"
        r = subprocess.run(["soffice", f"-env:UserInstallation={prof}", "--headless", "--norestore",
                            "--convert-to", "pdf", "--outdir", d, src], capture_output=True, timeout=300)
        out = os.path.join(d, "input.pdf")
        if r.returncode != 0 or not os.path.exists(out):
            raise RuntimeError("libreoffice conversion failed: " + r.stderr.decode(errors="replace")[-300:])
        with open(out, "rb") as f:
            return f.read()


_TOKEN = __import__("re").compile(r"\S+")


def text_layer_garbage(text: str) -> float:
    """Share of suspicious tokens in a PDF text layer (broken font encodings produce e.g. 'tloeOfpOylmReno',
    'E9ATERINA', 'o:nership'). High values -> ignore the text layer and OCR the page image instead."""
    toks = [t.strip(".,;:()[]\"'«»!?") for t in _TOKEN.findall(text)]
    toks = [t for t in toks if len(t) >= 4 and any(c.isalpha() for c in t)]
    if not toks:
        return 0.0
    bad = 0
    for t in toks:
        inner_upper = any(a.islower() and b.isupper() for a, b in zip(t, t[1:]))
        digit_in_word = any(c.isdigit() for c in t) and sum(c.isalpha() for c in t) >= 3 and \
            any(a.isalpha() and b.isdigit() and c.isalpha() for a, b, c in zip(t, t[1:], t[2:]))
        punct_in_word = any(a.isalpha() and b in ":;|" and c.isalpha() for a, b, c in zip(t, t[1:], t[2:]))
        bad += inner_upper or digit_in_word or punct_in_word
    return bad / len(toks)
