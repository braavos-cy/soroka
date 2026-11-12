from datetime import timedelta

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel
from sqlalchemy.orm import Session as DB

from .. import appsettings
from .. import models as m
from ..config import settings
from ..db import get_db, now
from ..deps import (COOKIE, Principal, _check_csrf, audit, client_ip, current, mfa_satisfied, session_partial,
                    ui_user)
from ..jobs import redis
from ..security import (check_password_policy, create_session, hash_password, new_recovery_codes,
                        new_token, new_totp_secret, sha256, totp_uri, use_recovery_code, verify_password,
                        verify_totp)

router = APIRouter(prefix="/api/auth", tags=["auth"])


def user_out(u: m.User) -> dict:
    return {"id": u.id, "email": u.email, "name": u.name, "role": u.role, "is_active": u.is_active,
            "totp_enabled": u.totp_enabled, "ui_lang": u.ui_lang, "include_subfolders": u.include_subfolders, "must_change_password": u.must_change_password,
            "created_at": u.created_at, "last_login_at": u.last_login_at}


def _ip_rate_limit(ip: str) -> None:
    key = f"rl:login:{ip}"
    n = redis().incr(key)
    if n == 1:
        redis().expire(key, 300)
    if n > 30:
        raise HTTPException(429, "too_many_attempts")


class LoginIn(BaseModel):
    email: str
    password: str


@router.post("/login")
def login(body: LoginIn, request: Request, response: Response, db: DB = Depends(get_db)):
    ip = client_ip(request)
    _ip_rate_limit(ip)
    u = db.query(m.User).filter(m.User.email == body.email.strip().lower()).one_or_none()
    if u and u.locked_until and u.locked_until > now():
        audit(db, None, "login_locked", u.email, ip)
        db.commit()
        raise HTTPException(423, "account_locked")
    if u is None or not u.is_active or not verify_password(u.password_hash, body.password):
        if u is not None:
            u.failed_logins += 1
            if u.failed_logins >= appsettings.get(db, "lockout_attempts"):
                u.locked_until = now() + timedelta(minutes=appsettings.get(db, "lockout_minutes"))
                u.failed_logins = 0
        audit(db, None, "login_failed", body.email[:200], ip)
        db.commit()
        raise HTTPException(401, "invalid_credentials")
    u.failed_logins = 0
    token = create_session(db, u, ip, request.headers.get("user-agent", ""), settings().session_hours)
    db.commit()
    response.set_cookie(COOKIE, token, httponly=True, secure=settings().cookie_secure, samesite="strict",
                        max_age=settings().session_hours * 3600, path="/")
    s = db.get(m.Session, sha256(token))
    step = "done"
    if u.totp_enabled:
        step = "totp"
    elif appsettings.get(db, "require_2fa"):
        step = "totp_setup"
    if step == "done":
        _finish_login(db, s, ip)
    return {"next": step}


def _finish_login(db: DB, s: m.Session, ip: str) -> None:
    s.user.last_login_at = now()
    audit(db, Principal(user=s.user), "login", s.user.email, ip)
    db.commit()


class CodeIn(BaseModel):
    code: str = ""
    recovery_code: str = ""


@router.post("/totp/verify")
def totp_verify(body: CodeIn, request: Request, s: m.Session = Depends(session_partial), db: DB = Depends(get_db)):
    _check_csrf(request)
    _ip_rate_limit(client_ip(request))
    u = s.user
    ok = (body.code and verify_totp(u.totp_secret, body.code)) or \
         (body.recovery_code and use_recovery_code(u, body.recovery_code))
    if not ok or not u.totp_enabled:
        audit(db, Principal(user=u), "totp_failed", u.email, client_ip(request))
        db.commit()
        raise HTTPException(401, "invalid_code")
    s.mfa_ok = True
    s.reauth_at = now()
    if body.recovery_code:
        audit(db, Principal(user=u), "recovery_code_used", u.email, client_ip(request))
    _finish_login(db, s, client_ip(request))
    return {"ok": True}


@router.post("/totp/setup")
def totp_setup(request: Request, s: m.Session = Depends(session_partial), db: DB = Depends(get_db)):
    """Start TOTP enrolment. Allowed for first-time setup, or when re-authenticated."""
    _check_csrf(request)
    u = s.user
    if u.totp_enabled and not _recent_reauth(s):
        raise HTTPException(403, "reauth_required")
    u.totp_secret = new_totp_secret()
    db.commit()
    return {"secret": u.totp_secret, "uri": totp_uri(u.totp_secret, u.email)}


@router.post("/totp/enable")
def totp_enable(body: CodeIn, request: Request, s: m.Session = Depends(session_partial), db: DB = Depends(get_db)):
    _check_csrf(request)
    u = s.user
    if u.totp_enabled and not _recent_reauth(s):
        raise HTTPException(403, "reauth_required")
    if not verify_totp(u.totp_secret, body.code):
        raise HTTPException(400, "invalid_code")
    codes, hashes = new_recovery_codes()
    u.totp_enabled = True
    u.recovery_codes = hashes
    first_login = not s.mfa_ok
    s.mfa_ok = True
    s.reauth_at = now()
    audit(db, Principal(user=u), "totp_enabled", u.email, client_ip(request))
    if first_login:
        _finish_login(db, s, client_ip(request))
    db.commit()
    return {"recovery_codes": codes}


@router.post("/totp/disable")
def totp_disable(request: Request, p: Principal = Depends(ui_user), db: DB = Depends(get_db)):
    if appsettings.get(db, "require_2fa"):
        raise HTTPException(400, "2fa_required_by_policy")
    if not _recent_reauth(p.session):
        raise HTTPException(403, "reauth_required")
    p.user.totp_enabled = False
    p.user.totp_secret = None
    p.user.recovery_codes = []
    audit(db, p, "totp_disabled", p.user.email, client_ip(request))
    db.commit()
    return {"ok": True}


@router.post("/recovery-codes")
def regen_recovery(request: Request, p: Principal = Depends(ui_user), db: DB = Depends(get_db)):
    if not _recent_reauth(p.session):
        raise HTTPException(403, "reauth_required")
    codes, hashes = new_recovery_codes()
    p.user.recovery_codes = hashes
    audit(db, p, "recovery_codes_regenerated", p.user.email, client_ip(request))
    db.commit()
    return {"recovery_codes": codes}


def _recent_reauth(s: m.Session | None) -> bool:
    return bool(s and s.reauth_at and now() - s.reauth_at < timedelta(minutes=settings().reauth_minutes))


class ReauthIn(BaseModel):
    password: str
    code: str = ""


@router.post("/reauth")
def reauth(body: ReauthIn, request: Request, p: Principal = Depends(ui_user), db: DB = Depends(get_db)):
    _ip_rate_limit(client_ip(request))
    u = p.user
    if not verify_password(u.password_hash, body.password):
        raise HTTPException(401, "invalid_credentials")
    if u.totp_enabled and not verify_totp(u.totp_secret, body.code):
        raise HTTPException(401, "invalid_code")
    p.session.reauth_at = now()
    db.commit()
    return {"ok": True}


@router.post("/logout")
def logout(request: Request, response: Response, db: DB = Depends(get_db)):
    tok = request.cookies.get(COOKIE)
    if tok:
        s = db.get(m.Session, sha256(tok))
        if s:
            db.delete(s)
            db.commit()
    response.delete_cookie(COOKIE, path="/")
    return {"ok": True}


@router.get("/me")
def me(request: Request, db: DB = Depends(get_db)):
    from ..deps import _session_from_cookie
    s = _session_from_cookie(request, db)
    if s is None:
        raise HTTPException(401, "not_authenticated")
    if not mfa_satisfied(db, s):
        return {"user": None, "next": "totp" if s.user.totp_enabled else "totp_setup", "email": s.user.email}
    return {"user": user_out(s.user), "next": "done"}


class PasswordIn(BaseModel):
    current_password: str
    new_password: str


@router.post("/password")
def change_password(body: PasswordIn, request: Request, p: Principal = Depends(current), db: DB = Depends(get_db)):
    if not verify_password(p.user.password_hash, body.current_password):
        raise HTTPException(401, "invalid_credentials")
    if err := check_password_policy(body.new_password, p.user.email, body.current_password):
        raise HTTPException(400, err)
    p.user.password_hash = hash_password(body.new_password)
    p.user.must_change_password = False
    # revoke all other sessions
    db.query(m.Session).filter(m.Session.user_id == p.user.id, m.Session.id != p.session.id).delete()
    audit(db, p, "password_changed", p.user.email, client_ip(request))
    db.commit()
    return {"ok": True}


class LangIn(BaseModel):
    ui_lang: str


@router.post("/lang")
def set_lang(body: LangIn, p: Principal = Depends(ui_user), db: DB = Depends(get_db)):
    if body.ui_lang in ("ru", "en"):
        p.user.ui_lang = body.ui_lang
        db.commit()
    return {"ok": True}


class PrefsIn(BaseModel):
    include_subfolders: bool | None = None


@router.post("/prefs")
def set_prefs(body: PrefsIn, p: Principal = Depends(ui_user), db: DB = Depends(get_db)):
    if body.include_subfolders is not None:
        p.user.include_subfolders = body.include_subfolders
    db.commit()
    return user_out(p.user)


# ---------------------------------------------------------------- sessions
@router.get("/sessions")
def sessions(p: Principal = Depends(ui_user), db: DB = Depends(get_db)):
    rows = db.query(m.Session).filter(m.Session.user_id == p.user.id).order_by(m.Session.last_seen_at.desc()).all()
    return [{"id": s.id[:16], "created_at": s.created_at, "last_seen_at": s.last_seen_at, "ip": s.ip,
             "user_agent": s.user_agent, "current": p.session is not None and s.id == p.session.id} for s in rows]


@router.delete("/sessions/{sid}")
def revoke_session(sid: str, request: Request, p: Principal = Depends(ui_user), db: DB = Depends(get_db)):
    n = db.query(m.Session).filter(m.Session.user_id == p.user.id, m.Session.id.startswith(sid)).delete(
        synchronize_session=False)
    audit(db, p, "session_revoked", sid, client_ip(request))
    db.commit()
    return {"revoked": n}


# ---------------------------------------------------------------- API tokens
class TokenIn(BaseModel):
    name: str
    scopes: list[str] = ["ingest"]


@router.get("/tokens")
def tokens(p: Principal = Depends(ui_user), db: DB = Depends(get_db)):
    rows = db.query(m.ApiToken).filter_by(user_id=p.user.id).order_by(m.ApiToken.created_at.desc()).all()
    return [{"id": t.id, "name": t.name, "prefix": t.prefix, "scopes": t.scopes, "created_at": t.created_at,
             "last_used_at": t.last_used_at, "revoked_at": t.revoked_at} for t in rows]


@router.post("/tokens")
def create_token(body: TokenIn, request: Request, p: Principal = Depends(ui_user), db: DB = Depends(get_db)):
    scopes = [s for s in body.scopes if s in ("ingest", "full")] or ["ingest"]
    raw = "sor_" + new_token(30)
    t = m.ApiToken(user_id=p.user.id, name=body.name[:200], token_hash=sha256(raw), prefix=raw[:10], scopes=scopes)
    db.add(t)
    audit(db, p, "api_token_created", body.name, client_ip(request), scopes=scopes)
    db.commit()
    return {"id": t.id, "token": raw}


@router.delete("/tokens/{tid}")
def revoke_token(tid: int, request: Request, p: Principal = Depends(ui_user), db: DB = Depends(get_db)):
    t = db.get(m.ApiToken, tid)
    if t is None or t.user_id != p.user.id:
        raise HTTPException(404)
    t.revoked_at = now()
    audit(db, p, "api_token_revoked", t.name, client_ip(request))
    db.commit()
    return {"ok": True}
