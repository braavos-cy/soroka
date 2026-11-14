"""Resumable uploads: the UI sends a file in chunks to an upload session, can pause (stop sending) and resume
(ask how much arrived, continue from there) or cancel (delete the session), then hands the finished session ids
to /api/ingest instead of attaching the files. Sessions live under DATA_DIR/uploads; the scheduler removes
abandoned ones (see cleanup_stale)."""
import json
import re
import secrets
import time
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel

from ..config import settings
from ..deps import Principal, ingest_principal

router = APIRouter(prefix="/api/uploads", tags=["ingest"])

MAX_SIZE = 2 * 1024 ** 3  # same limit as a direct /api/ingest request (Caddyfile)
MAX_CHUNK = 16 * 1024 ** 2
STALE_SECONDS = 48 * 3600
_ID = re.compile(r"^[0-9a-f]{32}$")


def _dir() -> Path:
    d = Path(settings().data_dir) / "uploads"
    d.mkdir(parents=True, exist_ok=True)
    return d


def _owner(p: Principal) -> str:
    if p.user_id is not None:
        return f"user:{p.user_id}"
    if p.token is not None:
        return f"token:{p.token.id}"
    return "connector"


def _load(upload_id: str, p: Principal) -> tuple[dict, Path]:
    if not _ID.match(upload_id):
        raise HTTPException(404)
    meta_path = _dir() / f"{upload_id}.json"
    try:
        meta = json.loads(meta_path.read_text())
    except (OSError, ValueError):
        raise HTTPException(404, "upload_not_found")
    if meta["owner"] != _owner(p):
        raise HTTPException(404, "upload_not_found")
    return meta, _dir() / f"{upload_id}.part"


def _received(part: Path) -> int:
    try:
        return part.stat().st_size
    except OSError:
        return 0


class CreateIn(BaseModel):
    filename: str
    size: int


@router.post("")
def create(body: CreateIn, p: Principal = Depends(ingest_principal)):
    if body.size < 0 or body.size > MAX_SIZE:
        raise HTTPException(413, "file_too_large")
    upload_id = secrets.token_hex(16)
    (_dir() / f"{upload_id}.part").touch()
    (_dir() / f"{upload_id}.json").write_text(json.dumps(
        {"owner": _owner(p), "filename": body.filename[:500] or "file", "size": body.size, "created": time.time()}))
    return {"id": upload_id, "received": 0, "size": body.size}


@router.get("/{upload_id}")
def status(upload_id: str, p: Principal = Depends(ingest_principal)):
    meta, part = _load(upload_id, p)
    return {"id": upload_id, "received": _received(part), "size": meta["size"]}


@router.put("/{upload_id}")
async def put_chunk(upload_id: str, offset: int, request: Request, p: Principal = Depends(ingest_principal)):
    """Append a chunk at `offset`. A chunk for the wrong offset (e.g. a retry after a dropped connection)
    is refused with 409 and the current size, so the client continues from there."""
    meta, part = _load(upload_id, p)
    data = await request.body()
    if len(data) > MAX_CHUNK:
        raise HTTPException(413, "chunk_too_large")
    have = _received(part)
    if offset != have:
        raise HTTPException(409, {"code": "offset_mismatch", "received": have})
    if have + len(data) > meta["size"]:
        raise HTTPException(400, "more_than_announced")
    with open(part, "ab") as f:
        f.write(data)
    return {"received": have + len(data), "size": meta["size"]}


@router.delete("/{upload_id}")
def cancel(upload_id: str, p: Principal = Depends(ingest_principal)):
    _load(upload_id, p)
    discard(upload_id)
    return {"ok": True}


def discard(upload_id: str) -> None:
    for ext in (".part", ".json"):
        (_dir() / f"{upload_id}{ext}").unlink(missing_ok=True)


def take(upload_id: str, p: Principal) -> tuple[str, bytes]:
    """(filename, bytes) of a complete upload session, for /api/ingest."""
    meta, part = _load(upload_id, p)
    if _received(part) != meta["size"]:
        raise HTTPException(409, "upload_incomplete")
    return meta["filename"], part.read_bytes()


def cleanup_stale() -> int:
    """Remove sessions untouched for STALE_SECONDS (closed tab, abandoned pause)."""
    n = 0
    cutoff = time.time() - STALE_SECONDS
    for meta in _dir().glob("*.json"):
        part = meta.with_suffix(".part")
        last = max(meta.stat().st_mtime, part.stat().st_mtime if part.exists() else 0)
        if last < cutoff:
            discard(meta.stem)
            n += 1
    return n
