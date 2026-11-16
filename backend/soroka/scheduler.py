"""Periodic housekeeping: trash/rejected retention, storage-pressure rule, watched import dir,
connector health alerts, expired sessions. Runs as its own small container."""
import logging
import os
import shutil
import smtplib
import time
from datetime import timedelta
from email.message import EmailMessage
from pathlib import Path

from . import appsettings
from . import models as m
from .api.documents import purge
from .api.uploads import cleanup_stale as cleanup_stale_uploads
from .config import settings
from .db import SessionLocal, now
from .ingest import InFile, IngestMeta, IngestRejected, ingest
from .storage import storage

log = logging.getLogger("soroka.scheduler")
IMPORT_DIR = Path(settings().data_dir) / "import"


def send_alert(subject: str, body: str) -> None:
    s = settings()
    if not (s.smtp_host and s.alert_email):
        return
    msg = EmailMessage()
    msg["Subject"], msg["From"], msg["To"] = subject, s.smtp_from or s.smtp_user, s.alert_email
    msg.set_content(body)
    try:
        with smtplib.SMTP(s.smtp_host, s.smtp_port, timeout=30) as smtp:
            smtp.starttls()
            if s.smtp_user:
                smtp.login(s.smtp_user, s.smtp_password)
            smtp.send_message(msg)
    except Exception:  # noqa: BLE001
        log.exception("alert email failed")


def retention(db) -> None:
    trash_days = appsettings.get(db, "trash_days")
    for d in db.query(m.Document).filter(m.Document.trashed_at < now() - timedelta(days=trash_days)).all():
        purge(db, d)
        db.add(m.AuditLog(action="trash_auto_purged", target=str(d.id)))
    for ri in db.query(m.RejectedItem).filter(m.RejectedItem.expires_at < now()).all():
        d = db.get(m.Document, ri.document_id)
        if d:
            purge(db, d)
            db.add(m.AuditLog(action="rejected_expired", target=str(ri.document_id)))
    db.commit()
    # storage-pressure rule: oldest rejected first, but never younger than the minimum retention
    max_bytes = appsettings.get(db, "rejected_max_mb") * 1024 * 1024
    min_free = appsettings.get(db, "min_free_disk_mb") * 1024 * 1024
    min_age = now() - timedelta(days=appsettings.get(db, "rejected_min_days"))
    rows = db.query(m.RejectedItem).order_by(m.RejectedItem.rejected_at).all()
    total = sum(r.size for r in rows)
    for r in rows:
        if total <= max_bytes and storage().disk_free_bytes() >= min_free:
            break
        if r.rejected_at > min_age:
            break
        d = db.get(m.Document, r.document_id)
        total -= r.size
        if d:
            purge(db, d)
            db.add(m.AuditLog(action="rejected_storage_pressure", target=str(r.document_id)))
        db.commit()


def watch_import_dir(db) -> None:
    """Files dropped into DATA_DIR/import/<sub/folders> are imported with low priority, structure preserved."""
    IMPORT_DIR.mkdir(parents=True, exist_ok=True)
    done = IMPORT_DIR / "_done"
    skipped = IMPORT_DIR / "_skipped"  # refused files (type not supported, over the size limit): not retried
    cutoff = time.time() - 60  # file must be unchanged for a minute (still copying otherwise)
    for path in sorted(IMPORT_DIR.rglob("*")):
        if (not path.is_file() or done in path.parents or skipped in path.parents or path.name.startswith(".")
                or path.stat().st_mtime > cutoff):
            continue
        rel = path.relative_to(IMPORT_DIR)
        from .ingest import _ensure_folder_path
        root = db.query(m.Folder).filter_by(parent_id=None, name="Import").first()
        if root is None:
            root = m.Folder(name="Import")
            db.add(root)
            db.flush()
        fid = _ensure_folder_path(db, root.id, list(rel.parts[:-1]))
        db.commit()
        try:
            ingest(db, IngestMeta(platform="import", folder_id=fid, priority="low", forced=True,
                                  extra={"import_path": str(rel)}), [InFile(path.name, path.read_bytes())])
        except IngestRejected as e:
            db.rollback()
            log.info("import skipped (%s): %s", e, rel)
            target = skipped / rel
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.move(str(path), str(target))
            continue
        except Exception:  # noqa: BLE001
            db.rollback()
            log.exception("import failed: %s", rel)
            continue
        target = done / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.move(str(path), str(target))


def connector_health(db) -> None:
    for acc in db.query(m.ConnectorAccount).all():
        stale = acc.last_seen_at is None or now() - acc.last_seen_at > timedelta(minutes=3)
        bad = stale or acc.status in ("logged_out", "disconnected", "qr")
        if bad and acc.alerted_at is None:
            status = "offline" if stale else acc.status
            send_alert(f"[Soroka] {acc.platform} connector: {status}",
                       f"The {acc.platform} connector is {status}.\n{acc.status_detail}\n"
                       "If the account was logged out or banned, re-link it in Admin -> Connectors.")
            db.add(m.AuditLog(action="connector_alert", target=acc.platform, details={"status": status}))
            acc.alerted_at = now()
        elif not bad:
            acc.alerted_at = None
    db.query(m.Session).filter(m.Session.expires_at < now()).delete()
    db.commit()


def main() -> None:
    logging.basicConfig(level=logging.INFO)
    last_retention = 0.0
    while True:
        db = SessionLocal()
        try:
            watch_import_dir(db)
            connector_health(db)
            if time.time() - last_retention > 3600:
                retention(db)
                if n := cleanup_stale_uploads():
                    log.info("removed %d abandoned upload sessions", n)
                last_retention = time.time()
        except Exception:  # noqa: BLE001
            db.rollback()
            log.exception("scheduler tick failed")
        finally:
            db.close()
        time.sleep(30)


if __name__ == "__main__":
    main()
