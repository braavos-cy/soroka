"""admin can make the bot leave a chat: the request is stored on seen_chat until the connector carries it out

Revision ID: 0007
"""
from alembic import op

revision = "0007"
down_revision = "0006"
branch_labels = None
depends_on = None


def upgrade():
    op.execute("ALTER TABLE seen_chat ADD COLUMN IF NOT EXISTS leave_requested_at TIMESTAMPTZ")


def downgrade():
    op.execute("ALTER TABLE seen_chat DROP COLUMN IF EXISTS leave_requested_at")
