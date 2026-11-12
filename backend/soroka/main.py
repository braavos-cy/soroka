import logging

from fastapi import FastAPI

from .api import admin, auth, documents, ingest, organize

logging.basicConfig(level=logging.INFO)

app = FastAPI(title="Soroka API", version="0.1", docs_url="/api/docs", openapi_url="/api/openapi.json",
              description="Document management service. The UI, bots and browser extension all use this API.")
for r in (auth.router, ingest.router, organize.router, documents.router, admin.router):
    app.include_router(r)


@app.get("/api/health")
def health():
    return {"ok": True}
