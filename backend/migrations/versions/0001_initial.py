"""initial schema (snapshot of models at phase 1; later changes get real migrations)

Revision ID: 0001
"""
from alembic import op

revision = "0001"
down_revision = None
branch_labels = None
depends_on = None


def upgrade():
    op.execute("CREATE EXTENSION IF NOT EXISTS pg_trgm")
    from soroka.db import Base
    from soroka import models  # noqa: F401
    Base.metadata.create_all(op.get_bind())


def downgrade():
    from soroka.db import Base
    Base.metadata.drop_all(op.get_bind())
