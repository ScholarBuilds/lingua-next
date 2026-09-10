"""词汇训练快照与逐题结果。"""

import sqlalchemy as sa
from alembic import op

revision = "f0a1b2c3d4e5"
down_revision = "e9f0a1b2c3d4"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "practice_session",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column("user_id", sa.String(36), nullable=False),
        sa.Column("mode", sa.String(24), nullable=False),
        sa.Column("status", sa.String(16), nullable=False),
        sa.Column("scope", sa.JSON(), nullable=False),
        sa.Column("questions", sa.JSON(), nullable=False),
        sa.Column("cursor", sa.Integer(), nullable=False),
        sa.Column("version", sa.Integer(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("finished_at", sa.DateTime(timezone=True)),
    )
    op.create_index("ix_practice_session_user_id", "practice_session", ["user_id"])
    op.create_table(
        "practice_answer",
        sa.Column("id", sa.String(36), primary_key=True),
        sa.Column(
            "session_id",
            sa.String(36),
            sa.ForeignKey("practice_session.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("question_id", sa.String(36), nullable=False),
        sa.Column("answer", sa.Text(), nullable=False),
        sa.Column("hints", sa.Integer(), nullable=False),
        sa.Column("replays", sa.Integer(), nullable=False),
        sa.Column("verdict", sa.String(24), nullable=False),
        sa.Column("rating", sa.Integer()),
        sa.Column("review_log_id", sa.Integer(), sa.ForeignKey("review_log.id")),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.UniqueConstraint("session_id", "question_id", name="uq_practice_question"),
    )
    op.create_index("ix_practice_answer_session_id", "practice_answer", ["session_id"])
    op.create_table(
        "practice_profile",
        sa.Column("user_id", sa.String(36), primary_key=True),
        sa.Column("timezone", sa.String(64), nullable=False),
        sa.Column("daily_new", sa.Integer(), nullable=False),
        sa.Column("auto_enabled", sa.Boolean(), nullable=False),
        sa.Column("auto_limit", sa.Integer(), nullable=False),
        sa.Column("generating", sa.Boolean(), nullable=False),
    )
    op.create_table(
        "practice_pack",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column(
            "session_id",
            sa.String(36),
            sa.ForeignKey("practice_session.id", ondelete="CASCADE"),
            nullable=False,
            unique=True,
        ),
        sa.Column("user_id", sa.String(36), nullable=False),
        sa.Column("status", sa.String(16), nullable=False),
        sa.Column("automatic", sa.Boolean(), nullable=False),
        sa.Column("analysis_id", sa.Integer(), sa.ForeignKey("analysis_result.id")),
        sa.Column("error", sa.Text()),
        sa.Column("targets", sa.JSON(), nullable=False),
        sa.Column("charged_days", sa.JSON(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index("ix_practice_pack_user_id", "practice_pack", ["user_id"])


def downgrade():
    op.drop_table("practice_pack")
    op.drop_table("practice_profile")
    op.drop_table("practice_answer")
    op.drop_table("practice_session")
