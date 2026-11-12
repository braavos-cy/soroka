"""per-user "rejected area last viewed" timestamp (drives the new-rejects badge)

Revision ID: 0003
"""
from alembic import op

revision = "0003"
down_revision = "0002"
branch_labels = None
depends_on = None


def upgrade():
    op.execute('ALTER TABLE "user" ADD COLUMN IF NOT EXISTS rejected_seen_at TIMESTAMPTZ')


def downgrade():
    op.execute('ALTER TABLE "user" DROP COLUMN IF EXISTS rejected_seen_at')
