"""词卡人工标记：mark 列

人工标记与 FSRS 卡分开存：FSRS 的 stability/difficulty 是从真实答题结果估出来的，
手按一下「已掌握」就改写它，等于往调度模型里灌假数据。

Revision ID: ca331f1d1680
Revises: d5f8b1c60a34
Create Date: 2026-08-25 02:22:43.930341
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = 'ca331f1d1680'
down_revision: str | None = 'd5f8b1c60a34'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # autogenerate 还想把 deck_scene 上 (deck, scene) 的复合索引换成单列 (scene)，
    # 已剔除：按本取场景的查询全是 `WHERE deck = ? AND scene = ?`，
    # 换成单列索引会让每次都退回按 deck 过滤，是实打实的降级
    op.add_column('vocab_entry', sa.Column('mark', sa.String(length=16), nullable=True))
    op.add_column('vocab_entry', sa.Column('marked_at', sa.DateTime(timezone=True), nullable=True))


def downgrade() -> None:
    op.drop_column('vocab_entry', 'marked_at')
    op.drop_column('vocab_entry', 'mark')
