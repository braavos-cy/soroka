"""Search behind an interface: PostgreSQL FTS (russian + english snowball stemming) + pg_trgm typo tolerance.
Russian morphology: the russian snowball stemmer maps договор/договора/договору to one lexeme.
ё/е: normalized to е on both index and query side. Prefix search: every term is also a prefix (:*)."""
import bisect
import re

from sqlalchemy import func, literal, text
from sqlalchemy.orm import Session as DB

from . import models as m

WORD_RE = re.compile(r"[0-9A-Za-zА-Яа-яЁё]+")
MAX_BODY = 400_000


# Queries are split into words by WORD_RE, but PostgreSQL's text parser keeps things like "IMG_1A2B.jpg",
# "12.05.2024" or "user@mail.ru" as ONE token (file / host / e-mail), so their parts could not be found.
# Indexed text therefore gets an invisible break (zero-width space) after every punctuation character: the parser
# then sees the same words the query does, and the text still reads the same when shown as a search hit.
ZWSP = "​"
PART = "\x04"  # separates title / meta / body inside document.search_text
_PUNCT = re.compile(r"([^0-9A-Za-zА-Яа-яЁё\s])")
_CTRL = str.maketrans({c: " " for c in "\x01\x02\x03\x04" + ZWSP})


def norm(s: str) -> str:
    return (s or "").replace("ё", "е").replace("Ё", "Е")


def prepare(s: str) -> str:
    """Text as it is indexed and stored for hit display."""
    return _PUNCT.sub(lambda mo: mo.group(1) + ZWSP, norm(s).translate(_CTRL))


def document_meta_parts(doc: m.Document) -> list[tuple[str, str]]:
    """Searchable metadata as (where, text): `where` names the field shown in the document's info panel
    (chat, sender, caption, email, reply, context:<index in event.context>, tags)."""
    ev = doc.ingest_event
    parts: list[tuple[str, str]] = []
    if ev:
        parts += [("chat", ev.chat_name), ("sender", ev.sender_name), ("sender", ev.sender_phone),
                  ("sender", ev.sender_username), ("sender", ev.sender_email), ("caption", ev.caption),
                  ("source", ev.platform)]
        ex = ev.extra or {}
        parts += [("email", str(ex.get(k, ""))) for k in ("subject", "from", "to", "cc", "body")]
        if ev.reply_to:
            parts.append(("reply", str(ev.reply_to.get("text", ""))))
        parts += [(f"context:{i}", str(c.get("text", "")) + " " + str(c.get("sender", "")))
                  for i, c in enumerate(ev.context or [])]
    parts += [("tags", t.name.replace("/", " ")) for t in doc.tags]
    return [(w, p) for w, p in parts if p]


def document_meta_text(doc: m.Document, filenames: list[str]) -> str:
    return "\n".join([f for f in filenames if f] + [p for _, p in document_meta_parts(doc)])


def _plain(s: str) -> str:
    """A piece of indexed text the way split_hits returns it: normalized, single spaces."""
    return " ".join(norm(s).translate(_CTRL).split())


class _Locator:
    """Finds which of several labelled pieces of text a search hit comes from."""

    def __init__(self, pieces: list[tuple[object, str]]):
        self.text, self.starts, self.labels, self.cursor = "", [], [], 0
        for label, raw in pieces:
            p = _plain(raw)
            if not p:
                continue
            if self.text:
                self.text += " "
            self.starts.append(len(self.text))
            self.labels.append(label)
            self.text += p

    def find(self, hit: str):
        """hit: fragment with \\x01…\\x02 marks. Returns the label of the piece holding its first marked word."""
        a = hit.find("\x01")
        plain = hit.replace("\x01", "").replace("\x02", "")
        pos = self.text.find(plain, self.cursor)  # hits come in text order: the same phrase twice -> two places
        if pos < 0:
            pos = self.text.find(plain)
        if pos >= 0:
            self.cursor = pos + 1
            pos += a
        else:  # the fragment runs over something that is not in the pieces: fall back to the word itself
            pos = self.text.find(hit[a + 1:hit.find("\x02", a)])
        if pos < 0:
            return None
        return self.labels[bisect.bisect_right(self.starts, pos) - 1]


def locate_hits(doc: m.Document, where: str, hits: list[str]) -> list[dict]:
    """Adds to every hit where exactly it is, so the UI can open that place:
    text -> page (index in the current version), context -> field (see document_meta_parts)."""
    if where == "title":
        return [{"where": "title", "text": h} for h in hits]
    if where == "text":
        loc = _Locator(list(enumerate((doc.content or "")[:MAX_BODY].split("\f"))))
        return [{"where": "text", "text": h, "page": loc.find(h)} for h in hits]
    loc = _Locator(document_meta_parts(doc))
    out = []
    for h in hits:
        field = loc.find(h)
        # not in any metadata field: the word is in the original file name, which opens like a title hit
        out.append({"where": "context", "text": h, "field": field} if field else {"where": "title", "text": h})
    return out


def index_document(db: DB, doc: m.Document) -> None:
    filenames = [r[0] for r in db.query(m.FileOriginal.filename)
                 .join(m.Page, m.Page.file_original_id == m.FileOriginal.id)
                 .filter(m.Page.id.in_(current_page_ids(db, doc))).distinct().all()]
    title = prepare(doc.title)
    meta = prepare(document_meta_text(doc, filenames))
    body = prepare((doc.content or "")[:MAX_BODY])
    doc.search_text = PART.join([title, meta, body])
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


FUZZY_MIN_SIMILARITY = 0.3  # pg_trgm's default: уплоты -> уплаты is about 0.33


def _term_query(db: DB, term: str):
    t = norm(term.lower())
    # a single letter is matched as a whole word only: as a prefix it would match every word starting with it
    lex = f"{t}:*" if len(t) >= 2 else t
    q = func.to_tsquery("russian", literal(lex)).op("||")(func.to_tsquery("english", literal(lex)))
    if len(t) >= 4 and not t.isdigit():
        # typo tolerance, only for a word the documents do not contain as typed: a correctly spelled word must
        # not drag in look-alikes (доходах -> походах)
        known = db.execute(text("SELECT 1 FROM search_word WHERE word LIKE :p LIMIT 1"),
                           {"p": t.replace("\\", "").replace("%", "").replace("_", "") + "%"}).first()
        if known is None:
            similar = [r[0] for r in db.execute(
                text("SELECT word FROM search_word WHERE word % :t AND word <> :t AND similarity(word, :t) >= :s "
                     "ORDER BY similarity(word, :t) DESC LIMIT 3"), {"t": t, "s": FUZZY_MIN_SIMILARITY}).all()]
            for w in similar:
                q = q.op("||")(func.to_tsquery("russian", literal(norm(w))))
    return q


def _is_stop_word(db: DB, term: str) -> bool:
    """о, и, в, the, of …: words the index does not keep in that language. Searching for them only adds noise —
    as a prefix in the other language's index "о" matched октября, общества and every other о-word."""
    t = norm(term.lower())
    return bool(db.execute(text("SELECT numnode(to_tsquery('russian', :t)) = 0 OR numnode(to_tsquery('english', :t)) = 0"),
                           {"t": t}).scalar())


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


_QUOTED = re.compile(r'"([^"]*)"')
_W = "0-9A-Za-zА-Яа-яЁё"


def split_quoted(q: str) -> tuple[list[list[str]], str]:
    """'"справка о доходах" 2023' -> ([[справка, о, доходах]], ' 2023'): the quoted phrases as word lists, and
    the rest of the query."""
    q = q or ""
    phrases = [w for w in (WORD_RE.findall(norm(p)) for p in _QUOTED.findall(q)) if w]
    return phrases, _QUOTED.sub(" ", q).replace('"', " ")


def exact_filters(q: str) -> list:
    """SQL conditions for the quoted phrases: exactly these words, in this order, next to each other (any
    punctuation or spacing between them, any letter case). The index only knows word stems, so the stored text
    is checked itself."""
    sep = f"[^{_W}]+"
    return [m.Document.search_text.op("~*")(literal(r"\m" + sep.join(re.escape(w) for w in words) + r"\M"))
            for words in split_quoted(q)[0]]


def exact_hit_filter(q: str):
    """For hit lines: None when the query has no quoted phrase, otherwise a test 'this line holds one of them'."""
    phrases = split_quoted(q)[0]
    if not phrases:
        return None
    sep = f"[^{_W}]+"
    pats = [re.compile(f"(?<![{_W}])" + sep.join(re.escape(w) for w in words) + f"(?![{_W}])", re.IGNORECASE)
            for words in phrases]
    return lambda hit: any(p.search(hit.replace("\x01", "").replace("\x02", "")) for p in pats)


def build_tsquery(db: DB, q: str):
    phrases, q = split_quoted(q)
    expr, terms = _build_words_tsquery(db, q)
    for words in phrases:  # found through the index by stems; exact_filters then keeps the exact wording
        tq = (func.phraseto_tsquery("russian", literal(" ".join(words).lower())) if len(words) > 1 else
              func.to_tsquery("russian", literal(words[0].lower())).op("||")(
                  func.to_tsquery("english", literal(words[0].lower()))))
        expr = tq if expr is None else expr.op("&&")(tq)
        terms += words
    return expr, terms


def _build_words_tsquery(db: DB, q: str):
    parts = parse_query(q)
    meaningful = [(op, term) for op, term in parts if not _is_stop_word(db, term)]
    if any(op != "NOT" for op, _ in meaningful):  # a query made only of such words is searched as typed
        parts = meaningful
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


MAX_HITS = 30
HL_OPTS = f"StartSel=\x01,StopSel=\x02,MaxFragments={MAX_HITS},MaxWords=16,MinWords=6,FragmentDelimiter=\x03"


def headline(tsq):
    return func.ts_headline("russian", m.Document.search_text, tsq, HL_OPTS)


def split_hits(hl: str | None) -> list[str]:
    """ts_headline output -> one single-line fragment per place the words occur (hits marked \\x01 … \\x02)."""
    return [" ".join(f.replace(ZWSP, "").split()) for f in (hl or "").split("\x03") if "\x01" in f]


def headlines_by_part(tsq, q: str = "") -> list:
    """Three headline columns, one per part of search_text (title, meta, body — see index_document), so every
    occurrence can say where it was found. When the query can be read as a phrase, three more columns follow with
    the places of the whole phrase (see merge_hits)."""
    st = func.coalesce(m.Document.search_text, "")
    ptq = phrase_tsquery(q)
    return [func.ts_headline("russian", func.split_part(st, PART, n), tq, HL_OPTS)
            for tq in ([tsq] if ptq is None else [tsq, ptq]) for n in (1, 2, 3)]


def merge_hits(phrase_hits: list[str], loose_hits: list[str]) -> list[str]:
    """Whole-phrase places first, then the places where only some of the words stand, without repeating a place
    the phrase lines already show."""
    def core(h: str) -> str:  # from the first matched word to the last one
        return h[h.find("\x01"):h.rfind("\x02")].replace("\x01", "").replace("\x02", "")

    def plain(h: str) -> str:
        return h.replace("\x01", "").replace("\x02", "")

    cores = [core(h) for h in phrase_hits]
    # only a line that holds a whole phrase place is a repeat; a single word of the phrase elsewhere is not
    return phrase_hits + [h for h in loose_hits if not any(c in plain(h) for c in cores)]


def phrase_match(q: str):
    """SQL condition: the document contains the query's words next to each other, in this order (word forms and
    small words like "о" allowed for). None when the query is not a plain phrase (one word, OR, -word)."""
    tq = phrase_tsquery(q)
    return None if tq is None else m.Document.search_vector.op("@@")(tq)


def phrase_tsquery(q: str):
    if '"' in (q or ""):
        return None  # quoted phrases are strict already
    parts = parse_query(q)
    if len(parts) < 2 or any(op != "AND" for op, _ in parts):
        return None
    return func.phraseto_tsquery("russian", literal(norm(" ".join(term for _, term in parts).lower())))


HIT_PARTS =("title", "context", "text")  # order of headlines_by_part


def rank(tsq):
    return func.ts_rank_cd(m.Document.search_vector, tsq)
