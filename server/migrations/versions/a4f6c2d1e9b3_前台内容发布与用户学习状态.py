"""前台内容发布与用户学习状态

Revision ID: a4f6c2d1e9b3
Revises: 8f2c1a4d9b70
Create Date: 2026-08-25 13:30:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "a4f6c2d1e9b3"
down_revision: str | None = "8f2c1a4d9b70"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute(
        """
        INSERT INTO permission (code, description)
        VALUES ('content.manage', '策展并发布学习前台内容')
        ON CONFLICT (code) DO NOTHING
        """
    )
    op.execute(
        """
        INSERT INTO role_permission (role_id, permission_id)
        SELECT role.id, permission.id
        FROM role, permission
        WHERE role.code = 'admin' AND permission.code = 'content.manage'
        ON CONFLICT (role_id, permission_id) DO NOTHING
        """
    )
    op.create_table(
        "content_publication",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("resource_type", sa.String(length=16), nullable=False),
        sa.Column("resource_key", sa.String(length=64), nullable=False),
        sa.Column("is_published", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("is_featured", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("sort_order", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("title_override", sa.String(length=512), nullable=True),
        sa.Column("description_override", sa.Text(), nullable=True),
        sa.Column("audience_levels", sa.JSON(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()")),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()")),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "resource_type", "resource_key", name="uq_content_publication_resource"
        ),
    )
    op.create_index(
        "ix_content_publication_resource_type", "content_publication", ["resource_type"]
    )
    op.create_index(
        "ix_content_publication_is_published", "content_publication", ["is_published"]
    )

    op.create_table(
        "user_resource_progress",
        sa.Column("id", sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column("user_id", sa.String(length=36), nullable=False),
        sa.Column("resource_type", sa.String(length=16), nullable=False),
        sa.Column("resource_key", sa.String(length=64), nullable=False),
        sa.Column("progress", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("position", sa.Integer(), nullable=True),
        sa.Column("completed", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()")),
        sa.ForeignKeyConstraint(["user_id"], ["user_account.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "user_id", "resource_type", "resource_key", name="uq_user_resource_progress"
        ),
    )
    op.create_index(
        "ix_user_resource_progress_user_id", "user_resource_progress", ["user_id"]
    )
    op.create_index(
        "ix_user_resource_progress_updated_at", "user_resource_progress", ["updated_at"]
    )

    op.create_table(
        "user_word_state",
        sa.Column("user_id", sa.String(length=36), nullable=False),
        sa.Column("word", sa.String(length=128), nullable=False),
        sa.Column("mark", sa.String(length=16), nullable=True),
        sa.Column("exposures", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("last_seen_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()")),
        sa.ForeignKeyConstraint(["user_id"], ["user_account.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("user_id", "word"),
    )

    # 旧项目已有一批可学习内置内容。迁移后直接把状态完整的内置书、
    # 可播视频、独立文章与词汇课程放入发布目录，避免新前台上线后仍是空库。
    op.execute(
        """
        INSERT INTO content_publication
            (resource_type, resource_key, is_published, is_featured, sort_order)
        SELECT 'book', id::text, true, false, id
        FROM book
        WHERE source = 'builtin' AND status = 'ready'
        ON CONFLICT (resource_type, resource_key) DO NOTHING
        """
    )
    op.execute(
        """
        INSERT INTO content_publication
            (resource_type, resource_key, is_published, is_featured, sort_order)
        SELECT 'article', id::text, true, false, id
        FROM article
        WHERE book_id IS NULL AND source_kind <> 'scenario' AND status = 'ready'
        ON CONFLICT (resource_type, resource_key) DO NOTHING
        """
    )
    op.execute(
        """
        INSERT INTO content_publication
            (resource_type, resource_key, is_published, is_featured, sort_order)
        SELECT 'video', id::text, true, false, id
        FROM video
        WHERE status IN ('ready', 'degraded')
        ON CONFLICT (resource_type, resource_key) DO NOTHING
        """
    )
    op.execute(
        """
        INSERT INTO content_publication
            (resource_type, resource_key, is_published, is_featured, sort_order)
        SELECT 'wordlist', 'custom:' || id::text, true, false, id
        FROM wordlist
        WHERE status = 'ready' AND archived_at IS NULL
        ON CONFLICT (resource_type, resource_key) DO NOTHING
        """
    )
    for sort_order, key in enumerate(
        ("zk", "gk", "cet4", "cet6", "ky", "toefl", "ielts", "gre"), start=1
    ):
        op.execute(
            sa.text(
                """
                INSERT INTO content_publication
                    (resource_type, resource_key, is_published, is_featured, sort_order)
                VALUES ('wordlist', :key, true, false, :sort_order)
                ON CONFLICT (resource_type, resource_key) DO NOTHING
                """
            ).bindparams(key=key, sort_order=sort_order)
        )

    # 默认只置顶一条实际可用的精听内容，后续由后台调整。
    op.execute(
        """
        UPDATE content_publication
        SET is_featured = true
        WHERE id = (
            SELECT id FROM content_publication
            WHERE resource_type = 'video' AND is_published = true
            ORDER BY sort_order LIMIT 1
        )
        """
    )


def downgrade() -> None:
    op.drop_table("user_word_state")
    op.drop_table("user_resource_progress")
    op.drop_table("content_publication")
    op.execute(
        """
        DELETE FROM role_permission
        WHERE permission_id = (SELECT id FROM permission WHERE code = 'content.manage')
        """
    )
    op.execute("DELETE FROM permission WHERE code = 'content.manage'")
