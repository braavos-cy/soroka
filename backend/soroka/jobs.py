"""Job queue (RQ). Priority: high = live ingest, default = user-edit re-render, low = bulk backlog."""
from redis import Redis
from rq import Queue

from .config import settings

_redis: Redis | None = None


def redis() -> Redis:
    global _redis
    if _redis is None:
        _redis = Redis.from_url(settings().redis_url)
    return _redis


def queue(name: str) -> Queue:
    return Queue(name, connection=redis(), default_timeout=3600)


def enqueue_document(document_id: int, priority: str = "high") -> None:
    queue(priority).enqueue("soroka.pipeline.runner.process_document", document_id,
                            job_id=f"doc-{document_id}-{_nonce()}")


def enqueue_page(page_id: int, from_stage: str = "quality", priority: str = "default", forced: bool = False) -> None:
    queue(priority).enqueue("soroka.pipeline.runner.process_page_job", page_id, from_stage, forced)


def enqueue_finalize(document_id: int, priority: str = "default") -> None:
    queue(priority).enqueue("soroka.pipeline.runner.finalize_document", document_id)


def queue_lengths() -> dict[str, int]:
    return {n: len(queue(n)) for n in ("high", "default", "low")}


def _nonce() -> str:
    import secrets
    return secrets.token_hex(4)
