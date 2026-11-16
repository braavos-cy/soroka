"""Data model (requirements §10). Single shared workspace; permission hooks can be added later
(e.g. a folder_acl table) without changing these tables."""
from datetime import datetime, timedelta
from typing import Any

from sqlalchemy import (BigInteger, Boolean, DateTime, Float, ForeignKey, Index, Integer, String, Text,
                        UniqueConstraint)
from sqlalchemy.dialects.postgresql import JSONB, TSVECTOR
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .db import Base, now

JSON = JSONB


def ts(**kw):
    return mapped_column(DateTime(timezone=True), **kw)


# ---------------------------------------------------------------- users & auth
class User(Base):
    __tablename__ = "user"
    id: Mapped[int] = mapped_column(primary_key=True)
    email: Mapped[str] = mapped_column(String(320), unique=True)
    name: Mapped[str] = mapped_column(String(200), default="")
    password_hash: Mapped[str] = mapped_column(String(200))
    role: Mapped[str] = mapped_column(String(20), default="user")  # user | admin
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    totp_secret: Mapped[str | None] = mapped_column(String(64))
    totp_enabled: Mapped[bool] = mapped_column(Boolean, default=False)
    recovery_codes: Mapped[list] = mapped_column(JSON, default=list)  # argon2 hashes
    failed_logins: Mapped[int] = mapped_column(Integer, default=0)
    locked_until: Mapped[datetime | None] = ts()
    must_change_password: Mapped[bool] = mapped_column(Boolean, default=False)
    ui_lang: Mapped[str] = mapped_column(String(8), default="ru")
    rejected_seen_at: Mapped[datetime | None] = ts()  # last visit to the rejected area (new-rejects badge)
    include_subfolders: Mapped[bool] = mapped_column(Boolean, default=False)  # folder view also lists subfolders
    created_at: Mapped[datetime] = ts(default=now)
    last_login_at: Mapped[datetime | None] = ts()


class Session(Base):
    __tablename__ = "session"
    id: Mapped[str] = mapped_column(String(64), primary_key=True)  # sha256 of cookie token
    user_id: Mapped[int] = mapped_column(ForeignKey("user.id", ondelete="CASCADE"), index=True)
    created_at: Mapped[datetime] = ts(default=now)
    last_seen_at: Mapped[datetime] = ts(default=now)
    expires_at: Mapped[datetime] = ts()
    ip: Mapped[str] = mapped_column(String(64), default="")
    user_agent: Mapped[str] = mapped_column(String(400), default="")
    mfa_ok: Mapped[bool] = mapped_column(Boolean, default=False)
    reauth_at: Mapped[datetime | None] = ts()
    user: Mapped[User] = relationship()


class ApiToken(Base):
    __tablename__ = "api_token"
    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("user.id", ondelete="CASCADE"), index=True)
    name: Mapped[str] = mapped_column(String(200))
    token_hash: Mapped[str] = mapped_column(String(64), unique=True)
    prefix: Mapped[str] = mapped_column(String(16))
    scopes: Mapped[list] = mapped_column(JSON, default=list)  # e.g. ["ingest"]
    created_at: Mapped[datetime] = ts(default=now)
    last_used_at: Mapped[datetime | None] = ts()
    revoked_at: Mapped[datetime | None] = ts()
    user: Mapped[User] = relationship()


class AuditLog(Base):
    __tablename__ = "audit_log"
    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    at: Mapped[datetime] = ts(default=now, index=True)
    user_id: Mapped[int | None] = mapped_column(ForeignKey("user.id", ondelete="SET NULL"))
    action: Mapped[str] = mapped_column(String(100), index=True)
    target: Mapped[str] = mapped_column(String(200), default="")
    details: Mapped[dict] = mapped_column(JSON, default=dict)
    ip: Mapped[str] = mapped_column(String(64), default="")


class Setting(Base):
    __tablename__ = "setting"
    key: Mapped[str] = mapped_column(String(100), primary_key=True)
    value: Mapped[Any] = mapped_column(JSON)


# ---------------------------------------------------------------- connectors
class ConnectorAccount(Base):
    __tablename__ = "connector_account"
    id: Mapped[int] = mapped_column(primary_key=True)
    platform: Mapped[str] = mapped_column(String(20), unique=True)  # whatsapp | telegram
    status: Mapped[str] = mapped_column(String(30), default="unknown")  # connected|qr|disconnected|logged_out
    status_detail: Mapped[str] = mapped_column(Text, default="")
    self_id: Mapped[str] = mapped_column(String(200), default="")
    self_name: Mapped[str] = mapped_column(String(200), default="")
    qr: Mapped[str | None] = mapped_column(Text)
    last_seen_at: Mapped[datetime | None] = ts()
    pending_command: Mapped[str | None] = mapped_column(String(30))  # logout
    alerted_at: Mapped[datetime | None] = ts()


class SeenChat(Base):
    """Chats the bot is a member of (names only) — offered for registration in the admin UI."""
    __tablename__ = "seen_chat"
    id: Mapped[int] = mapped_column(primary_key=True)
    platform: Mapped[str] = mapped_column(String(20))
    chat_id: Mapped[str] = mapped_column(String(200))
    chat_name: Mapped[str] = mapped_column(String(300), default="")
    is_group: Mapped[bool] = mapped_column(Boolean, default=True)
    last_seen_at: Mapped[datetime] = ts(default=now)
    leave_requested_at: Mapped[datetime | None] = ts()  # admin asked the bot to leave; see LEAVE_TTL
    __table_args__ = (UniqueConstraint("platform", "chat_id"),)

    @staticmethod
    def leave_pending():
        """Filter: leave requests the connector should still carry out."""
        return SeenChat.leave_requested_at > now() - LEAVE_TTL


# A leave request not picked up in this time (connector offline) is dropped, so the bot never leaves a chat
# unexpectedly long after the admin clicked.
LEAVE_TTL = timedelta(minutes=10)


class RegisteredChat(Base):
    __tablename__ = "registered_chat"
    id: Mapped[int] = mapped_column(primary_key=True)
    platform: Mapped[str] = mapped_column(String(20))
    chat_id: Mapped[str] = mapped_column(String(200))
    chat_name: Mapped[str] = mapped_column(String(300), default="")
    folder_id: Mapped[int | None] = mapped_column(ForeignKey("folder.id", ondelete="SET NULL"))
    tag_ids: Mapped[list] = mapped_column(JSON, default=list)
    ctx_before: Mapped[int] = mapped_column(Integer, default=5)
    ctx_after: Mapped[int] = mapped_column(Integer, default=5)
    ctx_minutes: Mapped[int] = mapped_column(Integer, default=10)
    mode: Mapped[str] = mapped_column(String(20), default="auto")  # auto | override
    active: Mapped[bool] = mapped_column(Boolean, default=True)
    reactions: Mapped[bool] = mapped_column(Boolean, default=True)  # bot reacts to saved / rejected messages
    created_at: Mapped[datetime] = ts(default=now)
    __table_args__ = (UniqueConstraint("platform", "chat_id"),)


class RegistrationCode(Base):
    __tablename__ = "registration_code"
    code: Mapped[str] = mapped_column(String(32), primary_key=True)
    platform: Mapped[str] = mapped_column(String(20))
    folder_id: Mapped[int | None] = mapped_column(Integer)
    tag_ids: Mapped[list] = mapped_column(JSON, default=list)
    mode: Mapped[str] = mapped_column(String(20), default="auto")
    created_by: Mapped[int | None] = mapped_column(Integer)
    expires_at: Mapped[datetime] = ts()
    used_chat_id: Mapped[str | None] = mapped_column(String(200))


# ---------------------------------------------------------------- ingestion
class IngestEvent(Base):
    __tablename__ = "ingest_event"
    id: Mapped[int] = mapped_column(primary_key=True)
    platform: Mapped[str] = mapped_column(String(20))  # whatsapp|telegram|email|upload|import
    chat_id: Mapped[str] = mapped_column(String(200), default="")
    chat_name: Mapped[str] = mapped_column(String(300), default="")
    message_id: Mapped[str] = mapped_column(String(200), default="")
    message_link: Mapped[str] = mapped_column(String(500), default="")
    sender_id: Mapped[str] = mapped_column(String(200), default="")
    sender_name: Mapped[str] = mapped_column(String(300), default="")
    sender_phone: Mapped[str] = mapped_column(String(50), default="")
    sender_username: Mapped[str] = mapped_column(String(200), default="")
    sender_email: Mapped[str] = mapped_column(String(320), default="")
    uploaded_by: Mapped[int | None] = mapped_column(ForeignKey("user.id", ondelete="SET NULL"))
    sent_at: Mapped[datetime | None] = ts()
    ingested_at: Mapped[datetime] = ts(default=now)
    location: Mapped[dict | None] = mapped_column(JSON)
    forwarded: Mapped[bool] = mapped_column(Boolean, default=False)
    forward_info: Mapped[dict | None] = mapped_column(JSON)
    caption: Mapped[str] = mapped_column(Text, default="")
    reply_to: Mapped[dict | None] = mapped_column(JSON)
    context: Mapped[list] = mapped_column(JSON, default=list)  # [{id, sender, time, text, position}]
    extra: Mapped[dict] = mapped_column(JSON, default=dict)  # email: to, cc, subject ...
    forced: Mapped[bool] = mapped_column(Boolean, default=False)
    force_reason: Mapped[str] = mapped_column(String(50), default="")
    # bot reaction to the source message (see reactions.py): emoji, when queued, when the connector delivered it
    reaction: Mapped[str | None] = mapped_column(String(16))
    reaction_at: Mapped[datetime | None] = ts()
    reaction_sent_at: Mapped[datetime | None] = ts()


class FileOriginal(Base):
    __tablename__ = "file_original"
    id: Mapped[int] = mapped_column(primary_key=True)
    ingest_event_id: Mapped[int | None] = mapped_column(ForeignKey("ingest_event.id", ondelete="SET NULL"))
    blob_key: Mapped[str] = mapped_column(String(300))
    sha256: Mapped[str] = mapped_column(String(64), index=True)
    mime: Mapped[str] = mapped_column(String(200))
    filename: Mapped[str] = mapped_column(String(500))
    size: Mapped[int] = mapped_column(BigInteger)
    rendition_key: Mapped[str | None] = mapped_column(String(300))  # office -> PDF preview
    created_at: Mapped[datetime] = ts(default=now)


# ---------------------------------------------------------------- organization
class Folder(Base):
    __tablename__ = "folder"
    id: Mapped[int] = mapped_column(primary_key=True)
    parent_id: Mapped[int | None] = mapped_column(ForeignKey("folder.id", ondelete="CASCADE"), index=True)
    name: Mapped[str] = mapped_column(String(300))
    is_system: Mapped[bool] = mapped_column(Boolean, default=False)  # legacy (Inbox), unused
    created_at: Mapped[datetime] = ts(default=now)
    __table_args__ = (UniqueConstraint("parent_id", "name"),)


class Tag(Base):
    __tablename__ = "tag"
    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(300), unique=True)  # hierarchy via "finance/tax"
    color: Mapped[str] = mapped_column(String(20), default="#7b8794")
    created_at: Mapped[datetime] = ts(default=now)


class DocumentTag(Base):
    __tablename__ = "document_tag"
    document_id: Mapped[int] = mapped_column(ForeignKey("document.id", ondelete="CASCADE"), primary_key=True)
    tag_id: Mapped[int] = mapped_column(ForeignKey("tag.id", ondelete="CASCADE"), primary_key=True, index=True)


# ---------------------------------------------------------------- documents
class Document(Base):
    __tablename__ = "document"
    id: Mapped[int] = mapped_column(primary_key=True)
    title: Mapped[str] = mapped_column(String(500), default="")
    folder_id: Mapped[int | None] = mapped_column(ForeignKey("folder.id", ondelete="SET NULL"), index=True)  # NULL = no folder
    ingest_event_id: Mapped[int | None] = mapped_column(ForeignKey("ingest_event.id", ondelete="SET NULL"))
    document_date: Mapped[datetime | None] = ts()
    received_at: Mapped[datetime] = ts(default=now, index=True)
    # queued|processing|ready|error|rejected|infected
    status: Mapped[str] = mapped_column(String(20), default="queued", index=True)
    status_detail: Mapped[str] = mapped_column(Text, default="")
    tier: Mapped[str | None] = mapped_column(String(10))  # high|medium|low
    needs_review: Mapped[bool] = mapped_column(Boolean, default=False, index=True)
    current_version_id: Mapped[int | None] = mapped_column(Integer)
    source_file_ids: Mapped[list] = mapped_column(JSON, default=list)  # files to split into pages on ingest
    page_count: Mapped[int] = mapped_column(Integer, default=0)
    file_type: Mapped[str] = mapped_column(String(20), default="")  # image|pdf|office|mixed
    language: Mapped[str] = mapped_column(String(20), default="")
    source_platform: Mapped[str] = mapped_column(String(20), default="upload", index=True)
    pdf_key: Mapped[str | None] = mapped_column(String(300))  # searchable PDF of current version
    content: Mapped[str] = mapped_column(Text, default="")  # OCR / extracted text (all pages)
    search_text: Mapped[str] = mapped_column(Text, default="")  # content + metadata, normalized
    search_vector: Mapped[Any] = mapped_column(TSVECTOR, nullable=True)
    queue: Mapped[str] = mapped_column(String(10), default="high")
    trashed_at: Mapped[datetime | None] = ts(index=True)
    trashed_by: Mapped[int | None] = mapped_column(Integer)
    created_at: Mapped[datetime] = ts(default=now)
    updated_at: Mapped[datetime] = ts(default=now, onupdate=now)

    tags: Mapped[list[Tag]] = relationship(secondary="document_tag", lazy="selectin")
    ingest_event: Mapped[IngestEvent | None] = relationship(lazy="joined")

    __table_args__ = (Index("ix_document_search", "search_vector", postgresql_using="gin"),)


class DocumentVersion(Base):
    __tablename__ = "document_version"
    id: Mapped[int] = mapped_column(primary_key=True)
    document_id: Mapped[int] = mapped_column(ForeignKey("document.id", ondelete="CASCADE"), index=True)
    number: Mapped[int] = mapped_column(Integer)
    page_ids: Mapped[list] = mapped_column(JSON)  # ordered
    note: Mapped[str] = mapped_column(String(300), default="")
    created_by: Mapped[int | None] = mapped_column(Integer)
    created_at: Mapped[datetime] = ts(default=now)


class Page(Base):
    __tablename__ = "page"
    id: Mapped[int] = mapped_column(primary_key=True)
    file_original_id: Mapped[int] = mapped_column(ForeignKey("file_original.id"), index=True)
    source_index: Mapped[int] = mapped_column(Integer, default=0)
    kind: Mapped[str] = mapped_column(String(20), default="image")  # image | pdf_text
    original_key: Mapped[str | None] = mapped_column(String(300))  # normalized raster of the source page
    width: Mapped[int] = mapped_column(Integer, default=0)
    height: Mapped[int] = mapped_column(Integer, default=0)
    current_recipe_id: Mapped[int | None] = mapped_column(Integer)
    rendered_recipe_id: Mapped[int | None] = mapped_column(Integer)
    status: Mapped[str] = mapped_column(String(20), default="queued")  # queued|processing|ready|error
    error: Mapped[str] = mapped_column(Text, default="")
    tier: Mapped[str | None] = mapped_column(String(10))
    reviewed: Mapped[bool] = mapped_column(Boolean, default=False)
    stages: Mapped[dict] = mapped_column(JSON, default=dict)  # stage -> {status, tier, method, info}
    text: Mapped[str] = mapped_column(Text, default="")
    language: Mapped[str] = mapped_column(String(20), default="")
    render_key: Mapped[str | None] = mapped_column(String(300))  # cleaned page image (jpg/png)
    thumb_key: Mapped[str | None] = mapped_column(String(300))
    pdf_key: Mapped[str | None] = mapped_column(String(300))  # 1-page searchable pdf
    words_key: Mapped[str | None] = mapped_column(String(300))  # structured JSON (blocks/words/boxes)
    pipeline_version: Mapped[str] = mapped_column(String(20), default="")
    created_at: Mapped[datetime] = ts(default=now)
    updated_at: Mapped[datetime] = ts(default=now, onupdate=now)
    file: Mapped[FileOriginal] = relationship(lazy="joined")


class Recipe(Base):
    __tablename__ = "recipe"
    id: Mapped[int] = mapped_column(primary_key=True)
    page_id: Mapped[int] = mapped_column(ForeignKey("page.id", ondelete="CASCADE"), index=True)
    version: Mapped[int] = mapped_column(Integer)
    data: Mapped[dict] = mapped_column(JSON)
    created_by: Mapped[int | None] = mapped_column(Integer)  # None = automatic
    note: Mapped[str] = mapped_column(String(300), default="")
    created_at: Mapped[datetime] = ts(default=now)
    __table_args__ = (UniqueConstraint("page_id", "version"),)


class StageCandidate(Base):
    __tablename__ = "stage_candidate"
    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    page_id: Mapped[int] = mapped_column(ForeignKey("page.id", ondelete="CASCADE"), index=True)
    stage: Mapped[str] = mapped_column(String(30))
    method: Mapped[str] = mapped_column(String(60))
    params: Mapped[dict] = mapped_column(JSON, default=dict)
    score: Mapped[float] = mapped_column(Float, default=0)
    signals: Mapped[dict] = mapped_column(JSON, default=dict)
    chosen: Mapped[bool] = mapped_column(Boolean, default=False)
    chosen_by: Mapped[str] = mapped_column(String(10), default="auto")
    run_id: Mapped[str] = mapped_column(String(40), default="")
    pipeline_version: Mapped[str] = mapped_column(String(20), default="")
    created_at: Mapped[datetime] = ts(default=now)


class CorrectionLog(Base):
    __tablename__ = "correction_log"
    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    page_id: Mapped[int | None] = mapped_column(ForeignKey("page.id", ondelete="SET NULL"), index=True)
    document_id: Mapped[int | None] = mapped_column(Integer)
    stage: Mapped[str] = mapped_column(String(30))
    auto_choice: Mapped[Any] = mapped_column(JSON, nullable=True)
    user_choice: Mapped[Any] = mapped_column(JSON, nullable=True)
    scores: Mapped[dict] = mapped_column(JSON, default=dict)
    user_id: Mapped[int | None] = mapped_column(Integer)
    at: Mapped[datetime] = ts(default=now)


class RejectedItem(Base):
    __tablename__ = "rejected_item"
    id: Mapped[int] = mapped_column(primary_key=True)
    document_id: Mapped[int] = mapped_column(ForeignKey("document.id", ondelete="CASCADE"), unique=True)
    reason: Mapped[str] = mapped_column(String(200), default="")
    scores: Mapped[dict] = mapped_column(JSON, default=dict)
    size: Mapped[int] = mapped_column(BigInteger, default=0)
    rejected_at: Mapped[datetime] = ts(default=now)
    expires_at: Mapped[datetime] = ts(index=True)


class SearchWord(Base):
    """Vocabulary for typo tolerance (pg_trgm similarity)."""
    __tablename__ = "search_word"
    word: Mapped[str] = mapped_column(String(100), primary_key=True)
    __table_args__ = (Index("ix_search_word_trgm", "word", postgresql_using="gin",
                            postgresql_ops={"word": "gin_trgm_ops"}),)
