"""remove the Inbox system folder: documents without a folder have folder_id NULL

Revision ID: 0002
"""
from alembic import op

revision = "0002"
down_revision = "0001"
branch_labels = None
depends_on = None


def upgrade():
    op.execute("ALTER TABLE document ALTER COLUMN folder_id DROP NOT NULL")
    op.execute("ALTER TABLE document DROP CONSTRAINT IF EXISTS document_folder_id_fkey")
    op.execute("ALTER TABLE document ADD CONSTRAINT document_folder_id_fkey FOREIGN KEY (folder_id) "
               "REFERENCES folder(id) ON DELETE SET NULL")
    op.execute("UPDATE document SET folder_id = NULL WHERE folder_id IN (SELECT id FROM folder WHERE is_system)")
    op.execute("UPDATE registered_chat SET folder_id = NULL WHERE folder_id IN (SELECT id FROM folder WHERE is_system)")
    op.execute("UPDATE folder SET parent_id = NULL WHERE parent_id IN (SELECT id FROM folder WHERE is_system)")
    op.execute("DELETE FROM folder WHERE is_system")


def downgrade():
    pass
