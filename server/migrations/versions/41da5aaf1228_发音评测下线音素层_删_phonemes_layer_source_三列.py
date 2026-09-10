"""发音评测下线音素层：删 phonemes/layer/source 三列

音素识别与 GOP 那两层随本地 wav2vec2-espeak 模型一起下线（ADR-012），
这三列自此没有任何写入方。留着永远不写的列，下一个读表的人会以为那一层还在、
只是这次没数据。

> [!warning] 自动生成的版本带进了一堆无关的既有漂移
>
> `alembic revision --autogenerate` 同时检出了 user_account 唯一约束、
> user_preference.value 的 JSON/JSONB 类型差异、若干 updated_at 的 NOT NULL 等等——
> 那些是本仓早有的模型与库不一致，与本次改动无关，**不在这条迁移里顺手改**。
> 顺手带上的后果是这条迁移失败时没人分得清是哪一半坏了。

Revision ID: 41da5aaf1228
Revises: a9d4e21f3b07
Create Date: 2026-08-30 06:39:07.112842
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "41da5aaf1228"
down_revision: str | None = "a9d4e21f3b07"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.drop_column("pronunciation_assessment", "source")
    op.drop_column("pronunciation_assessment", "layer")
    op.drop_column("pronunciation_assessment", "phonemes")


def downgrade() -> None:
    # 回滚只恢复列，不恢复数据——音素层的结论本来就是从音频现算的，
    # 模型删了以后也再算不出来，给一个空数组比给一个假的结构好
    op.add_column(
        "pronunciation_assessment",
        sa.Column(
            "phonemes",
            postgresql.JSONB(astext_type=sa.Text()),
            server_default=sa.text("'[]'::jsonb"),
            nullable=False,
        ),
    )
    op.add_column(
        "pronunciation_assessment",
        sa.Column("layer", sa.INTEGER(), server_default=sa.text("0"), nullable=False),
    )
    op.add_column(
        "pronunciation_assessment",
        sa.Column(
            "source",
            sa.VARCHAR(length=16),
            server_default=sa.text("'heuristic'::character varying"),
            nullable=False,
        ),
    )
