"""Folders (§6.1) and tags (§6.2)."""
from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel
from sqlalchemy import func, text
from sqlalchemy.orm import Session as DB

from .. import appsettings
from .. import models as m
from ..db import get_db, now
from ..deps import Principal, audit, client_ip, ui_user

router = APIRouter(prefix="/api", tags=["organize"])


def subtree_ids(db: DB, folder_id: int) -> list[int]:
    rows = db.execute(text("""
        WITH RECURSIVE t(id) AS (SELECT CAST(:id AS int) UNION ALL
            SELECT f.id FROM folder f JOIN t ON f.parent_id = t.id)
        SELECT id FROM t"""), {"id": folder_id}).all()
    return [r[0] for r in rows]


@router.get("/folders")
def list_folders(p: Principal = Depends(ui_user), db: DB = Depends(get_db)):
    counts = dict(db.query(m.Document.folder_id, func.count()).filter(
        m.Document.trashed_at.is_(None), m.Document.status != "rejected").group_by(m.Document.folder_id).all())
    return [{"id": f.id, "parent_id": f.parent_id, "name": f.name, "is_system": f.is_system,
             "count": counts.get(f.id, 0)} for f in db.query(m.Folder).order_by(m.Folder.name).all()]


class FolderIn(BaseModel):
    name: str
    parent_id: int | None = None


@router.post("/folders")
def create_folder(body: FolderIn, request: Request, p: Principal = Depends(ui_user), db: DB = Depends(get_db)):
    name = body.name.strip()[:300]
    if not name:
        raise HTTPException(400, "name_required")
    if body.parent_id is not None and db.get(m.Folder, body.parent_id) is None:
        raise HTTPException(404, "parent_not_found")
    if db.query(m.Folder).filter_by(parent_id=body.parent_id, name=name).first():
        raise HTTPException(409, "folder_exists")
    f = m.Folder(name=name, parent_id=body.parent_id)
    db.add(f)
    db.flush()
    audit(db, p, "folder_created", f.id, client_ip(request), name=name)
    db.commit()
    return {"id": f.id}


class FolderPatch(BaseModel):
    name: str | None = None
    parent_id: int | None = None
    move: bool = False  # parent_id given explicitly (None = root)


@router.patch("/folders/{fid}")
def update_folder(fid: int, body: FolderPatch, request: Request, p: Principal = Depends(ui_user),
                  db: DB = Depends(get_db)):
    f = db.get(m.Folder, fid)
    if f is None:
        raise HTTPException(404)
    if body.name is not None:
        if f.is_system:
            raise HTTPException(400, "system_folder")
        f.name = body.name.strip()[:300] or f.name
    if body.move:
        if f.is_system:
            raise HTTPException(400, "system_folder")
        if body.parent_id is not None and body.parent_id in subtree_ids(db, fid):
            raise HTTPException(400, "cycle")
        f.parent_id = body.parent_id
    if db.query(m.Folder).filter(m.Folder.parent_id == f.parent_id, m.Folder.name == f.name,
                                 m.Folder.id != f.id).first():
        raise HTTPException(409, "folder_exists")
    audit(db, p, "folder_updated", fid, client_ip(request), name=f.name, parent_id=f.parent_id)
    db.commit()
    return {"ok": True}


@router.delete("/folders/{fid}")
def delete_folder(fid: int, request: Request, confirm: bool = False, p: Principal = Depends(ui_user),
                  db: DB = Depends(get_db)):
    """Non-empty folders need confirm=true; documents inside go to Trash (restored without a folder)."""
    f = db.get(m.Folder, fid)
    if f is None:
        raise HTTPException(404)
    if f.is_system:
        raise HTTPException(400, "system_folder")
    ids = subtree_ids(db, fid)
    docs = db.query(m.Document).filter(m.Document.folder_id.in_(ids)).all()
    active = [d for d in docs if d.trashed_at is None]
    if (active or len(ids) > 1) and not confirm:
        raise HTTPException(409, f"not_empty:{len(active)}")
    for d in docs:
        d.folder_id = None
        if d.trashed_at is None:
            d.trashed_at, d.trashed_by = now(), p.user_id
    db.query(m.RegisteredChat).filter(m.RegisteredChat.folder_id.in_(ids)).update(
        {"folder_id": None}, synchronize_session=False)
    db.delete(f)
    audit(db, p, "folder_deleted", fid, client_ip(request), name=f.name, trashed=len(active))
    db.commit()
    return {"trashed": len(active)}


# ---------------------------------------------------------------- tags
@router.get("/tags")
def list_tags(p: Principal = Depends(ui_user), db: DB = Depends(get_db)):
    counts = dict(db.query(m.DocumentTag.tag_id, func.count()).join(m.Document).filter(
        m.Document.trashed_at.is_(None), m.Document.status != "rejected").group_by(m.DocumentTag.tag_id).all())
    return [{"id": t.id, "name": t.name, "color": t.color, "count": counts.get(t.id, 0)}
            for t in db.query(m.Tag).order_by(m.Tag.name).all()]


class TagIn(BaseModel):
    name: str
    color: str = "#7b8794"


def _clean_tag(name: str) -> str:
    return "/".join(p.strip() for p in name.split("/") if p.strip())[:300]


def _check_tag_len(db: DB, name: str) -> None:
    if len(name) > appsettings.get(db, "tag_max_length"):
        raise HTTPException(400, "tag_too_long")


@router.post("/tags")
def create_tag(body: TagIn, request: Request, p: Principal = Depends(ui_user), db: DB = Depends(get_db)):
    name = _clean_tag(body.name)
    if not name:
        raise HTTPException(400, "name_required")
    _check_tag_len(db, name)
    if db.query(m.Tag).filter(func.lower(m.Tag.name) == name.lower()).first():
        raise HTTPException(409, "tag_exists")
    t = m.Tag(name=name, color=body.color[:20])
    db.add(t)
    db.flush()
    audit(db, p, "tag_created", t.id, client_ip(request), name=name)
    db.commit()
    return {"id": t.id}


class TagPatch(BaseModel):
    name: str | None = None
    color: str | None = None


@router.patch("/tags/{tid}")
def update_tag(tid: int, body: TagPatch, request: Request, p: Principal = Depends(ui_user), db: DB = Depends(get_db)):
    t = db.get(m.Tag, tid)
    if t is None:
        raise HTTPException(404)
    if body.name is not None:
        new = _clean_tag(body.name)
        if not new:
            raise HTTPException(400, "name_required")
        _check_tag_len(db, new)
        old_name = t.name
        for child in db.query(m.Tag).filter(m.Tag.name.startswith(old_name + "/")).all():
            _check_tag_len(db, new + child.name[len(old_name):])
        if db.query(m.Tag).filter(func.lower(m.Tag.name) == new.lower(), m.Tag.id != tid).first():
            raise HTTPException(409, "tag_exists")
        old = t.name
        t.name = new
        # rename children of a hierarchical tag too: finance/* -> money/*
        for child in db.query(m.Tag).filter(m.Tag.name.startswith(old + "/")).all():
            child.name = new + child.name[len(old):]
    if body.color is not None:
        t.color = body.color[:20]
    audit(db, p, "tag_updated", tid, client_ip(request), name=t.name)
    db.commit()
    return {"ok": True}


class MergeIn(BaseModel):
    source_ids: list[int]
    target_id: int


@router.post("/tags/merge")
def merge_tags(body: MergeIn, request: Request, p: Principal = Depends(ui_user), db: DB = Depends(get_db)):
    if db.get(m.Tag, body.target_id) is None:
        raise HTTPException(404)
    src = [s for s in body.source_ids if s != body.target_id]
    db.execute(text("""INSERT INTO document_tag(document_id, tag_id)
                       SELECT document_id, :t FROM document_tag WHERE tag_id = ANY(:s)
                       ON CONFLICT DO NOTHING"""), {"t": body.target_id, "s": src})
    db.query(m.Tag).filter(m.Tag.id.in_(src)).delete(synchronize_session=False)
    audit(db, p, "tags_merged", body.target_id, client_ip(request), sources=src)
    db.commit()
    return {"ok": True}


@router.delete("/tags/{tid}")
def delete_tag(tid: int, request: Request, p: Principal = Depends(ui_user), db: DB = Depends(get_db)):
    t = db.get(m.Tag, tid)
    if t is None:
        raise HTTPException(404)
    db.delete(t)
    audit(db, p, "tag_deleted", tid, client_ip(request), name=t.name)
    db.commit()
    return {"ok": True}
