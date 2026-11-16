"""Bot reactions to chat messages: one emoji on the message once its outcome is known (saved / rejected).

The core decides and queues (ingest_event.reaction); the connector delivers with its next config poll and confirms.
A message gets at most one reaction: later changes (rescue, manual reject) do not touch the chat again.
Switches: global setting `chat_reactions` and `registered_chat.reactions` — both must be on."""
from datetime import timedelta

from sqlalchemy.orm import Session as DB

from . import appsettings
from . import models as m
from .db import now

SAVED, REJECTED = "✅", "❌"
BOT_PLATFORMS = {"whatsapp", "telegram"}
# A reaction the connector could not deliver in this time (offline) is dropped: no late reactions to old messages.
TTL = timedelta(hours=1)
# Messages older than this never get a reaction, whatever happens to their documents later.
MAX_AGE = timedelta(hours=24)


def enabled(db: DB, ev: m.IngestEvent) -> bool:
    if not appsettings.get(db, "chat_reactions"):
        return False
    reg = db.query(m.RegisteredChat).filter_by(platform=ev.platform, chat_id=ev.chat_id).one_or_none()
    return reg is None or bool(reg.reactions)  # no registration = forwarded to the bot's private chat


def queue(db: DB, ev: m.IngestEvent | None, emoji: str) -> None:
    """Caller commits."""
    if ev is None or ev.platform not in BOT_PLATFORMS or not ev.message_id or not ev.chat_id or ev.reaction:
        return
    if ev.ingested_at and now() - ev.ingested_at > MAX_AGE:
        return  # e.g. an old document reprocessed from the UI
    if enabled(db, ev):
        ev.reaction, ev.reaction_at = emoji, now()


def on_finalized(db: DB, doc: m.Document) -> None:
    """Called when a document reaches its outcome. A message with several files (zip) is saved if any file was
    kept, rejected only when every one was."""
    ev = doc.ingest_event
    if ev is None or ev.reaction or ev.platform not in BOT_PLATFORMS:
        return
    statuses = {s for (s,) in db.query(m.Document.status).filter_by(ingest_event_id=ev.id).all()}
    if "ready" in statuses:
        queue(db, ev, SAVED)
    elif statuses == {"rejected"}:
        queue(db, ev, REJECTED)


def pending(db: DB, platform: str) -> list[dict]:
    rows = db.query(m.IngestEvent).filter(
        m.IngestEvent.platform == platform, m.IngestEvent.reaction.isnot(None),
        m.IngestEvent.reaction_sent_at.is_(None), m.IngestEvent.reaction_at > now() - TTL,
    ).order_by(m.IngestEvent.id).limit(20).all()
    return [{"event_id": e.id, "chat_id": e.chat_id, "message_id": e.message_id, "sender_id": e.sender_id,
             "emoji": e.reaction} for e in rows]


def mark_sent(db: DB, platform: str, event_ids: list[int]) -> None:
    db.query(m.IngestEvent).filter(
        m.IngestEvent.platform == platform, m.IngestEvent.id.in_(event_ids or [-1]),
        m.IngestEvent.reaction.isnot(None), m.IngestEvent.reaction_sent_at.is_(None),
    ).update({"reaction_sent_at": now()}, synchronize_session=False)
