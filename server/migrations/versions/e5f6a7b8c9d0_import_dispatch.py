"""导入任务派发意图。"""

import sqlalchemy as sa
from alembic import op

revision = "e5f6a7b8c9d0"
down_revision = "d4e5f6a7b8c9"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "import_dispatch",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("function", sa.String(64), nullable=False),
        sa.Column("subject_id", sa.Integer(), nullable=False),
        sa.Column("status", sa.String(16), nullable=False),
        sa.Column("attempts", sa.Integer(), nullable=False),
        sa.Column("error", sa.Text()),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
    )
    op.create_index("ix_import_dispatch_status", "import_dispatch", ["status"])


def downgrade():
    op.drop_table("import_dispatch")
