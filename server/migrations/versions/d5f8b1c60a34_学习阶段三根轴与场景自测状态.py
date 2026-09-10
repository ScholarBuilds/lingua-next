"""学习阶段三根轴与场景自测状态

`vocab_entry` 加三列：
- `exposures` / `last_seen_at`：接触度轴。「点开看过几次」，**独立于 FSRS**——
  把看一眼当成一次 Good 评分会把 stability 推上去，让没测过的词排到几周后。
- `self_test_at`：自测过关轴。与 FSRS 并存，互不回写。

新表 `deck_scene_state`：某本某场景的自测状态。`passed_at` 只是缓存，
真判据是「该场景所有词的 self_test_at 非空」，删表能重算。

Revision ID: d5f8b1c60a34
Revises: b3d7f0a15e29
Create Date: 2026-08-25
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "d5f8b1c60a34"
down_revision: str | None = "b3d7f0a15e29"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "vocab_entry",
        sa.Column("exposures", sa.Integer(), nullable=False, server_default="0"),
    )
    op.add_column("vocab_entry", sa.Column("last_seen_at", sa.DateTime(timezone=True), nullable=True))
    op.add_column("vocab_entry", sa.Column("self_test_at", sa.DateTime(timezone=True), nullable=True))

    op.create_table(
        "deck_scene_state",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("deck", sa.String(length=32), nullable=False),
        sa.Column("scene", sa.String(length=64), nullable=False),
        sa.Column("batch_cursor", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("attempts", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("first_try_ok", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("first_try_total", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("passed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("deck", "scene", name="uq_deck_scene_state"),
    )


def downgrade() -> None:
    op.drop_table("deck_scene_state")
    op.drop_column("vocab_entry", "self_test_at")
    op.drop_column("vocab_entry", "last_seen_at")
    op.drop_column("vocab_entry", "exposures")
