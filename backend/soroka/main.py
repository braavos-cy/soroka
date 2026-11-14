import logging

from fastapi import FastAPI

from .api import admin, auth, documents, ingest, organize, uploads
from .config import settings

logging.basicConfig(level=logging.INFO)

# API docs reveal every endpoint to scanners: off unless API_DOCS=true (the dev server turns them on)
_docs = settings().api_docs
app = FastAPI(title="Soroka API", version="0.1", docs_url="/api/docs" if _docs else None,
              openapi_url="/api/openapi.json" if _docs else None, redoc_url=None,
              description="Document management service. The UI, bots and browser extension all use this API.")
for r in (auth.router, ingest.router, uploads.router, organize.router, documents.router, admin.router):
    app.include_router(r)


@app.get("/api/health")
def health():
    return {"ok": True}
