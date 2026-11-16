"""muted tag palette: tags that still have one of the old (bright) palette colours get the matching muted one;
colours picked by hand are left alone

Revision ID: 0006
"""
from alembic import op

revision = "0006"
down_revision = "0005"
branch_labels = None
depends_on = None

# old -> new; keep in sync with TAG_COLORS in frontend/src/components/Pickers.tsx
PALETTE = {
    "#ef4444": "#c2726b", "#f59e0b": "#c9a05f", "#10b981": "#6fa588", "#3b82f6": "#6d8fc4",
    "#8b5cf6": "#9484c0", "#ec4899": "#c283a3", "#14b8a6": "#6aa5a3", "#64748b": "#7b8794",
}


def _remap(pairs):
    for a, b in pairs:
        op.execute(f"UPDATE tag SET color = '{b}' WHERE lower(color) = '{a}'")


def upgrade():
    _remap(PALETTE.items())


def downgrade():
    _remap((b, a) for a, b in PALETTE.items())
