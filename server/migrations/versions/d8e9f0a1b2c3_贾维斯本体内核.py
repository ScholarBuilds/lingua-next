"""贾维斯本体内核（CR-012）

Revision ID: d8e9f0a1b2c3
Revises: c7d8e9f0a1b2
Create Date: 2026-09-03 01:00:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "d8e9f0a1b2c3"
down_revision: str | None = "c7d8e9f0a1b2"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

JSON = sa.JSON().with_variant(postgresql.JSONB(), "postgresql")


def _timestamps() -> tuple[sa.Column, sa.Column]:
    return (
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
    )


def upgrade() -> None:
    op.create_table(
        "jarvis_profile",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("user_name", sa.String(length=120), nullable=False),
        sa.Column("assistant_name", sa.String(length=120), nullable=False),
        sa.Column("locale", sa.String(length=32), nullable=False),
        sa.Column("voice", sa.String(length=160), nullable=True),
        sa.Column("preferences", JSON, nullable=False),
        sa.Column("persona_version", sa.Integer(), nullable=False),
        sa.Column("policy_version", sa.Integer(), nullable=False),
        *_timestamps(),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_table(
        "jarvis_conversation",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("status", sa.String(length=24), nullable=False),
        sa.Column("title", sa.String(length=200), nullable=True),
        sa.Column("summary", sa.Text(), nullable=True),
        sa.Column("event_seq", sa.Integer(), nullable=False),
        sa.Column("last_turn_at", sa.DateTime(timezone=True), nullable=True),
        *_timestamps(),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_jarvis_conversation_status", "jarvis_conversation", ["status"])
    op.create_index("ix_jarvis_conversation_last_turn_at", "jarvis_conversation", ["last_turn_at"])
    op.create_index("ix_jarvis_conversation_created_at", "jarvis_conversation", ["created_at"])

    op.create_table(
        "jarvis_mission",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("conversation_id", sa.String(length=36), nullable=False),
        sa.Column("origin_turn_id", sa.String(length=36), nullable=True),
        sa.Column("mode", sa.String(length=24), nullable=False),
        sa.Column("status", sa.String(length=24), nullable=False),
        sa.Column("goal", sa.Text(), nullable=False),
        sa.Column("result_contract", JSON, nullable=True),
        sa.Column("checkpoint", JSON, nullable=False),
        sa.Column("flow_run_id", sa.String(length=36), nullable=True),
        sa.Column("actor_generation", sa.Integer(), nullable=False),
        sa.Column("lease_owner", sa.String(length=120), nullable=True),
        sa.Column("lease_until", sa.DateTime(timezone=True), nullable=True),
        sa.Column("idempotency_key", sa.String(length=120), nullable=False),
        sa.Column("event_seq", sa.Integer(), nullable=False),
        sa.Column("result", JSON, nullable=True),
        sa.Column("error", sa.Text(), nullable=True),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("finished_at", sa.DateTime(timezone=True), nullable=True),
        *_timestamps(),
        sa.ForeignKeyConstraint(
            ["conversation_id"], ["jarvis_conversation.id"], ondelete="CASCADE"
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("idempotency_key"),
    )
    for name in (
        "conversation_id",
        "origin_turn_id",
        "mode",
        "status",
        "flow_run_id",
        "lease_owner",
        "lease_until",
        "created_at",
    ):
        op.create_index(f"ix_jarvis_mission_{name}", "jarvis_mission", [name])

    op.create_table(
        "jarvis_turn",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("conversation_id", sa.String(length=36), nullable=False),
        sa.Column("mission_id", sa.String(length=36), nullable=True),
        sa.Column("trace_id", sa.String(length=36), nullable=False),
        sa.Column("source", sa.String(length=24), nullable=False),
        sa.Column("status", sa.String(length=24), nullable=False),
        sa.Column("user_text", sa.Text(), nullable=True),
        sa.Column("assistant_text", sa.Text(), nullable=True),
        sa.Column("context_snapshot", JSON, nullable=True),
        sa.Column(
            "started_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("finished_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(
            ["conversation_id"], ["jarvis_conversation.id"], ondelete="CASCADE"
        ),
        sa.ForeignKeyConstraint(["mission_id"], ["jarvis_mission.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("trace_id"),
    )
    for name in ("conversation_id", "mission_id", "trace_id", "source", "status", "created_at"):
        op.create_index(f"ix_jarvis_turn_{name}", "jarvis_turn", [name])

    op.create_table(
        "jarvis_command",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("mission_id", sa.String(length=36), nullable=False),
        sa.Column("generation", sa.Integer(), nullable=False),
        sa.Column("kind", sa.String(length=24), nullable=False),
        sa.Column("payload", JSON, nullable=True),
        sa.Column("idempotency_key", sa.String(length=120), nullable=False),
        sa.Column("status", sa.String(length=24), nullable=False),
        sa.Column("result", JSON, nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("handled_at", sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(["mission_id"], ["jarvis_mission.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("idempotency_key"),
    )
    for name in ("mission_id", "kind", "status", "created_at"):
        op.create_index(f"ix_jarvis_command_{name}", "jarvis_command", [name])

    op.create_table(
        "jarvis_event",
        sa.Column("global_cursor", sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column("aggregate_type", sa.String(length=24), nullable=False),
        sa.Column("aggregate_id", sa.String(length=36), nullable=False),
        sa.Column("seq", sa.Integer(), nullable=False),
        sa.Column("event_type", sa.String(length=80), nullable=False),
        sa.Column("payload", JSON, nullable=True),
        sa.Column("trace_id", sa.String(length=36), nullable=True),
        sa.Column("conversation_id", sa.String(length=36), nullable=True),
        sa.Column("turn_id", sa.String(length=36), nullable=True),
        sa.Column("mission_id", sa.String(length=36), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint("global_cursor"),
        sa.UniqueConstraint("aggregate_type", "aggregate_id", "seq", name="uq_jarvis_event_seq"),
    )
    for name in (
        "aggregate_type",
        "aggregate_id",
        "event_type",
        "trace_id",
        "conversation_id",
        "turn_id",
        "mission_id",
        "created_at",
    ):
        op.create_index(f"ix_jarvis_event_{name}", "jarvis_event", [name])

    op.create_table(
        "jarvis_memory",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("kind", sa.String(length=24), nullable=False),
        sa.Column("status", sa.String(length=24), nullable=False),
        sa.Column("content", sa.Text(), nullable=False),
        sa.Column("source_turn_id", sa.String(length=36), nullable=True),
        sa.Column("scope", JSON, nullable=True),
        sa.Column("sensitivity", sa.String(length=24), nullable=False),
        sa.Column("confidence", sa.Float(), nullable=False),
        sa.Column("provenance", JSON, nullable=True),
        sa.Column("supersedes_id", sa.String(length=36), nullable=True),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=True),
        *_timestamps(),
        sa.PrimaryKeyConstraint("id"),
    )
    for name in (
        "kind",
        "status",
        "source_turn_id",
        "sensitivity",
        "supersedes_id",
        "expires_at",
        "created_at",
    ):
        op.create_index(f"ix_jarvis_memory_{name}", "jarvis_memory", [name])

    op.create_table(
        "jarvis_announcement",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("source", sa.String(length=48), nullable=False),
        sa.Column("key", sa.String(length=96), nullable=False),
        sa.Column("title", sa.String(length=200), nullable=False),
        sa.Column("text", sa.Text(), nullable=False),
        sa.Column("status", sa.String(length=24), nullable=False),
        sa.Column("reason", sa.String(length=120), nullable=True),
        sa.Column("attempts", sa.Integer(), nullable=False),
        sa.Column("available_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("delivered_at", sa.DateTime(timezone=True), nullable=True),
        *_timestamps(),
        sa.PrimaryKeyConstraint("id"),
    )
    for name in ("source", "key", "status", "available_at", "created_at"):
        op.create_index(f"ix_jarvis_announcement_{name}", "jarvis_announcement", [name])

    for table in ("computer_session", "studio_flow_run", "studio_task"):
        op.add_column(table, sa.Column("mission_id", sa.String(length=36), nullable=True))
        op.create_index(f"ix_{table}_mission_id", table, ["mission_id"])
        op.create_foreign_key(
            f"fk_{table}_mission_id_jarvis_mission",
            table,
            "jarvis_mission",
            ["mission_id"],
            ["id"],
            ondelete="SET NULL",
        )
    op.add_column(
        "computer_session", sa.Column("conversation_id", sa.String(length=36), nullable=True)
    )
    op.create_index("ix_computer_session_conversation_id", "computer_session", ["conversation_id"])
    op.create_foreign_key(
        "fk_computer_session_conversation_id_jarvis_conversation",
        "computer_session",
        "jarvis_conversation",
        ["conversation_id"],
        ["id"],
        ondelete="SET NULL",
    )


def downgrade() -> None:
    op.drop_constraint(
        "fk_computer_session_conversation_id_jarvis_conversation",
        "computer_session",
        type_="foreignkey",
    )
    op.drop_index("ix_computer_session_conversation_id", table_name="computer_session")
    op.drop_column("computer_session", "conversation_id")
    for table in ("studio_task", "studio_flow_run", "computer_session"):
        op.drop_constraint(f"fk_{table}_mission_id_jarvis_mission", table, type_="foreignkey")
        op.drop_index(f"ix_{table}_mission_id", table_name=table)
        op.drop_column(table, "mission_id")
    op.drop_table("jarvis_announcement")
    op.drop_table("jarvis_memory")
    op.drop_table("jarvis_event")
    op.drop_table("jarvis_command")
    op.drop_table("jarvis_turn")
    op.drop_table("jarvis_mission")
    op.drop_table("jarvis_conversation")
    op.drop_table("jarvis_profile")
