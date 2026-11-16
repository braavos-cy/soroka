"""search: rebuild the index of every document — words inside file names, dates, e-mail addresses and links become
findable on their own (see soroka.search.prepare), and search_text is stored in its new three-part form

Revision ID: 0009
"""
from alembic import op
from sqlalchemy.orm import Session

revision = "0009"
down_revision = "0008"
branch_labels = None
depends_on = None


def upgrade():
    from soroka import models as m
    from soroka.search import index_document

    db = Session(bind=op.get_bind())
    ids = [i for (i,) in db.query(m.Document.id).order_by(m.Document.id).all()]
    for n, i in enumerate(ids, 1):
        doc = db.get(m.Document, i)
        if doc is not None:
            index_document(db, doc)
        if n % 50 == 0:
            db.flush()
            db.expunge_all()
    db.flush()


def downgrade():
    pass  # the previous code reindexes a document whenever it is processed or edited
