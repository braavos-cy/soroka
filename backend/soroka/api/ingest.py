import json
from datetime import datetime

from fastapi import APIRouter, Depends, File, Form, HTTPException, Request, UploadFile
from fastapi.concurrency import run_in_threadpool
from pydantic import BaseModel
from sqlalchemy.orm import Session as DB

from .. import models as m
from .. import appsettings, reactions
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
    # reading the uploaded files, hashing and storing them and the database work block: in a thread, so the API
    # keeps answering everyone else meanwhile (in the event loop a 100 MB upload froze every page for seconds,
    # far longer when the workers keep the disk busy)
    return await run_in_threadpool(_ingest_sync, request, p, db, md, ids, in_files)


def _ingest_sync(request: Request, p: Principal, db: DB, md: IngestMeta, ids: list[str],
                 in_files: list[InFile]) -> dict:
    in_files += [InFile(*uploads.take(u, p)) for u in ids]
    if not in_files:
        raise HTTPException(400, "no_files")
    try:
        res = ingest(db, md, in_files, uploaded_by=p.user_id)
    except IngestRejected as e:
        if str(e) in ("unsupported_type", "file_too_large"):  # these uploads can never succeed: free the space
            for u in ids:
                uploads.discard(u)
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


def forget_chats(db: DB, platform: str, reason: str, user_id: int | None = None) -> None:
    """The linked account is gone: drop its group list and its chat registrations. Caller commits."""
    db.query(m.SeenChat).filter_by(platform=platform).delete()
    names = [r.chat_name or r.chat_id for r in db.query(m.RegisteredChat).filter_by(platform=platform)]
    if names:
        db.query(m.RegisteredChat).filter_by(platform=platform).delete()
        db.add(m.AuditLog(user_id=user_id, action="chats_unregistered", target=platform,
                          details={"reason": reason, "chats": names[:100]}))


@router.post("/connector/status")
def connector_status(body: StatusIn, p: Principal = Depends(connector), db: DB = Depends(get_db)):
    acc = db.query(m.ConnectorAccount).filter_by(platform=body.platform).one_or_none()
    if acc is None:
        acc = m.ConnectorAccount(platform=body.platform)
        db.add(acc)
    prev = acc.status
    acc.status, acc.status_detail, acc.qr = body.status, body.detail[:2000], body.qr
    # Unlinked (waiting for a QR scan) or another account linked: the previous account's chats no longer apply,
    # registered ones included (documents stay).
    # An empty self_id alone means nothing: the connector also sends it while it is starting or reconnecting.
    unlinked = not body.self_id and body.status in ("qr", "logged_out")
    if unlinked or (body.self_id and acc.self_id and body.self_id != acc.self_id):
        forget_chats(db, body.platform, "account unlinked" if unlinked else "another account linked")
    if body.self_id or unlinked:
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
    leave = db.query(m.SeenChat).filter(m.SeenChat.platform == platform, m.SeenChat.leave_pending()).all()
    cmd = None
    acc = db.query(m.ConnectorAccount).filter_by(platform=platform).one_or_none()
    if acc is not None and acc.pending_command:  # handed over once (the status report can deliver it too)
        cmd, acc.pending_command = acc.pending_command, None
        db.commit()
    return {"command": cmd, "chats": [{"chat_id": c.chat_id, "mode": c.mode, "ctx_before": c.ctx_before, "ctx_after": c.ctx_after,
                       "ctx_minutes": c.ctx_minutes} for c in chats],
            # secret word that activates a person's private chat ("" = private chats cannot be activated)
            "private_code": appsettings.private_code(db, platform),
            "leave_chats": [s.chat_id for s in leave],
            "reactions": reactions.pending(db, platform)}


class ReactionsSentIn(BaseModel):
    platform: str
    event_ids: list[int]


@router.post("/connector/reactions-sent")
def reactions_sent(body: ReactionsSentIn, p: Principal = Depends(connector), db: DB = Depends(get_db)):
    """The connector tried these reactions (one attempt each, delivered or not): take them off the queue."""
    reactions.mark_sent(db, body.platform, body.event_ids)
    db.commit()
    return {"ok": True}


class LeftIn(BaseModel):
    platform: str
    chat_id: str
    error: str = ""


@router.post("/connector/left-chat")
def left_chat(body: LeftIn, p: Principal = Depends(connector), db: DB = Depends(get_db)):
    """Result of an admin's leave request. Only chats with a request are touched, so the connector cannot
    unregister chats on its own. On failure the request is dropped (no retries: repeated group queries risk a ban)."""
    s = db.query(m.SeenChat).filter_by(platform=body.platform, chat_id=body.chat_id).one_or_none()
    if s is None or s.leave_requested_at is None:
        raise HTTPException(404)
    details = {"platform": body.platform, "name": s.chat_name}
    if body.error:
        s.leave_requested_at = None
        db.add(m.AuditLog(action="chat_leave_failed", target=body.chat_id,
                          details={**details, "error": body.error[:500]}))
    else:
        db.query(m.RegisteredChat).filter_by(platform=body.platform, chat_id=body.chat_id).delete()
        db.delete(s)
        db.add(m.AuditLog(action="chat_left", target=body.chat_id, details=details))
    db.commit()
    return {"ok": True}


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


class PrivateActivateIn(BaseModel):
    platform: str
    code: str
    chat_id: str
    chat_name: str = ""


@router.post("/connector/private-activate")
def private_activate(body: PrivateActivateIn, p: Principal = Depends(connector), db: DB = Depends(get_db)):
    """A person sent the secret word in their private chat with the bot: from now on files they send are saved.
    The word is checked here again; the chat shows in the admin UI with the registered ones (removable there)."""
    secret = appsettings.normalize_code(appsettings.private_code(db, body.platform))
    if not secret or appsettings.normalize_code(body.code) != secret or body.chat_id.endswith("@g.us"):
        raise HTTPException(403, "wrong_code")
    reg = db.query(m.RegisteredChat).filter_by(platform=body.platform, chat_id=body.chat_id).one_or_none()
    if reg is None:
        reg = m.RegisteredChat(platform=body.platform, chat_id=body.chat_id, ctx_before=0, ctx_after=0)
        db.add(reg)
    reg.chat_name, reg.active = body.chat_name[:300], True
    db.add(m.AuditLog(action="private_chat_activated", target=body.chat_id,
                      details={"platform": body.platform, "chat_name": body.chat_name}))
    db.commit()
    return {"ok": True}

