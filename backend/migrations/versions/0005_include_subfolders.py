"""per-user preference: show documents of subfolders when a folder is selected (default off)

Revision ID: 0005
"""
from alembic import op

revision = "0005"
down_revision = "0004"
branch_labels = None
depends_on = None


def upgrade():
    op.execute('ALTER TABLE "user" ADD COLUMN IF NOT EXISTS include_subfolders BOOLEAN NOT NULL DEFAULT false')


def downgrade():
    op.execute('ALTER TABLE "user" DROP COLUMN IF EXISTS include_subfolders')
