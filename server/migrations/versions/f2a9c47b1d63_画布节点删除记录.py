"""画布节点删除记录

`studio_canvas` 加 `deleted_nodes`：{节点 id: 删除生效的 version}。画布是整包 PUT，
陈旧客户端会把自己手里那份节点原样写回来，服务端不记删除就分不清「旧副本」与
「刚新建的节点」——两者在载荷里长得一模一样（判据见 domain/studio.py）。

既有行填空对象：老画布没有历史删除可补，空着只是没有保护，不会误删任何东西。

跑之前自查表在不在、列有没有加过（重复跑不报错），缺表直接中止。

Revision ID: f2a9c47b1d63
Revises: c7e1a95b40df
Create Date: 2026-08-23

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "f2a9c47b1d63"
down_revision: str | None = "c7e1a95b40df"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

JSONB = sa.JSON().with_variant(postgresql.JSONB(astext_type=sa.Text()), "postgresql")


def upgrade() -> None:
    conn = op.get_bind()
    inspector = sa.inspect(conn)
    if "studio_canvas" not in set(inspector.get_table_names()):
        raise RuntimeError("缺少前置表，拒绝迁移：studio_canvas")

    columns = {column["name"] for column in inspector.get_columns("studio_canvas")}
    if "deleted_nodes" not in columns:
        op.add_column(
            "studio_canvas",
            sa.Column("deleted_nodes", JSONB, nullable=False, server_default=sa.text("'{}'")),
        )


def downgrade() -> None:
    conn = op.get_bind()
    inspector = sa.inspect(conn)
    if "studio_canvas" not in set(inspector.get_table_names()):
        return
    columns = {column["name"] for column in inspector.get_columns("studio_canvas")}
    if "deleted_nodes" in columns:
        op.drop_column("studio_canvas", "deleted_nodes")
