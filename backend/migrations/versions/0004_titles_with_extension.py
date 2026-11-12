"""default document titles keep the file extension; decode URL-encoded file names

Revision ID: 0004
"""
import os

import sqlalchemy as sa
from alembic import op

revision = "0004"
down_revision = "0003"
branch_labels = None
depends_on = None


def upgrade():
    from soroka.ingest import decode_name, with_extension
    bind = op.get_bind()
    for fid, name in bind.execute(sa.text("SELECT id, filename FROM file_original")).all():
        new = decode_name(name)
        if new != name:
            bind.execute(sa.text("UPDATE file_original SET filename = :n WHERE id = :i"), {"n": new[:500], "i": fid})
    rows = bind.execute(sa.text("""
        SELECT d.id, d.title, f.filename FROM document d
        JOIN file_original f ON f.id = (d.source_file_ids->>0)::int""")).all()
    for did, title, filename in rows:
        new = with_extension(decode_name(title) or filename, filename)
        if new != title:
            bind.execute(sa.text("UPDATE document SET title = :t WHERE id = :i"), {"t": new[:500], "i": did})


def downgrade():
    pass
