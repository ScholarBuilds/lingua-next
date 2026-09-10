"""对话消息标识与辅助批次。"""

import sqlalchemy as sa
from alembic import op

revision = "e9f0a1b2c3d4"
down_revision = "d8e9f0a1b2c3"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column("talk_turn", sa.Column("message_id", sa.String(36), nullable=True))
    op.add_column(
        "talk_turn", sa.Column("complete", sa.Boolean(), server_default=sa.true(), nullable=False)
    )
    op.add_column(
        "talk_turn", sa.Column("saved", sa.Boolean(), server_default=sa.false(), nullable=False)
    )
    op.add_column(
        "talk_turn", sa.Column("saved_texts", sa.JSON(), server_default="[]", nullable=False)
    )
    op.create_index("uq_talk_turn_message", "talk_turn", ["message_id"], unique=True)
    op.create_table(
        "talk_coach_batch",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column(
            "turn_id",
            sa.Integer(),
            sa.ForeignKey("talk_turn.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("batch_index", sa.Integer(), nullable=False),
        sa.Column("status", sa.String(16), nullable=False),
        sa.Column("analysis_id", sa.Integer(), sa.ForeignKey("analysis_result.id")),
        sa.Column("error", sa.Text()),
        sa.Column("saved_replies", sa.JSON(), nullable=False),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.UniqueConstraint("turn_id", "batch_index", name="uq_talk_coach_batch"),
    )


def downgrade():
    op.drop_table("talk_coach_batch")
    op.drop_index("uq_talk_turn_message", table_name="talk_turn")
    op.drop_column("talk_turn", "saved")
    op.drop_column("talk_turn", "saved_texts")
    op.drop_column("talk_turn", "complete")
    op.drop_column("talk_turn", "message_id")
