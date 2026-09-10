"""工作位置与非敏感草稿。"""

import sqlalchemy as sa
from alembic import op

revision = "f2d3e4f5a6b7"
down_revision = "f1c2d3e4a5b6"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "online_video_reference",
        sa.Column("user_id", sa.String(36), primary_key=True),
        sa.Column("video_key", sa.String(32), primary_key=True),
        sa.Column(
            "video_id", sa.Integer(), sa.ForeignKey("video.id", ondelete="CASCADE"), nullable=False
        ),
    )
    op.create_table(
        "grammar_practice",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("user_id", sa.String(36), nullable=False, index=True),
        sa.Column("mode", sa.String(16), nullable=False),
        sa.Column("status", sa.String(16), nullable=False),
        sa.Column("questions", sa.JSON(), nullable=False),
        sa.Column("answers", sa.JSON(), nullable=False),
        sa.Column("cursor", sa.Integer(), nullable=False),
        sa.Column("version", sa.Integer(), nullable=False),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
    )
    op.create_table(
        "workspace_snapshot",
        sa.Column("user_id", sa.String(36), primary_key=True),
        sa.Column("module", sa.String(24), primary_key=True),
        sa.Column("key", sa.String(2048), primary_key=True),
        sa.Column("version", sa.Integer(), nullable=False),
        sa.Column("value", sa.JSON(), nullable=False),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
    )
    op.create_index("ix_workspace_snapshot_updated_at", "workspace_snapshot", ["updated_at"])


def downgrade():
    op.drop_table("online_video_reference")
    op.drop_table("grammar_practice")
    op.drop_table("workspace_snapshot")
