"""Request authentication: session cookie (UI), bearer API token (extension), connector token (bots)."""
import hmac
from dataclasses import dataclass
from datetime import timedelta

from fastapi import Depends, HTTPException, Request
from sqlalchemy.orm import Session as DB

from . import appsettings
from . import models as m
from .config import settings
from .db import get_db, now
from .security import sha256

COOKIE = "soroka_session"


@dataclass
class Principal:
    user: m.User | None
    session: m.Session | None = None
    token: m.ApiToken | None = None
    connector: bool = False

    @property
    def user_id(self) -> int | None:
        return self.user.id if self.user else None


def client_ip(request: Request) -> str:
    return request.client.host if request.client else ""


def audit(db: DB, principal: "Principal | None", action: str, target: str = "", ip: str = "", **details) -> None:
    db.add(m.AuditLog(user_id=principal.user_id if principal else None, action=action, target=str(target),
                      details=details, ip=ip))


def _session_from_cookie(request: Request, db: DB) -> m.Session | None:
    tok = request.cookies.get(COOKIE)
    if not tok:
        return None
    s = db.get(m.Session, sha256(tok))
    if s is None or s.expires_at < now() or not s.user.is_active:
        return None
    if (now() - s.last_seen_at) > timedelta(minutes=1):
        s.last_seen_at = now()
        db.commit()
    return s


def session_partial(request: Request, db: DB = Depends(get_db)) -> m.Session:
    """Logged in with password, 2FA may still be pending (used by the 2FA endpoints)."""
    s = _session_from_cookie(request, db)
    if s is None:
        raise HTTPException(401, "not_authenticated")
    return s


def mfa_satisfied(db: DB, s: m.Session) -> bool:
    if s.mfa_ok:
        return True
    return not s.user.totp_enabled and not appsettings.get(db, "require_2fa")


def _check_csrf(request: Request) -> None:
    # Cookie auth: SameSite=Strict + require a custom header on state-changing requests
    if request.method not in ("GET", "HEAD", "OPTIONS") and request.headers.get("x-requested-with") != "soroka":
        raise HTTPException(403, "csrf")


def current(request: Request, db: DB = Depends(get_db)) -> Principal:
    auth = request.headers.get("authorization", "")
    if auth.lower().startswith("bearer "):
        raw = auth[7:].strip()
        t = db.query(m.ApiToken).filter_by(token_hash=sha256(raw)).one_or_none()
        if t is None or t.revoked_at is not None or not t.user.is_active:
            raise HTTPException(401, "bad_token")
        t.last_used_at = now()
        db.commit()
        return Principal(user=t.user, token=t)
    s = _session_from_cookie(request, db)
    if s is None:
        raise HTTPException(401, "not_authenticated")
    if not mfa_satisfied(db, s):
        raise HTTPException(401, "mfa_required")
    if s.user.must_change_password and request.url.path not in ("/api/auth/password", "/api/auth/me"):
        raise HTTPException(403, "must_change_password")
    _check_csrf(request)
    return Principal(user=s.user, session=s)


def ui_user(p: Principal = Depends(current)) -> Principal:
    """Full UI access: sessions, or API tokens with the 'full' scope."""
    if p.token is not None and "full" not in (p.token.scopes or []):
        raise HTTPException(403, "scope")
    return p


def admin(p: Principal = Depends(ui_user)) -> Principal:
    if p.user.role != "admin":
        raise HTTPException(403, "admin_only")
    return p


def require_reauth(p: Principal = Depends(ui_user)) -> Principal:
    s = p.session
    if s is None or s.reauth_at is None or now() - s.reauth_at > timedelta(minutes=settings().reauth_minutes):
        raise HTTPException(403, "reauth_required")
    return p


def admin_reauth(p: Principal = Depends(require_reauth)) -> Principal:
    if p.user.role != "admin":
        raise HTTPException(403, "admin_only")
    return p


def connector(request: Request) -> Principal:
    tok = request.headers.get("x-connector-token", "")
    if not tok or not hmac.compare_digest(tok, settings().connector_token):
        raise HTTPException(401, "bad_connector_token")
    return Principal(user=None, connector=True)


def ingest_principal(request: Request, db: DB = Depends(get_db)) -> Principal:
    """Ingest accepts a connector token, an API token with 'ingest' scope, or a UI session."""
    if request.headers.get("x-connector-token"):
        return connector(request)
    p = current(request, db)
    if p.token is not None and not ({"ingest", "full"} & set(p.token.scopes or [])):
        raise HTTPException(403, "scope")
    return p
