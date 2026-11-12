"""Common ingestion (requirements §3.1): every incoming item becomes an ingest_event + documents."""
import io
import os
import re
import zipfile
from dataclasses import dataclass, field
from datetime import datetime
from urllib.parse import unquote

from sqlalchemy import text
from sqlalchemy.orm import Session as DB

from . import models as m
from .formats import sniff
from .jobs import enqueue_document
from .storage import storage

BOT_PLATFORMS = {"whatsapp", "telegram"}
MAX_ZIP_FILES = 20000
_PCT = re.compile(r"%[0-9A-Fa-f]{2}")


def decode_name(name: str) -> str:
    """Undo URL-encoding some senders apply to file names ("%D0%96%20N%C2%BA" -> "Ж Nº")."""
    name = (name or "").strip()
    if _PCT.search(name):
        try:
            dec = unquote(name, errors="strict")
            if dec and "\ufffd" not in dec:
                return dec
        except UnicodeDecodeError:
            pass
    return name


def with_extension(title: str, filename: str) -> str:
    """Make sure a default title shows the file's extension ("Contract" + "x.pdf" -> "Contract.pdf")."""
    ext = os.path.splitext(filename)[1]
    if ext and not title.lower().endswith(ext.lower()):
        title = title.rstrip(". ") + ext
    return title


@dataclass
class InFile:
    filename: str
    data: bytes


@dataclass
class IngestMeta:
    platform: str = "upload"
    chat_id: str = ""
    chat_name: str = ""
    message_id: str = ""
    message_link: str = ""
    sender_id: str = ""
    sender_name: str = ""
    sender_phone: str = ""
    sender_username: str = ""
    sender_email: str = ""
    sent_at: datetime | None = None
    location: dict | None = None
    forwarded: bool = False
    forward_info: dict | None = None
    caption: str = ""
    reply_to: dict | None = None
    context: list = field(default_factory=list)
    extra: dict = field(default_factory=dict)
    forced: bool = False
    force_reason: str = ""  # mention_caption | mention_reply | private_forward | rescue
    # destination (uploads / extension); bots use chat registration
    folder_id: int | None = None
    tag_ids: list[int] = field(default_factory=list)
    combine: bool = False  # one document from all files
    priority: str = "high"
    title: str = ""


class IngestRejected(Exception):
    pass


def _resolve_destination(db: DB, meta: IngestMeta) -> tuple[int | None, list[int]]:
    folder_id, tag_ids = meta.folder_id, list(meta.tag_ids)
    if meta.platform in BOT_PLATFORMS:
        reg = db.query(m.RegisteredChat).filter_by(platform=meta.platform, chat_id=meta.chat_id, active=True).first()
        if reg is None and meta.force_reason != "private_forward":
            raise IngestRejected("chat_not_registered")
        if reg is not None:
            if reg.mode == "override" and not meta.forced:
                raise IngestRejected("override_only_chat")
            folder_id = reg.folder_id or folder_id
            tag_ids = list(reg.tag_ids or []) + tag_ids
    if folder_id is not None and db.get(m.Folder, folder_id) is None:
        folder_id = None  # no folder
    valid_tags = {t for (t,) in db.query(m.Tag.id).filter(m.Tag.id.in_(tag_ids or [-1])).all()}
    return folder_id, [t for t in dict.fromkeys(tag_ids) if t in valid_tags]


def _ensure_folder_path(db: DB, root_id: int | None, parts: list[str]) -> int | None:
    fid = root_id
    for name in parts:
        name = name.strip()[:300]
        if not name:
            continue
        f = db.query(m.Folder).filter_by(parent_id=fid, name=name).first()
        if f is None:
            f = m.Folder(parent_id=fid, name=name)
            db.add(f)
            db.flush()
        fid = f.id
    return fid


def expand_zip(data: bytes) -> list[tuple[list[str], InFile]]:
    out = []
    with zipfile.ZipFile(io.BytesIO(data)) as z:
        infos = [i for i in z.infolist() if not i.is_dir()][:MAX_ZIP_FILES]
        for i in infos:
            name = i.filename
            try:  # zip files from Windows often use cp866 for Cyrillic names
                if not (i.flag_bits & 0x800):
                    name = i.filename.encode("cp437").decode("cp866")
            except (UnicodeEncodeError, UnicodeDecodeError):
                pass
            parts = [p for p in name.replace("\\", "/").split("/") if p]
            if not parts or parts[-1].startswith(".") or "__MACOSX" in parts:
                continue
            out.append((parts[:-1], InFile(parts[-1], z.read(i))))
    return out


def ingest(db: DB, meta: IngestMeta, files: list[InFile], uploaded_by: int | None = None,
           preserve_zip_structure: bool = True) -> dict:
    folder_id, tag_ids = _resolve_destination(db, meta)
    ev = m.IngestEvent(
        platform=meta.platform, chat_id=meta.chat_id, chat_name=meta.chat_name, message_id=meta.message_id,
        message_link=meta.message_link, sender_id=meta.sender_id, sender_name=meta.sender_name,
        sender_phone=meta.sender_phone, sender_username=meta.sender_username, sender_email=meta.sender_email,
        uploaded_by=uploaded_by, sent_at=meta.sent_at, location=meta.location, forwarded=meta.forwarded,
        forward_info=meta.forward_info, caption=meta.caption, reply_to=meta.reply_to, context=meta.context,
        extra=meta.extra, forced=meta.forced, force_reason=meta.force_reason)
    db.add(ev)
    db.flush()

    # expand zips into (folder, file) groups
    groups: dict[int | None, list[InFile]] = {}
    skipped: list[dict] = []
    for f in files:
        kind, _ = sniff(f.filename, f.data)
        if kind == "zip":
            for parts, inner in expand_zip(f.data):
                fid = _ensure_folder_path(db, folder_id, parts) if preserve_zip_structure else folder_id
                groups.setdefault(fid, []).append(inner)
        else:
            groups.setdefault(folder_id, []).append(f)

    created, duplicates = [], []
    seen_sha: set[str] = set()
    for fid, flist in groups.items():
        stored: list[m.FileOriginal] = []
        for f in flist:
            kind, mime = sniff(f.filename, f.data)
            if kind in ("unsupported", "zip"):
                skipped.append({"filename": f.filename, "reason": "unsupported_type"})
                continue
            key, sha = storage().put_original(f.data)
            dup = _find_duplicate(db, sha)
            fo = m.FileOriginal(ingest_event_id=ev.id, blob_key=key, sha256=sha, mime=mime,
                                filename=decode_name(os.path.basename(f.filename))[:500], size=len(f.data))
            db.add(fo)
            db.flush()
            if (dup is not None or sha in seen_sha) and not meta.combine:
                duplicates.append({"filename": fo.filename, "document_id": dup})
                continue
            seen_sha.add(sha)
            stored.append(fo)
        batches = [stored] if (meta.combine and stored) else [[s] for s in stored]
        for batch in batches:
            title = decode_name(meta.title) or batch[0].filename
            if meta.platform in BOT_PLATFORMS and not meta.title and batch[0].filename.startswith(("IMG", "image")):
                title = (meta.caption or "").strip()[:120] or title
            title = with_extension(title, batch[0].filename)
            doc = m.Document(title=title[:500], folder_id=fid, ingest_event_id=ev.id, source_platform=meta.platform,
                             received_at=ev.ingested_at, document_date=meta.sent_at,
                             source_file_ids=[b.id for b in batch], queue=meta.priority)
            db.add(doc)
            db.flush()
            for t in tag_ids:
                db.add(m.DocumentTag(document_id=doc.id, tag_id=t))
            created.append(doc.id)
    db.commit()
    for d in created:
        enqueue_document(d, meta.priority)
    return {"ingest_event_id": ev.id, "document_ids": created, "duplicates": duplicates, "skipped": skipped}


def _find_duplicate(db: DB, sha: str) -> int | None:
    row = db.execute(text(
        "SELECT d.id FROM document d JOIN file_original f ON f.sha256 = :sha "
        "AND d.source_file_ids @> jsonb_build_array(f.id) "
        "WHERE d.trashed_at IS NULL AND d.status NOT IN ('rejected', 'infected') LIMIT 1"), {"sha": sha}).first()
    return row[0] if row else None
