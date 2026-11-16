"""Admin-editable system settings stored in the DB (defaults here)."""
from typing import Any

from sqlalchemy.orm import Session as DB

from . import models as m

DEFAULTS: dict[str, Any] = {
    "require_2fa": True,
    "trash_days": 30,
    "rejected_days": 10,
    "rejected_min_days": 3,
    "rejected_max_mb": 2048,
    "min_free_disk_mb": 5120,
    "lockout_attempts": 5,
    "lockout_minutes": 15,
    "tag_max_length": 40,  # whole tag name incl. spaces and "parent/child" path
    "chat_reactions": True,  # bots react to messages: saved / rejected (per-chat switch: registered_chat.reactions)
    # pipeline thresholds (fusion weights live in pipeline config; these are the user-facing ones)
    "accept_doc_threshold": 0.55,
    "accept_reject_threshold": 0.30,
}


# allowed ranges for numeric settings (values outside are clamped)
LIMITS: dict[str, tuple[int, int]] = {"tag_max_length": (1, 300)}


def get(db: DB, key: str) -> Any:
    row = db.get(m.Setting, key)
    return row.value if row is not None else DEFAULTS.get(key)


def all_settings(db: DB) -> dict[str, Any]:
    out = dict(DEFAULTS)
    for row in db.query(m.Setting).all():
        out[row.key] = row.value
    return out


def set_many(db: DB, values: dict[str, Any]) -> None:
    for k, v in values.items():
        if k not in DEFAULTS:
            continue
        typ = type(DEFAULTS[k])
        v = typ(v) if typ is not bool else bool(v)
        if k in LIMITS:
            lo, hi = LIMITS[k]
            v = max(lo, min(hi, v))
        row = db.get(m.Setting, k)
        if row is None:
            db.add(m.Setting(key=k, value=v))
        else:
            row.value = v
