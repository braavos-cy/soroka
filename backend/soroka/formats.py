"""File type detection by content (magic bytes) with extension fallback."""
import os

IMAGE_EXT = {".jpg", ".jpeg", ".png", ".heic", ".heif", ".webp", ".tif", ".tiff", ".bmp", ".gif", ".avif"}
OFFICE_EXT = {".docx", ".doc", ".xlsx", ".xls", ".pptx", ".ppt", ".odt", ".ods", ".odp", ".rtf", ".txt", ".csv"}
ZIP_OFFICE = {".docx", ".xlsx", ".pptx", ".odt", ".ods", ".odp"}


def sniff(filename: str, data: bytes) -> tuple[str, str]:
    """Returns (kind, mime). kind: image | pdf | office | zip | unsupported"""
    ext = os.path.splitext(filename.lower())[1]
    h = data[:32]
    if h.startswith(b"%PDF") or b"%PDF-" in data[:1024]:
        return "pdf", "application/pdf"
    if h.startswith(b"\xff\xd8\xff"):
        return "image", "image/jpeg"
    if h.startswith(b"\x89PNG"):
        return "image", "image/png"
    if h[:4] == b"RIFF" and h[8:12] == b"WEBP":
        return "image", "image/webp"
    if h[:4] in (b"II*\x00", b"MM\x00*"):
        return "image", "image/tiff"
    if h[:2] == b"BM":
        return "image", "image/bmp"
    if h[:6] in (b"GIF87a", b"GIF89a"):
        return "image", "image/gif"
    if h[4:8] == b"ftyp":
        brand = h[8:12]
        if brand in (b"avif", b"avis"):
            return "image", "image/avif"
        if brand in (b"heic", b"heix", b"mif1", b"msf1", b"heim", b"heis", b"hevc"):
            return "image", "image/heic"
    if h.startswith(b"PK\x03\x04"):
        if ext in ZIP_OFFICE:
            return "office", _office_mime(ext)
        return "zip", "application/zip"
    if h.startswith(b"\xd0\xcf\x11\xe0"):  # OLE: doc/xls/ppt
        return ("office", _office_mime(ext)) if ext in OFFICE_EXT else ("office", "application/msword")
    if h.startswith(b"{\\rtf"):
        return "office", "application/rtf"
    if ext in (".txt", ".csv"):
        return "office", "text/csv" if ext == ".csv" else "text/plain"
    return "unsupported", "application/octet-stream"


def _office_mime(ext: str) -> str:
    return {
        ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        ".odt": "application/vnd.oasis.opendocument.text",
        ".ods": "application/vnd.oasis.opendocument.spreadsheet",
        ".odp": "application/vnd.oasis.opendocument.presentation",
        ".doc": "application/msword", ".xls": "application/vnd.ms-excel",
        ".ppt": "application/vnd.ms-powerpoint", ".rtf": "application/rtf",
    }.get(ext, "application/octet-stream")
