"""Search behind an interface: PostgreSQL FTS (russian + english snowball stemming) + pg_trgm typo tolerance.
Russian morphology: the russian snowball stemmer maps договор/договора/договору to one lexeme.
ё/е: normalized to е on both index and query side. Prefix search: every term is also a prefix (:*)."""
import re

from sqlalchemy import func, literal, text
from sqlalchemy.orm import Session as DB

from . import models as m

WORD_RE = re.compile(r"[0-9A-Za-zА-Яа-яЁё]+")
MAX_BODY = 400_000


def norm(s: str) -> str:
    return (s or "").replace("ё", "е").replace("Ё", "Е")


def document_meta_text(doc: m.Document, filenames: list[str]) -> str:
    ev = doc.ingest_event
    parts = list(filenames)
    if ev:
        parts += [ev.chat_name, ev.sender_name, ev.sender_phone, ev.sender_username, ev.sender_email,
                  ev.caption, ev.platform]
        ex = ev.extra or {}
        parts += [str(ex.get(k, "")) for k in ("subject", "from", "to", "cc", "body")]
        if ev.reply_to:
            parts.append(str(ev.reply_to.get("text", "")))
        parts += [str(c.get("text", "")) + " " + str(c.get("sender", "")) for c in (ev.context or [])]
    parts += [t.name.replace("/", " ") for t in doc.tags]
    return "\n".join(p for p in parts if p)


def index_document(db: DB, doc: m.Document) -> None:
    filenames = [r[0] for r in db.query(m.FileOriginal.filename)
                 .join(m.Page, m.Page.file_original_id == m.FileOriginal.id)
                 .filter(m.Page.id.in_(current_page_ids(db, doc))).distinct().all()]
    title = norm(doc.title)
    meta = norm(document_meta_text(doc, filenames))
    body = norm(doc.content)[:MAX_BODY]
    doc.search_text = "\n".join([title, meta, body])
    db.flush()
    db.execute(text("""
        UPDATE document SET search_vector =
            setweight(to_tsvector('russian', :title), 'A') || setweight(to_tsvector('english', :title), 'A') ||
            setweight(to_tsvector('russian', :meta), 'B') || setweight(to_tsvector('english', :meta), 'B') ||
            setweight(to_tsvector('russian', :body), 'C') || setweight(to_tsvector('english', :body), 'D')
        WHERE id = :id"""), {"title": title, "meta": meta, "body": body, "id": doc.id})
    words = {w.lower() for w in WORD_RE.findall(title + " " + meta + " " + body) if 3 <= len(w) <= 40 and not w.isdigit()}
    if words:
        db.execute(text("INSERT INTO search_word(word) SELECT unnest(CAST(:w AS text[])) ON CONFLICT DO NOTHING"),
                   {"w": list(words)})


def current_page_ids(db: DB, doc: m.Document) -> list[int]:
    if not doc.current_version_id:
        return []
    v = db.get(m.DocumentVersion, doc.current_version_id)
    return list(v.page_ids) if v else []


def _term_query(db: DB, term: str):
    t = norm(term.lower())
    q = (func.to_tsquery("russian", literal(f"{t}:*"))
         .op("||")(func.to_tsquery("english", literal(f"{t}:*"))))
    if len(t) >= 4 and not t.isdigit():
        similar = [r[0] for r in db.execute(
            text("SELECT word FROM search_word WHERE word % :t AND word <> :t "
                 "ORDER BY similarity(word, :t) DESC LIMIT 3"), {"t": t}).all()]
        for w in similar:
            q = q.op("||")(func.to_tsquery("russian", literal(norm(w))))
    return q


def parse_query(q: str) -> list[tuple[str, str]]:
    """Returns [(op, term)] where op in AND, OR, NOT. Supports `-word` and `OR`/`ИЛИ`."""
    out: list[tuple[str, str]] = []
    pending_or = False
    for raw in (q or "").split():
        if raw.upper() in ("OR", "ИЛИ", "|"):
            pending_or = True
            continue
        neg = raw.startswith("-")
        for w in WORD_RE.findall(raw):
            out.append(("NOT" if neg else ("OR" if pending_or and out else "AND"), w))
            pending_or = False
    return out


def build_tsquery(db: DB, q: str):
    parts = parse_query(q)
    expr = None
    for op, term in parts:
        tq = _term_query(db, term)
        if op == "NOT":
            tq = func.tsquery_not(tq)  # the function behind the prefix !! operator
            expr = tq if expr is None else expr.op("&&")(tq)
        elif expr is None:
            expr = tq
        else:
            expr = expr.op("||" if op == "OR" else "&&")(tq)
    return expr, [t for op, t in parts if op != "NOT"]


HL_OPTS = "StartSel=\x01,StopSel=\x02,MaxFragments=2,MaxWords=18,MinWords=6,FragmentDelimiter= … "


def headline(tsq):
    return func.ts_headline("russian", m.Document.search_text, tsq, HL_OPTS)


def rank(tsq):
    return func.ts_rank_cd(m.Document.search_vector, tsq)
