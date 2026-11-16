"""Admin: users, settings, audit log, connectors, chat registration, system status, export."""
import io
import json
import secrets
import shutil
import zipfile
from datetime import timedelta

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import Response
from pydantic import BaseModel
from sqlalchemy import Text, cast, func, or_
from sqlalchemy.orm import Session as DB

from .. import appsettings
from .. import models as m
from ..db import get_db, now
from ..deps import Principal, admin, admin_reauth, audit, client_ip
from ..jobs import queue_lengths
from ..security import check_password_policy, hash_password
from ..storage import storage
from .auth import user_out

router = APIRouter(prefix="/api/admin", tags=["admin"])


# ---------------------------------------------------------------- users
@router.get("/users")
def users(p: Principal = Depends(admin), db: DB = Depends(get_db)):
    return [user_out(u) for u in db.query(m.User).order_by(m.User.email).all()]


class UserIn(BaseModel):
    email: str
    name: str = ""
    role: str = "user"
    password: str


@router.post("/users")
def create_user(body: UserIn, request: Request, p: Principal = Depends(admin), db: DB = Depends(get_db)):
    """Invite: admin sets a temporary password; the user must change it and enrol 2FA at first login."""
    email = body.email.strip().lower()
    if "@" not in email:
        raise HTTPException(400, "bad_email")
    if db.query(m.User).filter_by(email=email).first():
        raise HTTPException(409, "user_exists")
    if err := check_password_policy(body.password, email):
        raise HTTPException(400, err)
    u = m.User(email=email, name=body.name[:200], role="admin" if body.role == "admin" else "user",
               password_hash=hash_password(body.password), must_change_password=True)
    db.add(u)
    db.flush()
    audit(db, p, "user_created", email, client_ip(request), role=u.role)
    db.commit()
    return {"id": u.id}


class UserPatch(BaseModel):
    name: str | None = None
    role: str | None = None
    is_active: bool | None = None
    reset_2fa: bool = False
    password: str | None = None
    unlock: bool = False


@router.patch("/users/{uid}")
def update_user(uid: int, body: UserPatch, request: Request, p: Principal = Depends(admin), db: DB = Depends(get_db)):
    u = db.get(m.User, uid)
    if u is None:
        raise HTTPException(404)
    if u.id == p.user.id and (body.role == "user" or body.is_active is False):
        raise HTTPException(400, "cannot_demote_self")
    changes = {}
    if body.name is not None:
        u.name = body.name[:200]
    if body.role in ("user", "admin"):
        u.role = changes["role"] = body.role
    if body.is_active is not None:
        u.is_active = changes["is_active"] = body.is_active
        if not body.is_active:
            db.query(m.Session).filter_by(user_id=u.id).delete()
    if body.reset_2fa:
        u.totp_enabled, u.totp_secret, u.recovery_codes = False, None, []
        db.query(m.Session).filter_by(user_id=u.id).delete()
        changes["reset_2fa"] = True
    if body.password:
        if err := check_password_policy(body.password, u.email):
            raise HTTPException(400, err)
        u.password_hash, u.must_change_password = hash_password(body.password), True
        db.query(m.Session).filter_by(user_id=u.id).delete()
        changes["password_reset"] = True
    if body.unlock:
        u.locked_until, u.failed_logins = None, 0
        changes["unlocked"] = True
    audit(db, p, "user_updated", u.email, client_ip(request), **changes)
    db.commit()
    return {"ok": True}


@router.delete("/users/{uid}")
def delete_user(uid: int, request: Request, p: Principal = Depends(admin_reauth), db: DB = Depends(get_db)):
    u = db.get(m.User, uid)
    if u is None:
        raise HTTPException(404)
    if u.id == p.user.id:
        raise HTTPException(400, "cannot_delete_self")
    audit(db, p, "user_deleted", u.email, client_ip(request))
    db.delete(u)
    db.commit()
    return {"ok": True}


# ---------------------------------------------------------------- settings
@router.get("/settings")
def get_settings(p: Principal = Depends(admin), db: DB = Depends(get_db)):
    return appsettings.all_settings(db)


@router.put("/settings")
def put_settings(body: dict, request: Request, p: Principal = Depends(admin), db: DB = Depends(get_db)):
    before = appsettings.all_settings(db)
    if body.get("require_2fa") is False and before.get("require_2fa"):
        # weakening security requires a fresh re-auth
        from ..deps import require_reauth
        require_reauth(p)
    appsettings.set_many(db, body)
    after = appsettings.all_settings(db)
    audit(db, p, "settings_changed", "", client_ip(request),
          changes={k: [before.get(k), v] for k, v in after.items() if before.get(k) != v})
    db.commit()
    return after


# ---------------------------------------------------------------- audit log
@router.get("/audit")
def audit_log(offset: int = 0, limit: int = 50, q: str = "", p: Principal = Depends(admin),
              db: DB = Depends(get_db)):
    """One page of the log, newest first. `q` matches any field: user, action, target, details, IP, date."""
    query = db.query(m.AuditLog, m.User.email).outerjoin(m.User, m.User.id == m.AuditLog.user_id)
    for word in q.split()[:8]:  # every word must appear somewhere in the row
        like = "%" + word.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"
        query = query.filter(or_(*[c.ilike(like, escape="\\") for c in (
            m.AuditLog.action, m.AuditLog.target, m.AuditLog.ip, m.User.email,
            cast(m.AuditLog.details, Text), cast(m.AuditLog.at, Text))]))
    total = query.count()
    rows = query.order_by(m.AuditLog.id.desc()).offset(max(0, offset)).limit(max(1, min(limit, 200))).all()
    return {"total": total, "items": [
        {"id": a.id, "at": a.at, "user": email, "action": a.action, "target": a.target, "details": a.details,
         "ip": a.ip} for a, email in rows]}


# ---------------------------------------------------------------- connectors
@router.get("/connectors")
def connectors(p: Principal = Depends(admin), db: DB = Depends(get_db)):
    out = []
    for platform in ("whatsapp", "telegram"):
        acc = db.query(m.ConnectorAccount).filter_by(platform=platform).one_or_none()
        stale = acc is None or acc.last_seen_at is None or now() - acc.last_seen_at > timedelta(minutes=2)
        out.append({"platform": platform, "status": "offline" if stale else acc.status,
                    "reported_status": acc.status if acc else None, "detail": acc.status_detail if acc else "",
                    "self_id": acc.self_id if acc else "", "self_name": acc.self_name if acc else "",
                    "qr": acc.qr if acc and not stale else None,
                    "unlinking": bool(acc and acc.pending_command == "logout" and not stale), "last_seen_at": acc.last_seen_at if acc else None,
                    "private_code": appsettings.private_code(db, platform)})
    return out


class PrivateCodeIn(BaseModel):
    code: str = ""


@router.put("/connectors/{platform}/private-code")
def set_private_code(platform: str, body: PrivateCodeIn, request: Request, p: Principal = Depends(admin),
                     db: DB = Depends(get_db)):
    """The secret word a person sends to the bot to activate their private chat ("" = no new activations).
    Chats activated before stay active: deactivate them in the chat list. The word itself is not logged."""
    if platform not in ("whatsapp", "telegram"):
        raise HTTPException(404)
    code = " ".join(body.code.split())[:100]
    key = appsettings.private_code_key(platform)
    row = db.get(m.Setting, key)
    if row is None:
        db.add(m.Setting(key=key, value=code))
    else:
        row.value = code
    audit(db, p, "private_code_changed", platform, client_ip(request), enabled=bool(code))
    db.commit()
    return {"private_code": code}


@router.post("/connectors/{platform}/logout")
def connector_logout(platform: str, request: Request, p: Principal = Depends(admin), db: DB = Depends(get_db)):
    """Unlink the current account; the connector shows a new QR code for (re-)linking."""
    acc = db.query(m.ConnectorAccount).filter_by(platform=platform).one_or_none()
    if acc is None:
        raise HTTPException(404)
    acc.pending_command = "logout"
    from .ingest import forget_chats
    forget_chats(db, platform, "unlinked by admin", p.user_id)  # the account's chats go with it
    audit(db, p, "connector_logout", platform, client_ip(request))
    db.commit()
    return {"ok": True}


@router.get("/chats")
def chats(p: Principal = Depends(admin), db: DB = Depends(get_db)):
    reg = db.query(m.RegisteredChat).order_by(m.RegisteredChat.platform, m.RegisteredChat.chat_name).all()
    regkeys = {(r.platform, r.chat_id) for r in reg}
    seen = db.query(m.SeenChat).order_by(m.SeenChat.last_seen_at.desc()).all()
    counts = dict(db.query(m.IngestEvent.chat_id, func.count()).group_by(m.IngestEvent.chat_id).all())
    cutoff = now() - m.LEAVE_TTL
    leaving = {(s.platform, s.chat_id) for s in seen if s.leave_requested_at and s.leave_requested_at > cutoff}
    return {
        "registered": [{"id": r.id, "platform": r.platform, "chat_id": r.chat_id, "chat_name": r.chat_name,
                        "folder_id": r.folder_id, "tag_ids": r.tag_ids, "ctx_before": r.ctx_before,
                        "ctx_after": r.ctx_after, "ctx_minutes": r.ctx_minutes, "mode": r.mode, "active": r.active,
                        "reactions": r.reactions, "events": counts.get(r.chat_id, 0), "leaving": (r.platform, r.chat_id) in leaving}
                       for r in reg],
        "unregistered": [{"platform": s.platform, "chat_id": s.chat_id, "chat_name": s.chat_name,
                          "is_group": s.is_group, "last_seen_at": s.last_seen_at,
                          "leaving": (s.platform, s.chat_id) in leaving}
                         for s in seen if (s.platform, s.chat_id) not in regkeys],
    }


class LeaveIn(BaseModel):
    platform: str
    chat_id: str


@router.post("/chats/leave")
def leave_chat(body: LeaveIn, request: Request, p: Principal = Depends(admin), db: DB = Depends(get_db)):
    """Make the bot leave a group chat. The connector picks the request up with its next config poll, leaves,
    and reports back (/api/connector/left-chat); the chat is then unregistered. Documents are kept."""
    s = db.query(m.SeenChat).filter_by(platform=body.platform, chat_id=body.chat_id).one_or_none()
    r = db.query(m.RegisteredChat).filter_by(platform=body.platform, chat_id=body.chat_id).one_or_none()
    if s is None:
        if r is None:
            raise HTTPException(404)
        s = m.SeenChat(platform=r.platform, chat_id=r.chat_id, chat_name=r.chat_name)  # registered by code
        db.add(s)
    acc = db.query(m.ConnectorAccount).filter_by(platform=body.platform).one_or_none()
    if acc is None or acc.status != "connected" or acc.last_seen_at is None \
            or now() - acc.last_seen_at > timedelta(minutes=2):
        raise HTTPException(409, "connector_offline")
    s.leave_requested_at = now()
    audit(db, p, "chat_leave_requested", s.chat_id, client_ip(request), platform=s.platform, name=s.chat_name)
    db.commit()
    return {"ok": True}


class ChatIn(BaseModel):
    platform: str
    chat_id: str
    chat_name: str = ""
    folder_id: int | None = None
    tag_ids: list[int] = []
    ctx_before: int = 5
    ctx_after: int = 5
    ctx_minutes: int = 10
    mode: str = "auto"
    active: bool = True
    reactions: bool = True


@router.post("/chats")
def register_chat(body: ChatIn, request: Request, p: Principal = Depends(admin), db: DB = Depends(get_db)):
    r = db.query(m.RegisteredChat).filter_by(platform=body.platform, chat_id=body.chat_id).one_or_none()
    if r is None:
        r = m.RegisteredChat(platform=body.platform, chat_id=body.chat_id)
        db.add(r)
    _apply_chat(r, body)
    audit(db, p, "chat_registered", body.chat_id, client_ip(request), platform=body.platform, name=body.chat_name)
    db.commit()
    return {"id": r.id}


def _apply_chat(r: m.RegisteredChat, body: ChatIn) -> None:
    r.chat_name = body.chat_name[:300] or r.chat_name
    r.folder_id, r.tag_ids = body.folder_id, body.tag_ids
    r.ctx_before, r.ctx_after = max(0, min(50, body.ctx_before)), max(0, min(50, body.ctx_after))
    r.ctx_minutes = max(0, min(120, body.ctx_minutes))
    r.mode = body.mode if body.mode in ("auto", "override") else "auto"
    r.active, r.reactions = body.active, body.reactions


@router.put("/chats/{cid}")
def update_chat(cid: int, body: ChatIn, request: Request, p: Principal = Depends(admin), db: DB = Depends(get_db)):
    r = db.get(m.RegisteredChat, cid)
    if r is None:
        raise HTTPException(404)
    _apply_chat(r, body)
    audit(db, p, "chat_updated", r.chat_id, client_ip(request))
    db.commit()
    return {"ok": True}


@router.delete("/chats/{cid}")
def unregister_chat(cid: int, request: Request, p: Principal = Depends(admin), db: DB = Depends(get_db)):
    r = db.get(m.RegisteredChat, cid)
    if r is None:
        raise HTTPException(404)
    audit(db, p, "chat_unregistered", r.chat_id, client_ip(request), name=r.chat_name)
    db.delete(r)
    db.commit()
    return {"ok": True}


class CodeIn(BaseModel):
    platform: str
    folder_id: int | None = None
    tag_ids: list[int] = []
    mode: str = "auto"


@router.post("/registration-codes")
def new_code(body: CodeIn, request: Request, p: Principal = Depends(admin), db: DB = Depends(get_db)):
    """One-time code: post it in a chat with the bot; the chat gets registered (bot stays silent)."""
    code = "SRK-" + secrets.token_hex(3).upper()
    db.add(m.RegistrationCode(code=code, platform=body.platform, folder_id=body.folder_id, tag_ids=body.tag_ids,
                              mode=body.mode, created_by=p.user_id, expires_at=now() + timedelta(minutes=30)))
    audit(db, p, "registration_code_created", code, client_ip(request), platform=body.platform)
    db.commit()
    return {"code": code, "expires_in_minutes": 30}


@router.get("/registration-codes/{code}")
def code_status(code: str, p: Principal = Depends(admin), db: DB = Depends(get_db)):
    rc = db.get(m.RegistrationCode, code)
    if rc is None:
        raise HTTPException(404)
    return {"used_chat_id": rc.used_chat_id, "expired": rc.expires_at < now()}


# ---------------------------------------------------------------- system
@router.get("/system")
def system(p: Principal = Depends(admin), db: DB = Depends(get_db)):
    du = shutil.disk_usage(storage().root)
    rej = db.query(func.coalesce(func.sum(m.RejectedItem.size), 0)).scalar()
    failed = db.query(m.Page).filter(m.Page.status == "error").count()
    return {"queues": queue_lengths(), "disk": {"total": du.total, "used": du.used, "free": du.free},
            "rejected_bytes": int(rej), "failed_pages": failed,
            "documents": db.query(m.Document).count(), "pages": db.query(m.Page).count()}


@router.get("/export")
def export(request: Request, p: Principal = Depends(admin_reauth), db: DB = Depends(get_db)):
    """Admin data export: metadata JSON for all documents (files are in the backups / per-document download)."""
    docs = []
    for d in db.query(m.Document).order_by(m.Document.id).all():
        ev = d.ingest_event
        docs.append({"id": d.id, "title": d.title, "folder_id": d.folder_id, "status": d.status,
                     "received_at": d.received_at.isoformat(), "tags": [t.name for t in d.tags],
                     "content": d.content, "source": d.source_platform, "trashed_at": str(d.trashed_at or ""),
                     "event": None if ev is None else {"platform": ev.platform, "chat_name": ev.chat_name,
                                                       "sender_name": ev.sender_name, "caption": ev.caption,
                                                       "context": ev.context, "extra": ev.extra}})
    folders = [{"id": f.id, "parent_id": f.parent_id, "name": f.name} for f in db.query(m.Folder).all()]
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("documents.json", json.dumps(docs, ensure_ascii=False, indent=1))
        z.writestr("folders.json", json.dumps(folders, ensure_ascii=False, indent=1))
    audit(db, p, "data_exported", "", client_ip(request), documents=len(docs))
    db.commit()
    return Response(buf.getvalue(), media_type="application/zip",
                    headers={"Content-Disposition": "attachment; filename=soroka-export.zip"})
