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


PASSWORD_MIN_LEN = 12
PASSWORD_MAX_LEN = 128
# Base words that make a password guessable even when padded with digits/symbols ("Password2026!").
_COMMON_WORDS = {
    "password", "passw0rd", "qwerty", "qwertyuiop", "asdfgh", "zxcvbn", "admin", "administrator", "welcome",
    "letmein", "iloveyou", "monkey", "dragon", "master", "sunshine", "football", "abc", "abcdef", "secret",
    "changeme", "default", "soroka", "сорока", "пароль", "йцукен", "привет", "люблю",
}


def check_password_policy(pw: str, email: str | None = None, current: str | None = None) -> str | None:
    """Return an error code (the first failed rule) or None. Mirrored in frontend/src/password.ts."""
    if len(pw) < PASSWORD_MIN_LEN:
        return "password_too_short"
    if len(pw) > PASSWORD_MAX_LEN:
        return "password_too_long"
    if not any(c.islower() for c in pw):
        return "password_no_lower"
    if not any(c.isupper() for c in pw):
        return "password_no_upper"
    if not any(c.isdigit() for c in pw):
        return "password_no_digit"
    if all(c.isalnum() for c in pw):
        return "password_no_symbol"
    low = pw.lower()
    if len(set(low)) < 6 or any(low[i] == low[i + 1] == low[i + 2] == low[i + 3] for i in range(len(low) - 3)):
        return "password_repetitive"
    letters = "".join(c for c in low if c.isalpha())
    if letters in _COMMON_WORDS or any(w in low for w in ("password", "qwerty", "soroka", "сорока", "пароль", "йцукен")):
        return "password_common"
    local = (email or "").split("@")[0].lower()
    if len(local) >= 4 and local in low:
        return "password_contains_email"
    if current is not None and pw == current:
        return "password_reused"
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
