"""Idempotent first-start setup: Inbox folder and the first admin account."""
import logging
import sys

from . import models as m
from .config import settings
from .db import SessionLocal
from .security import hash_password

log = logging.getLogger("soroka.bootstrap")


def main() -> None:
    db = SessionLocal()
    try:
        if not db.query(m.Folder).filter_by(is_system=True).first():
            db.add(m.Folder(name="Inbox", is_system=True))
        if not db.query(m.User).filter_by(role="admin").first():
            pw = settings().bootstrap_admin_password
            if not pw:
                print("BOOTSTRAP_ADMIN_PASSWORD not set; no admin created", file=sys.stderr)
            else:
                db.add(m.User(email=settings().bootstrap_admin_email.lower(), name="Admin", role="admin",
                              password_hash=hash_password(pw), must_change_password=True))
                print(f"created admin {settings().bootstrap_admin_email}")
        db.commit()
    finally:
        db.close()


if __name__ == "__main__":
    main()
