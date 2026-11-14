import json
from datetime import datetime

from fastapi import APIRouter, Depends, File, Form, HTTPException, Request, UploadFile
from pydantic import BaseModel
from sqlalchemy.orm import Session as DB

from .. import models as m
from ..db import get_db, now
from ..deps import Principal, audit, client_ip, connector, ingest_principal
from ..ingest import InFile, IngestMeta, IngestRejected, ingest
from ..search import index_document
from . import uploads

router = APIRouter(prefix="/api", tags=["ingest"])

META_FIELDS = set(IngestMeta.__dataclass_fields__)


@router.post("/ingest")
async def ingest_files(request: Request, files: list[UploadFile] | None = File(None), meta: str = Form("{}"),
                       upload_ids: str = Form("[]"),
                       p: Principal = Depends(ingest_principal), db: DB = Depends(get_db)):
    """Upload one or more files with metadata. Used by the UI, the browser extension and the bots.
    `meta` is a JSON object; see IngestMeta for fields. `upload_ids` (JSON list) names finished resumable upload
    sessions (/api/uploads) to ingest instead of, or in addition to, attached files."""
    try:
        raw = json.loads(meta or "{}")
    except json.JSONDecodeError:
        raise HTTPException(400, "bad_meta")
    raw = {k: v for k, v in raw.items() if k in META_FIELDS}
    if raw.get("sent_at"):
        raw["sent_at"] = datetime.fromisoformat(str(raw["sent_at"]).replace("Z", "+00:00"))
    md = IngestMeta(**raw)
    if not p.connector:
        # users may not impersonate bot sources; extension uses platform=email
        if md.platform not in ("upload", "email", "import"):
            md.platform = "upload"
        # §4.3: only bot mentions, private forwards and rescue force-save; uploads are classified like any
        # other item (a photo of a wall goes to Rejected, from where any user can rescue it)
        md.forced = False
        if md.priority not in ("high", "low"):
            md.priority = "high"
    try:
        ids = [str(x) for x in json.loads(upload_ids or "[]")]
    except (json.JSONDecodeError, TypeError):
        raise HTTPException(400, "bad_upload_ids")
    in_files = [InFile(f.filename or "file", await f.read()) for f in (files or [])]
    in_files += [InFile(*uploads.take(u, p)) for u in ids]
    if not in_files:
        raise HTTPException(400, "no_files")
    try:
        res = ingest(db, md, in_files, uploaded_by=p.user_id)
    except IngestRejected as e:
        raise HTTPException(409, str(e))
    for u in ids:
        uploads.discard(u)
    if p.user:
        audit(db, p, "upload", ",".join(str(d) for d in res["document_ids"]), client_ip(request),
              files=len(in_files))
        db.commit()
    return res


class ContextIn(BaseModel):
    messages: list[dict]


@router.post("/ingest/{event_id}/context")
def append_context(event_id: int, body: ContextIn, p: Principal = Depends(connector), db: DB = Depends(get_db)):
    """Bots append the 'after' part of the context window as messages arrive."""
    ev = db.get(m.IngestEvent, event_id)
    if ev is None:
        raise HTTPException(404)
    seen = {c.get("id") for c in ev.context or []}
    ev.context = list(ev.context or []) + [c for c in body.messages if c.get("id") not in seen]
    for d in db.query(m.Document).filter_by(ingest_event_id=ev.id).all():
        if d.status == "ready":
            index_document(db, d)
    db.commit()
    return {"ok": True}


# ---------------------------------------------------------------- connector control plane
class StatusIn(BaseModel):
    platform: str
    status: str
    detail: str = ""
    self_id: str = ""
    self_name: str = ""
    qr: str | None = None


@router.post("/connector/status")
def connector_status(body: StatusIn, p: Principal = Depends(connector), db: DB = Depends(get_db)):
    acc = db.query(m.ConnectorAccount).filter_by(platform=body.platform).one_or_none()
    if acc is None:
        acc = m.ConnectorAccount(platform=body.platform)
        db.add(acc)
    prev = acc.status
    acc.status, acc.status_detail, acc.qr = body.status, body.detail[:2000], body.qr
    if body.self_id:
        acc.self_id, acc.self_name = body.self_id, body.self_name
    acc.last_seen_at = now()
    if prev != body.status:
        db.add(m.AuditLog(action="connector_status", target=body.platform,
                          details={"from": prev, "to": body.status, "detail": body.detail[:500]}))
        if body.status == "connected":
            acc.alerted_at = None
    cmd = acc.pending_command
    acc.pending_command = None
    db.commit()
    return {"command": cmd}


@router.get("/connector/config")
def connector_config(platform: str, p: Principal = Depends(connector), db: DB = Depends(get_db)):
    chats = db.query(m.RegisteredChat).filter_by(platform=platform, active=True).all()
    codes = db.query(m.RegistrationCode).filter(m.RegistrationCode.platform == platform,
                                                m.RegistrationCode.expires_at > now(),
                                                m.RegistrationCode.used_chat_id.is_(None)).all()
    return {"chats": [{"chat_id": c.chat_id, "mode": c.mode, "ctx_before": c.ctx_before, "ctx_after": c.ctx_after,
                       "ctx_minutes": c.ctx_minutes} for c in chats],
            "registration_codes": [c.code for c in codes]}


class SeenIn(BaseModel):
    platform: str
    chats: list[dict]  # {chat_id, chat_name, is_group}


@router.post("/connector/seen-chats")
def seen_chats(body: SeenIn, p: Principal = Depends(connector), db: DB = Depends(get_db)):
    for c in body.chats:
        row = db.query(m.SeenChat).filter_by(platform=body.platform, chat_id=c["chat_id"]).one_or_none()
        if row is None:
            row = m.SeenChat(platform=body.platform, chat_id=c["chat_id"])
            db.add(row)
        row.chat_name = (c.get("chat_name") or row.chat_name or "")[:300]
        row.is_group = bool(c.get("is_group", True))
        row.last_seen_at = now()
        db.query(m.RegisteredChat).filter_by(platform=body.platform, chat_id=c["chat_id"]).update(
            {"chat_name": row.chat_name})
    db.commit()
    return {"ok": True}


class CodeSeenIn(BaseModel):
    platform: str
    code: str
    chat_id: str
    chat_name: str = ""


@router.post("/connector/registration-code")
def registration_code_seen(body: CodeSeenIn, p: Principal = Depends(connector), db: DB = Depends(get_db)):
    """The bot saw a one-time code in a chat. It never replies; confirmation shows in the admin UI."""
    rc = db.get(m.RegistrationCode, body.code.strip().upper())
    if rc is None or rc.platform != body.platform or rc.expires_at < now() or rc.used_chat_id:
        raise HTTPException(404)
    rc.used_chat_id = body.chat_id
    reg = db.query(m.RegisteredChat).filter_by(platform=body.platform, chat_id=body.chat_id).one_or_none()
    if reg is None:
        reg = m.RegisteredChat(platform=body.platform, chat_id=body.chat_id)
        db.add(reg)
    reg.chat_name, reg.folder_id, reg.tag_ids, reg.mode, reg.active = (
        body.chat_name[:300], rc.folder_id, rc.tag_ids, rc.mode, True)
    db.add(m.AuditLog(user_id=rc.created_by, action="chat_registered_by_code", target=body.chat_id,
                      details={"platform": body.platform, "chat_name": body.chat_name}))
    db.commit()
    return {"ok": True}
