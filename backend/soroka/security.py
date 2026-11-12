import hashlib
import secrets
from datetime import timedelta

import pyotp
from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerifyMismatchError
from sqlalchemy.orm import Session as DB

from . import models as m
from .db import now

ph = PasswordHasher()  # Argon2id defaults


def hash_password(pw: str) -> str:
    return ph.hash(pw)


def verify_password(hash_: str, pw: str) -> bool:
    try:
        return ph.verify(hash_, pw)
    except (VerifyMismatchError, InvalidHashError):
        return False


def sha256(s: str) -> str:
    return hashlib.sha256(s.encode()).hexdigest()


def new_token(nbytes: int = 32) -> str:
    return secrets.token_urlsafe(nbytes)


def check_password_policy(pw: str) -> str | None:
    if len(pw) < 10:
        return "password_too_short"
    return None


# ---------------------------------------------------------------- TOTP + recovery codes
def new_totp_secret() -> str:
    return pyotp.random_base32()


def totp_uri(secret: str, email: str) -> str:
    return pyotp.TOTP(secret).provisioning_uri(name=email, issuer_name="Soroka")


def verify_totp(secret: str, code: str) -> bool:
    code = (code or "").replace(" ", "")
    return bool(secret) and pyotp.TOTP(secret).verify(code, valid_window=1)


def new_recovery_codes(n: int = 10) -> tuple[list[str], list[str]]:
    codes = [f"{secrets.token_hex(3)}-{secrets.token_hex(3)}" for _ in range(n)]
    return codes, [ph.hash(c) for c in codes]


def use_recovery_code(user: m.User, code: str) -> bool:
    code = (code or "").strip().lower()
    for h in list(user.recovery_codes or []):
        try:
            if ph.verify(h, code):
                user.recovery_codes = [x for x in user.recovery_codes if x != h]
                return True
        except (VerifyMismatchError, InvalidHashError):
            continue
    return False


# ---------------------------------------------------------------- sessions
def create_session(db: DB, user: m.User, ip: str, ua: str, hours: int) -> str:
    token = new_token()
    db.add(m.Session(id=sha256(token), user_id=user.id, ip=ip[:64], user_agent=ua[:400],
                     expires_at=now() + timedelta(hours=hours)))
    return token
