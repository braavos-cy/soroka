"""bot reactions to chat messages (saved / rejected): per-chat switch and the per-message reaction queue

Revision ID: 0008
"""
from alembic import op

revision = "0008"
down_revision = "0007"
branch_labels = None
depends_on = None


def upgrade():
    op.execute("ALTER TABLE registered_chat ADD COLUMN IF NOT EXISTS reactions BOOLEAN NOT NULL DEFAULT true")
    op.execute("ALTER TABLE ingest_event ADD COLUMN IF NOT EXISTS reaction VARCHAR(16)")
    op.execute("ALTER TABLE ingest_event ADD COLUMN IF NOT EXISTS reaction_at TIMESTAMPTZ")
    op.execute("ALTER TABLE ingest_event ADD COLUMN IF NOT EXISTS reaction_sent_at TIMESTAMPTZ")


def downgrade():
    op.execute("ALTER TABLE registered_chat DROP COLUMN IF EXISTS reactions")
    for c in ("reaction", "reaction_at", "reaction_sent_at"):
        op.execute(f"ALTER TABLE ingest_event DROP COLUMN IF EXISTS {c}")
