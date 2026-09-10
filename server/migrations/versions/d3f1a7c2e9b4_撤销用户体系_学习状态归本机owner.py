"""撤销用户体系：学习状态归本机 owner，删身份与发布表（CR-006 D2 / D7 / D8）

Revision ID: d3f1a7c2e9b4
Revises: 41da5aaf1228
Create Date: 2026-09-02 10:00:00.000000

学习状态表的 user_id 列保留（多用户扩展点），值统一改写成 app.owner.OWNER_ID；
指向 user_account 的外键按 inspector 实际存在的名字删，不猜命名规则——
b7d3 那批叫 fk_<table>_user_id，a9d4 那批没起名，落的是 PG 默认名。
库里若有第二个账号，先用 scripts/archive_other_accounts.py 导出并删除，本迁移只守不删。
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "d3f1a7c2e9b4"
down_revision: str | None = "41da5aaf1228"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

OWNER_ID = "owner"

# 删表顺序：先删引用方，user_account 最后
IDENTITY_TABLES = (
    "content_publication",
    "user_resource_progress",
    "user_word_state",
    "user_preference",
    "audit_event",
    "invite_code",
    "verification_token",
    "auth_session",
    "role_permission",
    "user_role",
    "permission",
    "role",
    "user_account",
)


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    existing = set(inspector.get_table_names())
    learning_tables = [
        table
        for table in sorted(existing - set(IDENTITY_TABLES))
        if any(col["name"] == "user_id" for col in inspector.get_columns(table))
    ]

    for table in learning_tables:
        owners = bind.execute(
            sa.text(f"SELECT count(DISTINCT user_id) FROM {table} WHERE user_id IS NOT NULL")
        ).scalar()
        if owners and owners > 1:
            raise RuntimeError(
                f"{table} 里有 {owners} 个账号的数据；先跑 scripts/archive_other_accounts.py "
                "把非 owner 账号的记录导出并删除，再执行本迁移"
            )

    for table in learning_tables:
        for fk in inspector.get_foreign_keys(table):
            if fk.get("referred_table") == "user_account" and fk.get("name"):
                op.drop_constraint(fk["name"], table, type_="foreignkey")
        op.execute(
            sa.text(f"UPDATE {table} SET user_id = :owner WHERE user_id IS NOT NULL").bindparams(
                owner=OWNER_ID
            )
        )

    for table in IDENTITY_TABLES:
        if table in existing:
            op.drop_table(table)


def downgrade() -> None:
    raise RuntimeError("身份与发布表已删除，不可逆；要回退请从迁移前的 pg_dump 恢复")
