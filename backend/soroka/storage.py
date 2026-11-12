"""Blob storage behind an interface (local filesystem now; S3/MinIO can implement the same methods)."""
import hashlib
import os
import shutil
from pathlib import Path

from .config import settings


class LocalStorage:
    def __init__(self, root: str):
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True)

    def path(self, key: str) -> Path:
        p = (self.root / key).resolve()
        if self.root.resolve() not in p.parents:
            raise ValueError("bad key")
        return p

    def put(self, key: str, data: bytes) -> str:
        p = self.path(key)
        p.parent.mkdir(parents=True, exist_ok=True)
        tmp = p.with_suffix(p.suffix + ".tmp")
        tmp.write_bytes(data)
        os.replace(tmp, p)
        return key

    def put_file(self, key: str, src: str | Path) -> str:
        p = self.path(key)
        p.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(src, p)
        return key

    def get(self, key: str) -> bytes:
        return self.path(key).read_bytes()

    def exists(self, key: str) -> bool:
        return self.path(key).exists()

    def size(self, key: str) -> int:
        try:
            return self.path(key).stat().st_size
        except FileNotFoundError:
            return 0

    def delete(self, key: str | None) -> None:
        if not key:
            return
        try:
            self.path(key).unlink()
        except FileNotFoundError:
            pass

    def delete_prefix(self, prefix: str) -> None:
        shutil.rmtree(self.path(prefix), ignore_errors=True)

    def put_original(self, data: bytes) -> tuple[str, str]:
        """Content-addressed, write-once. Originals are never modified."""
        sha = hashlib.sha256(data).hexdigest()
        key = f"originals/{sha[:2]}/{sha}"
        if not self.exists(key):
            self.put(key, data)
        return key, sha

    def disk_free_bytes(self) -> int:
        return shutil.disk_usage(self.root).free


_storage: LocalStorage | None = None


def storage() -> LocalStorage:
    global _storage
    if _storage is None:
        _storage = LocalStorage(settings().data_dir)
    return _storage
