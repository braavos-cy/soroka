"""chats are no longer registered with one-time codes posted in the chat: drop their table

Revision ID: 0010
"""
from alembic import op

revision = "0010"
down_revision = "0009"
branch_labels = None
depends_on = None


def upgrade():
    op.execute("DROP TABLE IF EXISTS registration_code")


def downgrade():
    op.execute("""CREATE TABLE IF NOT EXISTS registration_code (
        code VARCHAR(32) PRIMARY KEY, platform VARCHAR(20) NOT NULL, folder_id INTEGER, tag_ids JSON,
        mode VARCHAR(20) NOT NULL, created_by INTEGER, expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
        used_chat_id VARCHAR(200))""")
