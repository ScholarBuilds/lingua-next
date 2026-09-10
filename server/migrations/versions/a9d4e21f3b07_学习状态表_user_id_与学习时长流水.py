"""学习状态表 user_id 与学习时长流水

语法卡/概念状态、写作与练习作答原来是单用户全局表：多用户下会把别人的
进度算到自己头上。补 user_id 列、唯一约束换成 (user_id, 对象) 复合，
存量行回填给最早注册的用户（单用户时代就是本人）。

新增 study_time_log：阅读/口语时长流水，首页今日与周视图按天求和。
talk_session 的 NULL user_id 一并回填。

本迁移同时是仓库三个既有 head（工作流模板表、词卡 mark 列、学习状态按用户隔离）
的合并点——`alembic upgrade head` 此前因多头直接失败。user_id 列沿用
b7d3e5f1a920 的 String(36) 口径。

Revision ID: a9d4e21f3b07
Revises: 7c2ef4a91b05, ca331f1d1680, b7d3e5f1a920
Create Date: 2026-08-26 08:10:00.000000
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = 'a9d4e21f3b07'
down_revision: str | Sequence[str] | None = ('7c2ef4a91b05', 'ca331f1d1680', 'b7d3e5f1a920')
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_OWNER = sa.text(
    "(SELECT id FROM user_account ORDER BY created_at ASC, id ASC LIMIT 1)"
)


def _backfill(table: str) -> None:
    op.execute(sa.text(f"UPDATE {table} SET user_id = {_OWNER.text} WHERE user_id IS NULL"))


def upgrade() -> None:
    op.create_table(
        'study_time_log',
        sa.Column('id', sa.BigInteger().with_variant(sa.Integer(), 'sqlite'), autoincrement=True, nullable=False),
        sa.Column('user_id', sa.String(length=36), nullable=False),
        sa.Column('kind', sa.String(length=16), nullable=False),
        sa.Column('seconds', sa.Integer(), nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.ForeignKeyConstraint(['user_id'], ['user_account.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index('ix_study_time_user_kind_day', 'study_time_log', ['user_id', 'kind', 'created_at'])
    op.create_index(op.f('ix_study_time_log_user_id'), 'study_time_log', ['user_id'])
    op.create_index(op.f('ix_study_time_log_created_at'), 'study_time_log', ['created_at'])

    for table, obj_col, uq in (
        ('grammar_card_state', 'card_id', 'uq_grammar_card_state_user_card'),
        ('grammar_concept_state', 'concept_id', 'uq_grammar_concept_state_user_concept'),
    ):
        op.add_column(table, sa.Column('user_id', sa.String(length=36), nullable=True))
        op.create_index(op.f(f'ix_{table}_user_id'), table, ['user_id'])
        op.create_foreign_key(None, table, 'user_account', ['user_id'], ['id'], ondelete='CASCADE')
        # 单列唯一是单用户时代的产物，换掉；约束名是 PG 默认命名
        op.drop_constraint(f'{table}_{obj_col}_key', table, type_='unique')
        _backfill(table)
        op.create_unique_constraint(uq, table, ['user_id', obj_col])

    for table in ('writing_attempt', 'exercise_attempt'):
        op.add_column(table, sa.Column('user_id', sa.String(length=36), nullable=True))
        op.create_index(op.f(f'ix_{table}_user_id'), table, ['user_id'])
        op.create_foreign_key(None, table, 'user_account', ['user_id'], ['id'], ondelete='CASCADE')
        _backfill(table)

    op.execute(sa.text(f"UPDATE talk_session SET user_id = {_OWNER.text} WHERE user_id IS NULL"))


def downgrade() -> None:
    op.execute(sa.text("DELETE FROM grammar_card_state WHERE user_id IS NULL"))
    op.execute(sa.text("DELETE FROM grammar_concept_state WHERE user_id IS NULL"))
    for table, obj_col, uq in (
        ('grammar_card_state', 'card_id', 'uq_grammar_card_state_user_card'),
        ('grammar_concept_state', 'concept_id', 'uq_grammar_concept_state_user_concept'),
    ):
        op.drop_constraint(uq, table, type_='unique')
        op.create_unique_constraint(None, table, [obj_col])
        op.drop_constraint(None, table, type_='foreignkey')
        op.drop_index(op.f(f'ix_{table}_user_id'), table)
        op.drop_column(table, 'user_id')
    for table in ('writing_attempt', 'exercise_attempt'):
        op.drop_constraint(None, table, type_='foreignkey')
        op.drop_index(op.f(f'ix_{table}_user_id'), table)
        op.drop_column(table, 'user_id')
    op.drop_index(op.f('ix_study_time_log_created_at'), 'study_time_log')
    op.drop_index(op.f('ix_study_time_log_user_id'), 'study_time_log')
    op.drop_index('ix_study_time_user_kind_day', 'study_time_log')
    op.drop_table('study_time_log')
