"""Documents, pages, recipes/editor, review queue, trash, rejected, downloads."""
import io
import json
import os
import zipfile
from datetime import datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import FileResponse, Response, StreamingResponse
from pydantic import BaseModel
from sqlalchemy import and_, exists, func, not_, or_, select, text
from sqlalchemy.orm import Session as DB

from .. import models as m
from ..db import get_db, now
from ..deps import Principal, admin_reauth, audit, client_ip, require_reauth, ui_user
from ..jobs import enqueue_document, enqueue_finalize, enqueue_page
from ..pipeline.recipe import EDITABLE, apply_edit, default_recipe, normalize
from ..search import build_tsquery, current_page_ids, headline, index_document, rank
from ..storage import storage
from .organize import subtree_ids

router = APIRouter(prefix="/api", tags=["documents"])

SORTS = {"received_desc": m.Document.received_at.desc(), "received_asc": m.Document.received_at.asc(),
         "date_desc": m.Document.document_date.desc().nullslast(), "title": m.Document.title.asc()}


def _ids(s: str | None) -> list[int]:
    return [int(x) for x in (s or "").split(",") if x.strip().isdigit()]


def _date(s: str | None) -> datetime | None:
    return datetime.fromisoformat(s) if s else None


def doc_summary(d: m.Document, first_page: int | None = None, snippet: str | None = None) -> dict:
    ev = d.ingest_event
    return {"id": d.id, "title": d.title, "folder_id": d.folder_id, "status": d.status, "tier": d.tier,
            "needs_review": d.needs_review, "page_count": d.page_count, "received_at": d.received_at,
            "document_date": d.document_date, "source": d.source_platform, "file_type": d.file_type,
            "language": d.language, "tags": [t.id for t in d.tags], "trashed_at": d.trashed_at,
            "first_page_id": first_page, "snippet": snippet,
            "sender": (ev.sender_name or ev.sender_phone or ev.sender_email) if ev else "",
            "chat": ev.chat_name if ev else ""}


def first_pages(db: DB, docs: list[m.Document]) -> dict[int, int]:
    vids = [d.current_version_id for d in docs if d.current_version_id]
    if not vids:
        return {}
    out = {}
    for v in db.query(m.DocumentVersion).filter(m.DocumentVersion.id.in_(vids)).all():
        if v.page_ids:
            out[v.document_id] = v.page_ids[0]
    return out


@router.get("/documents")
def list_documents(
        q: str = "", folder_id: int | None = None, subfolders: bool = True,
        tags_all: str = "", tags_any: str = "", tags_not: str = "",
        source: str = "", file_type: str = "", language: str = "", status: str = "",
        review: str = "", sender: str = "", chat: str = "",
        received_from: str | None = None, received_to: str | None = None,
        date_from: str | None = None, date_to: str | None = None,
        view: str = "active", sort: str = "received_desc", offset: int = 0, limit: int = Query(50, le=1000),
        p: Principal = Depends(ui_user), db: DB = Depends(get_db)):
    qry = db.query(m.Document)
    if view == "trash":
        qry = qry.filter(m.Document.trashed_at.is_not(None))
    elif view == "rejected":
        qry = qry.filter(m.Document.trashed_at.is_(None), m.Document.status == "rejected")
    else:
        qry = qry.filter(m.Document.trashed_at.is_(None), m.Document.status != "rejected")
    if folder_id is not None:
        ids = subtree_ids(db, folder_id) if subfolders else [folder_id]
        qry = qry.filter(m.Document.folder_id.in_(ids))
    for t in _ids(tags_all):
        qry = qry.filter(exists().where(and_(m.DocumentTag.document_id == m.Document.id, m.DocumentTag.tag_id == t)))
    if any_ := _ids(tags_any):
        qry = qry.filter(exists().where(and_(m.DocumentTag.document_id == m.Document.id,
                                             m.DocumentTag.tag_id.in_(any_))))
    if not_ids := _ids(tags_not):
        qry = qry.filter(~exists().where(and_(m.DocumentTag.document_id == m.Document.id,
                                              m.DocumentTag.tag_id.in_(not_ids))))
    if source:
        qry = qry.filter(m.Document.source_platform.in_(source.split(",")))
    if file_type:
        qry = qry.filter(m.Document.file_type.in_(file_type.split(",")))
    if language:
        qry = qry.filter(m.Document.language.in_(language.split(",")))
    if status:
        qry = qry.filter(m.Document.status.in_(status.split(",")))
    if review == "needs_review":
        qry = qry.filter(m.Document.needs_review.is_(True))
    elif review == "check":
        qry = qry.filter(m.Document.tier == "medium")
    elif review == "ok":
        qry = qry.filter(m.Document.needs_review.is_(False))
    if sender or chat:
        qry = qry.join(m.IngestEvent, m.IngestEvent.id == m.Document.ingest_event_id)
        if sender:
            like = f"%{sender}%"
            qry = qry.filter(or_(m.IngestEvent.sender_name.ilike(like), m.IngestEvent.sender_phone.ilike(like),
                                 m.IngestEvent.sender_email.ilike(like), m.IngestEvent.sender_username.ilike(like)))
        if chat:
            qry = qry.filter(m.IngestEvent.chat_name.ilike(f"%{chat}%"))
    if received_from:
        qry = qry.filter(m.Document.received_at >= _date(received_from))
    if received_to:
        qry = qry.filter(m.Document.received_at < _date(received_to) + timedelta(days=1))
    if date_from:
        qry = qry.filter(m.Document.document_date >= _date(date_from))
    if date_to:
        qry = qry.filter(m.Document.document_date < _date(date_to) + timedelta(days=1))

    tsq, terms = build_tsquery(db, q) if q.strip() else (None, [])
    total = None
    if tsq is not None:
        qry = qry.filter(m.Document.search_vector.op("@@")(tsq))
        total = qry.count()
        rows = (qry.add_columns(headline(tsq), rank(tsq)).order_by(rank(tsq).desc(), m.Document.received_at.desc())
                .offset(offset).limit(limit).all())
        docs = [(r[0], r[1]) for r in rows]
    else:
        total = qry.count()
        docs = [(d, None) for d in qry.order_by(SORTS.get(sort, SORTS["received_desc"]), m.Document.id.desc())
                .offset(offset).limit(limit).all()]
    fp = first_pages(db, [d for d, _ in docs])
    return {"total": total, "terms": terms,
            "items": [doc_summary(d, fp.get(d.id), s) for d, s in docs]}


def page_summary(p: m.Page) -> dict:
    return {"id": p.id, "kind": p.kind, "status": p.status, "tier": p.tier, "reviewed": p.reviewed,
            "width": p.width, "height": p.height, "language": p.language, "error": p.error[:500] if p.error else "",
            "rendered": p.rendered_recipe_id == p.current_recipe_id and p.render_key is not None,
            "stages": {k: {"status": v.get("status"), "tier": v.get("tier")} for k, v in (p.stages or {}).items()},
            "filename": p.file.filename if p.file else "", "updated_at": p.updated_at}


def _get_doc(db: DB, doc_id: int) -> m.Document:
    d = db.get(m.Document, doc_id)
    if d is None:
        raise HTTPException(404)
    return d


@router.get("/documents/{doc_id}")
def get_document(doc_id: int, p: Principal = Depends(ui_user), db: DB = Depends(get_db)):
    d = _get_doc(db, doc_id)
    ids = current_page_ids(db, d)
    pages = {pg.id: pg for pg in db.query(m.Page).filter(m.Page.id.in_(ids or [-1])).all()}
    ev = d.ingest_event
    files = db.query(m.FileOriginal).filter(m.FileOriginal.id.in_(d.source_file_ids or [-1])).all()
    versions = db.query(m.DocumentVersion).filter_by(document_id=d.id).order_by(m.DocumentVersion.number).all()
    rej = db.query(m.RejectedItem).filter_by(document_id=d.id).one_or_none()
    out = doc_summary(d, ids[0] if ids else None)
    out.update({
        "status_detail": d.status_detail, "has_pdf": bool(d.pdf_key),
        "pages": [page_summary(pages[i]) for i in ids if i in pages],
        "files": [{"id": f.id, "filename": f.filename, "mime": f.mime, "size": f.size,
                   "has_rendition": bool(f.rendition_key)} for f in files],
        "versions": [{"id": v.id, "number": v.number, "note": v.note, "created_at": v.created_at,
                      "pages": len(v.page_ids), "current": v.id == d.current_version_id} for v in versions],
        "rejected": {"reason": rej.reason, "expires_at": rej.expires_at} if rej else None,
        "event": None if ev is None else {
            "platform": ev.platform, "chat_id": ev.chat_id, "chat_name": ev.chat_name, "message_id": ev.message_id,
            "message_link": ev.message_link, "sender_id": ev.sender_id, "sender_name": ev.sender_name,
            "sender_phone": ev.sender_phone, "sender_username": ev.sender_username,
            "sender_email": ev.sender_email, "sent_at": ev.sent_at, "ingested_at": ev.ingested_at,
            "location": ev.location, "forwarded": ev.forwarded, "forward_info": ev.forward_info,
            "caption": ev.caption, "reply_to": ev.reply_to, "context": ev.context, "extra": ev.extra,
            "forced": ev.forced, "force_reason": ev.force_reason},
    })
    return out


class DocPatch(BaseModel):
    title: str | None = None
    folder_id: int | None = None
    document_date: str | None = None
    clear_date: bool = False
    tag_ids: list[int] | None = None


@router.patch("/documents/{doc_id}")
def update_document(doc_id: int, body: DocPatch, request: Request, p: Principal = Depends(ui_user),
                    db: DB = Depends(get_db)):
    d = _get_doc(db, doc_id)
    if body.title is not None:
        d.title = body.title.strip()[:500]
    if body.folder_id is not None:
        if db.get(m.Folder, body.folder_id) is None:
            raise HTTPException(404, "folder_not_found")
        d.folder_id = body.folder_id
    if body.clear_date:
        d.document_date = None
    elif body.document_date:
        d.document_date = datetime.fromisoformat(body.document_date)
    if body.tag_ids is not None:
        db.query(m.DocumentTag).filter_by(document_id=d.id).delete()
        for t in dict.fromkeys(body.tag_ids):
            if db.get(m.Tag, t):
                db.add(m.DocumentTag(document_id=d.id, tag_id=t))
    db.flush()
    db.refresh(d)
    index_document(db, d)
    db.commit()
    return {"ok": True}


class BulkIn(BaseModel):
    ids: list[int]
    action: str  # move | tag_add | tag_remove | trash | restore
    folder_id: int | None = None
    tag_ids: list[int] = []


@router.post("/documents/bulk")
def bulk(body: BulkIn, request: Request, p: Principal = Depends(ui_user), db: DB = Depends(get_db)):
    docs = db.query(m.Document).filter(m.Document.id.in_(body.ids or [-1])).all()
    if body.action == "move":
        if body.folder_id is None or db.get(m.Folder, body.folder_id) is None:
            raise HTTPException(400, "folder_required")
        for d in docs:
            d.folder_id = body.folder_id
    elif body.action in ("tag_add", "tag_remove"):
        for d in docs:
            for t in body.tag_ids:
                exists_ = db.get(m.DocumentTag, (d.id, t))
                if body.action == "tag_add" and not exists_ and db.get(m.Tag, t):
                    db.add(m.DocumentTag(document_id=d.id, tag_id=t))
                elif body.action == "tag_remove" and exists_:
                    db.delete(exists_)
    elif body.action == "trash":
        for d in docs:
            if d.trashed_at is None:
                d.trashed_at, d.trashed_by = now(), p.user_id
        audit(db, p, "documents_trashed", ",".join(str(d.id) for d in docs), client_ip(request))
    elif body.action == "restore":
        for d in docs:
            d.trashed_at = None
        audit(db, p, "documents_restored", ",".join(str(d.id) for d in docs), client_ip(request))
    else:
        raise HTTPException(400, "bad_action")
    db.flush()
    if body.action in ("tag_add", "tag_remove"):
        for d in docs:
            db.refresh(d)
            index_document(db, d)
    db.commit()
    return {"ok": True, "count": len(docs)}


@router.post("/documents/{doc_id}/rescue")
def rescue(doc_id: int, request: Request, p: Principal = Depends(ui_user), db: DB = Depends(get_db)):
    """Rejected -> force-save as a document and run the full pipeline (§4.2, §4.3)."""
    d = _get_doc(db, doc_id)
    db.query(m.RejectedItem).filter_by(document_id=d.id).delete()
    if d.ingest_event:
        d.ingest_event.forced, d.ingest_event.force_reason = True, "rescue"
    for pid in current_page_ids(db, d):
        pg = db.get(m.Page, pid)
        rec = db.get(m.Recipe, pg.current_recipe_id)
        auto = (pg.stages or {}).get("acceptance", {}).get("auto")
        db.add(m.CorrectionLog(page_id=pid, document_id=d.id, stage="acceptance", auto_choice=auto,
                               user_choice="document", scores=(pg.stages or {}).get("acceptance", {}).get("info", {}),
                               user_id=p.user_id))
        new = apply_edit(rec.data, "acceptance", {"value": "document"})
        _new_recipe(db, pg, new, p.user_id, "rescue")
    d.status = "processing"
    audit(db, p, "document_rescued", d.id, client_ip(request))
    db.commit()
    for pid in current_page_ids(db, d):
        enqueue_page(pid, "acceptance", "high")
    return {"ok": True}


@router.post("/documents/{doc_id}/reprocess")
def reprocess(doc_id: int, p: Principal = Depends(ui_user), db: DB = Depends(get_db)):
    """Re-run automatic stages for all pages; manual corrections are kept."""
    d = _get_doc(db, doc_id)
    for pid in current_page_ids(db, d):
        db.get(m.Page, pid).status = "queued"
    d.status = "processing"
    db.commit()
    for pid in current_page_ids(db, d):
        enqueue_page(pid, "quality", "default")
    return {"ok": True}


@router.delete("/documents/{doc_id}")
def purge_document(doc_id: int, request: Request, p: Principal = Depends(admin_reauth), db: DB = Depends(get_db)):
    """Permanent deletion incl. derived data, renditions, index entries and context (GDPR, §12)."""
    d = _get_doc(db, doc_id)
    purge(db, d)
    audit(db, p, "document_purged", doc_id, client_ip(request))
    db.commit()
    return {"ok": True}


def purge(db: DB, d: m.Document) -> None:
    st = storage()
    page_ids = set()
    for v in db.query(m.DocumentVersion).filter_by(document_id=d.id).all():
        page_ids.update(v.page_ids)
    # pages shared with other documents (copied pages) are kept
    shared = set()
    if page_ids:
        for v in db.query(m.DocumentVersion).filter(m.DocumentVersion.document_id != d.id).all():
            shared.update(set(v.page_ids) & page_ids)
    for pid in page_ids - shared:
        pg = db.get(m.Page, pid)
        if pg:
            st.delete_prefix(f"pages/{pid}")
            db.delete(pg)
    st.delete_prefix(f"documents/{d.id}")
    file_ids = list(d.source_file_ids or [])
    ev_id = d.ingest_event_id
    db.delete(d)
    db.flush()
    for fid in file_ids:
        fo = db.get(m.FileOriginal, fid)
        if fo is None or db.query(m.Page).filter_by(file_original_id=fid).count():
            continue
        others = db.query(m.FileOriginal).filter(m.FileOriginal.sha256 == fo.sha256, m.FileOriginal.id != fid).count()
        if not others:
            st.delete(fo.blob_key)
        st.delete(fo.rendition_key)
        db.delete(fo)
    if ev_id and not db.query(m.Document).filter_by(ingest_event_id=ev_id).count():
        ev = db.get(m.IngestEvent, ev_id)
        if ev:
            db.delete(ev)


@router.post("/trash/empty")
def empty_trash(request: Request, p: Principal = Depends(admin_reauth), db: DB = Depends(get_db)):
    docs = db.query(m.Document).filter(m.Document.trashed_at.is_not(None)).all()
    for d in docs:
        purge(db, d)
    audit(db, p, "trash_emptied", "", client_ip(request), count=len(docs))
    db.commit()
    return {"purged": len(docs)}


# ---------------------------------------------------------------- downloads
def _file_response(key: str, filename: str, mime: str, inline: bool = False):
    path = storage().path(key)
    if not path.exists():
        raise HTTPException(404, "blob_missing")
    return FileResponse(path, media_type=mime, filename=filename,
                        content_disposition_type="inline" if inline else "attachment")


@router.get("/files/{file_id}")
def download_original(file_id: int, rendition: bool = False, inline: bool = False,
                      p: Principal = Depends(ui_user), db: DB = Depends(get_db)):
    fo = db.get(m.FileOriginal, file_id)
    if fo is None:
        raise HTTPException(404)
    if rendition and fo.rendition_key:
        return _file_response(fo.rendition_key, os.path.splitext(fo.filename)[0] + ".pdf", "application/pdf", inline)
    return _file_response(fo.blob_key, fo.filename, fo.mime, inline)


def _safe_name(s: str) -> str:
    return "".join(c for c in s if c not in '\\/:*?"<>|\n\r\t')[:150] or "document"


@router.get("/documents/{doc_id}/download")
def download(doc_id: int, kind: str = "pdf", inline: bool = False, p: Principal = Depends(ui_user),
             db: DB = Depends(get_db)):
    d = _get_doc(db, doc_id)
    name = _safe_name(d.title)
    if kind == "pdf":
        if not d.pdf_key:
            raise HTTPException(404, "not_ready")
        return _file_response(d.pdf_key, name + ".pdf", "application/pdf", inline)
    if kind == "text":
        return Response(d.content or "", media_type="text/plain; charset=utf-8",
                        headers={"Content-Disposition": f"attachment; filename*=UTF-8''{_q(name)}.txt"})
    if kind == "original":
        files = db.query(m.FileOriginal).filter(m.FileOriginal.id.in_(d.source_file_ids or [-1])).all()
        if len(files) == 1:
            return _file_response(files[0].blob_key, files[0].filename, files[0].mime)
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
            for f in files:
                z.writestr(f"{f.id}_{f.filename}", storage().get(f.blob_key))
        return Response(buf.getvalue(), media_type="application/zip",
                        headers={"Content-Disposition": f"attachment; filename*=UTF-8''{_q(name)}.zip"})
    raise HTTPException(400, "bad_kind")


class ZipIn(BaseModel):
    ids: list[int]
    kind: str = "pdf"  # pdf | original | text


@router.post("/documents/download-zip")
def download_zip(body: ZipIn, p: Principal = Depends(ui_user), db: DB = Depends(get_db)):
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        for d in db.query(m.Document).filter(m.Document.id.in_(body.ids or [-1])).all():
            name = f"{d.id}_{_safe_name(d.title)}"
            if body.kind == "pdf" and d.pdf_key:
                z.writestr(name + ".pdf", storage().get(d.pdf_key))
            elif body.kind == "text":
                z.writestr(name + ".txt", d.content or "")
            elif body.kind == "original":
                for f in db.query(m.FileOriginal).filter(m.FileOriginal.id.in_(d.source_file_ids or [-1])).all():
                    z.writestr(f"{name}/{f.filename}", storage().get(f.blob_key))
    return Response(buf.getvalue(), media_type="application/zip",
                    headers={"Content-Disposition": "attachment; filename=documents.zip"})


def _q(s: str) -> str:
    from urllib.parse import quote
    return quote(s)


# ---------------------------------------------------------------- pages
def _get_page(db: DB, page_id: int) -> m.Page:
    pg = db.get(m.Page, page_id)
    if pg is None:
        raise HTTPException(404)
    return pg


@router.get("/pages/{page_id}/image")
def page_image(page_id: int, variant: str = "render", p: Principal = Depends(ui_user), db: DB = Depends(get_db)):
    pg = _get_page(db, page_id)
    key = {"render": pg.render_key, "thumb": pg.thumb_key, "original": pg.original_key or pg.render_key}.get(variant)
    if not key:
        raise HTTPException(404, "not_ready")
    mime = "image/png" if key.endswith(".png") else "image/jpeg"
    resp = _file_response(key, os.path.basename(key), mime, inline=True)
    resp.headers["Cache-Control"] = "private, max-age=86400"
    return resp


@router.get("/pages/{page_id}")
def get_page(page_id: int, p: Principal = Depends(ui_user), db: DB = Depends(get_db)):
    pg = _get_page(db, page_id)
    rec = db.get(m.Recipe, pg.current_recipe_id) if pg.current_recipe_id else None
    versions = db.query(m.Recipe.id, m.Recipe.version, m.Recipe.created_by, m.Recipe.note, m.Recipe.created_at) \
        .filter_by(page_id=pg.id).order_by(m.Recipe.version).all()
    out = page_summary(pg)
    out.update({
        "recipe": normalize(rec.data if rec else None), "recipe_version": rec.version if rec else None,
        "history": [{"id": v.id, "version": v.version, "manual": v.created_by is not None, "note": v.note,
                     "created_at": v.created_at, "current": rec is not None and v.id == rec.id} for v in versions],
        "stages_detail": pg.stages or {}, "text": pg.text,
        "render_url": f"/api/pages/{pg.id}/image?variant=render&v={(pg.render_key or '').split('-')[-1]}",
        "original_url": f"/api/pages/{pg.id}/image?variant=original" if pg.original_key else None,
    })
    return out


@router.get("/pages/{page_id}/structure")
def page_structure(page_id: int, p: Principal = Depends(ui_user), db: DB = Depends(get_db)):
    pg = _get_page(db, page_id)
    if not pg.words_key:
        raise HTTPException(404, "not_ready")
    return Response(storage().get(pg.words_key), media_type="application/json")


def _new_recipe(db: DB, pg: m.Page, data: dict, user_id: int | None, note: str) -> m.Recipe:
    last = db.query(m.Recipe).filter_by(page_id=pg.id).order_by(m.Recipe.version.desc()).first()
    r = m.Recipe(page_id=pg.id, version=(last.version + 1) if last else 1, data=data, created_by=user_id, note=note)
    db.add(r)
    db.flush()
    pg.current_recipe_id = r.id
    return r


def _docs_with_page(db: DB, page_id: int) -> list[m.Document]:
    return db.query(m.Document).join(m.DocumentVersion, m.DocumentVersion.id == m.Document.current_version_id) \
        .filter(m.DocumentVersion.page_ids.op("@>")(func.jsonb_build_array(page_id))).all()


class EditIn(BaseModel):
    stage: str
    value: dict | None = None
    reset: bool = False  # back to automatic for this stage


@router.post("/pages/{page_id}/edit")
def edit_page(page_id: int, body: EditIn, request: Request, p: Principal = Depends(ui_user), db: DB = Depends(get_db)):
    """Change one stage in the recipe; downstream automatic stages re-run, manual ones are kept."""
    pg = _get_page(db, page_id)
    if pg.kind != "image" and body.stage not in ("ocr",):
        raise HTTPException(400, "not_editable_for_text_page")
    rec = db.get(m.Recipe, pg.current_recipe_id)
    try:
        new = apply_edit(rec.data, body.stage, body.value, body.reset)
    except ValueError as e:
        raise HTTPException(400, str(e))
    st = (pg.stages or {}).get(body.stage, {})
    db.add(m.CorrectionLog(page_id=pg.id, stage=body.stage, auto_choice=st.get("auto"),
                           user_choice=None if body.reset else body.value,
                           scores={"tier": st.get("tier"), "method": st.get("method"),
                                   "info": {k: v for k, v in (st.get("info") or {}).items() if k != "candidates"}},
                           user_id=p.user_id))
    _new_recipe(db, pg, new, p.user_id, f"{'reset' if body.reset else 'edit'}:{body.stage}")
    pg.status = "queued"
    pg.reviewed = True
    warnings = []
    if body.stage in ("crop", "orientation") and normalize(new)["deskew"]["manual"]:
        warnings.append("manual_deskew_kept")
    db.commit()
    if body.stage == "acceptance" and not body.reset:
        _apply_acceptance(db, pg, new["acceptance"]["value"], p)
    enqueue_page(pg.id, body.stage, "default")
    return {"ok": True, "warnings": warnings}


def _apply_acceptance(db: DB, pg: m.Page, value: str, p: Principal) -> None:
    for d in _docs_with_page(db, pg.id):
        if value == "document" and d.status == "rejected":
            db.query(m.RejectedItem).filter_by(document_id=d.id).delete()
            d.status = "processing"
        elif value == "non_document":
            ids = current_page_ids(db, d)
            if len(ids) == 1:
                from ..pipeline.runner import _reject
                _reject(db, d, "marked_non_document")
            else:  # drop the page from this document (new version, page kept in history)
                _new_version(db, d, [i for i in ids if i != pg.id], p.user_id, "remove non-document page")
    db.commit()


def _new_version(db: DB, d: m.Document, page_ids: list[int], user_id: int | None, note: str) -> m.DocumentVersion:
    last = db.query(func.max(m.DocumentVersion.number)).filter_by(document_id=d.id).scalar() or 0
    v = m.DocumentVersion(document_id=d.id, number=last + 1, page_ids=page_ids, note=note, created_by=user_id)
    db.add(v)
    db.flush()
    d.current_version_id = v.id
    d.page_count = len(page_ids)
    return v


class GotoIn(BaseModel):
    version: int


@router.post("/pages/{page_id}/recipe/goto")
def goto_recipe(page_id: int, body: GotoIn, p: Principal = Depends(ui_user), db: DB = Depends(get_db)):
    """Undo/redo: move the current pointer to another recipe version and re-render."""
    pg = _get_page(db, page_id)
    r = db.query(m.Recipe).filter_by(page_id=pg.id, version=body.version).one_or_none()
    if r is None:
        raise HTTPException(404)
    pg.current_recipe_id = r.id
    pg.status = "queued"
    db.commit()
    # re-render the chosen version exactly (no re-estimation -> no new auto version, redo stays valid)
    enqueue_page(pg.id, "ocr", "default")
    return {"ok": True}


@router.post("/pages/{page_id}/reset")
def reset_page(page_id: int, p: Principal = Depends(ui_user), db: DB = Depends(get_db)):
    """Reset to automatic: new recipe version with every stage automatic."""
    pg = _get_page(db, page_id)
    _new_recipe(db, pg, default_recipe(), p.user_id, "reset_all")
    pg.status = "queued"
    db.commit()
    enqueue_page(pg.id, "quality", "default")
    return {"ok": True}


class ReviewIn(BaseModel):
    action: str  # accept | unaccept


@router.post("/pages/{page_id}/review")
def review_page(page_id: int, body: ReviewIn, p: Principal = Depends(ui_user), db: DB = Depends(get_db)):
    pg = _get_page(db, page_id)
    pg.reviewed = body.action == "accept"
    for stage, st in (pg.stages or {}).items():
        if st.get("tier") in ("low", "medium") and pg.reviewed:
            db.add(m.CorrectionLog(page_id=pg.id, stage=stage, auto_choice=st.get("auto"),
                                   user_choice=st.get("auto"), scores={"tier": st.get("tier"), "accepted": True},
                                   user_id=p.user_id))
    db.flush()
    for d in _docs_with_page(db, pg.id):
        ids = current_page_ids(db, d)
        pages = db.query(m.Page).filter(m.Page.id.in_(ids)).all()
        d.needs_review = any(x.tier == "low" and not x.reviewed for x in pages)
    db.commit()
    return {"ok": True}


@router.get("/review")
def review_queue(include_medium: bool = False, limit: int = 100, p: Principal = Depends(ui_user),
                 db: DB = Depends(get_db)):
    tiers = ["low", "medium"] if include_medium else ["low"]
    rows = db.execute(text("""
        SELECT pg.id AS page_id, d.id AS document_id, d.title, pg.tier, pg.stages, d.received_at,
               (SELECT ord FROM jsonb_array_elements(v.page_ids) WITH ORDINALITY e(pid, ord)
                 WHERE e.pid = to_jsonb(pg.id) LIMIT 1) AS page_no
        FROM document d
        JOIN document_version v ON v.id = d.current_version_id
        JOIN page pg ON v.page_ids @> jsonb_build_array(pg.id)
        WHERE d.trashed_at IS NULL AND d.status IN ('ready', 'processing', 'rejected')
          AND pg.reviewed = false AND pg.status = 'ready' AND pg.tier = ANY(:tiers)
          AND (d.status <> 'rejected')
        ORDER BY d.received_at DESC LIMIT :lim"""), {"tiers": tiers, "lim": limit}).mappings().all()
    out = []
    for r in rows:
        flagged = [{"stage": k, "tier": v.get("tier"), "method": v.get("method")}
                   for k, v in (r["stages"] or {}).items() if v.get("tier") in tiers]
        out.append({"page_id": r["page_id"], "document_id": r["document_id"], "title": r["title"],
                    "tier": r["tier"], "page_no": r["page_no"], "received_at": r["received_at"], "flagged": flagged})
    return out


@router.get("/stats")
def stats(p: Principal = Depends(ui_user), db: DB = Depends(get_db)):
    from ..jobs import queue_lengths
    c = dict(db.query(m.Document.status, func.count()).filter(m.Document.trashed_at.is_(None))
             .group_by(m.Document.status).all())
    return {"documents": c, "review": db.query(m.Document).filter(m.Document.needs_review.is_(True),
                                                                  m.Document.trashed_at.is_(None),
                                                                  m.Document.status != "rejected").count(),
            "trash": db.query(m.Document).filter(m.Document.trashed_at.is_not(None)).count(),
            "queues": queue_lengths()}
