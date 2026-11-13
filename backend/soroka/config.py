from functools import lru_cache

from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    database_url: str = "postgresql+psycopg://soroka:soroka@db:5432/soroka"
    redis_url: str = "redis://redis:6379/0"
    data_dir: str = "/data"
    # Shared secret used by connector containers (WhatsApp, Telegram) to call the core API
    connector_token: str = "change-me"
    bootstrap_admin_email: str = "admin@example.com"
    bootstrap_admin_password: str = ""
    cookie_secure: bool = True
    api_docs: bool = False  # serve /api/docs + /api/openapi.json
    session_hours: int = 24 * 7
    reauth_minutes: int = 10
    clamav_host: str = ""  # e.g. "clamav" -> scan uploads via clamd INSTREAM
    clamav_port: int = 3310
    smtp_host: str = ""
    smtp_port: int = 587
    smtp_user: str = ""
    smtp_password: str = ""
    smtp_from: str = ""
    alert_email: str = ""
    pipeline_version: str = "1.1"  # 1.1: OCR-based acceptance, new boundary detectors, orientation fixes
    tesseract_threads: int = 2


@lru_cache
def settings() -> Settings:
    return Settings()
