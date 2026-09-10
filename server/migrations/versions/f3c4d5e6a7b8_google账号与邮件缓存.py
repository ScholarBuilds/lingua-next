"""Google 账号与邮件缓存（CR-007 模块 18）

Revision ID: f3c4d5e6a7b8
Revises: e7a1b2c3d4f5
Create Date: 2026-09-02 14:00:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "f3c4d5e6a7b8"
down_revision: str | None = "e7a1b2c3d4f5"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

JSON = sa.JSON().with_variant(postgresql.JSONB(), "postgresql")


def upgrade() -> None:
    op.create_table(
        "google_account",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("email", sa.String(length=320), nullable=False),
        sa.Column("display_name", sa.String(length=120), nullable=True),
        sa.Column("credential_id", sa.Integer(), nullable=False),
        sa.Column("scopes", JSON, nullable=True),
        sa.Column("history_id", sa.String(length=32), nullable=True),
        sa.Column("last_sync_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("status", sa.String(length=16), nullable=False, server_default="ok"),
        sa.Column("status_detail", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.ForeignKeyConstraint(["credential_id"], ["provider_credential.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("email"),
    )
    op.create_index(op.f("ix_google_account_credential_id"), "google_account", ["credential_id"])
    op.create_table(
        "mail_message",
        sa.Column("id", sa.BigInteger().with_variant(sa.Integer(), "sqlite"), autoincrement=True, nullable=False),
        sa.Column("account_id", sa.Integer(), nullable=False),
        sa.Column("gmail_id", sa.String(length=32), nullable=False),
        sa.Column("thread_id", sa.String(length=32), nullable=True),
        sa.Column("from_name", sa.String(length=256), nullable=True),
        sa.Column("from_addr", sa.String(length=320), nullable=True),
        sa.Column("to_addrs", JSON, nullable=True),
        sa.Column("subject", sa.Text(), nullable=False, server_default=""),
        sa.Column("snippet", sa.Text(), nullable=False, server_default=""),
        sa.Column("sent_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("labels", JSON, nullable=True),
        sa.Column("unread", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("has_attachments", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("body_text", sa.Text(), nullable=True),
        sa.Column("article_id", sa.Integer(), nullable=True),
        sa.Column("fetched_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.ForeignKeyConstraint(["account_id"], ["google_account.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["article_id"], ["article.id"], ondelete="SET NULL"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("account_id", "gmail_id", name="uq_mail_message_account_gmail"),
    )
    op.create_index(op.f("ix_mail_message_account_id"), "mail_message", ["account_id"])
    op.create_index(op.f("ix_mail_message_sent_at"), "mail_message", ["sent_at"])


def downgrade() -> None:
    op.drop_index(op.f("ix_mail_message_sent_at"), table_name="mail_message")
    op.drop_index(op.f("ix_mail_message_account_id"), table_name="mail_message")
    op.drop_table("mail_message")
    op.drop_index(op.f("ix_google_account_credential_id"), table_name="google_account")
    op.drop_table("google_account")
