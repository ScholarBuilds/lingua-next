"""学习状态按用户隔离

Revision ID: b7d3e5f1a920
Revises: a4f6c2d1e9b3
Create Date: 2026-08-25 20:10:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "b7d3e5f1a920"
down_revision: str | None = "a4f6c2d1e9b3"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

TABLES = (
    "study_unit_state",
    "video_study_progress",
    "vocab_entry",
    "deck_scene_state",
    "talk_session",
    "reading_progress",
    "annotation",
    "bookmark",
    "shadow_recording",
    "phoneme_card_state",
    "phoneme_attempt",
)


def _backfill_user(table: str) -> None:
    op.execute(
        f"""
        UPDATE {table}
        SET user_id = (
            SELECT ua.id
            FROM user_account ua
            JOIN user_role ur ON ur.user_id = ua.id
            JOIN role r ON r.id = ur.role_id
            WHERE r.code = 'admin' AND ua.deleted_at IS NULL
            ORDER BY ua.created_at
            LIMIT 1
        )
        WHERE user_id IS NULL
        """
    )


def upgrade() -> None:
    for table in TABLES:
        op.add_column(table, sa.Column("user_id", sa.String(length=36), nullable=True))
        op.create_foreign_key(
            f"fk_{table}_user_id", table, "user_account", ["user_id"], ["id"], ondelete="CASCADE"
        )
        op.create_index(f"ix_{table}_user_id", table, ["user_id"])
        _backfill_user(table)

    op.drop_constraint("study_unit_state_unit_id_key", "study_unit_state", type_="unique")
    op.create_unique_constraint(
        "uq_study_unit_state_user_unit", "study_unit_state", ["user_id", "unit_id"]
    )
    op.drop_constraint("video_study_progress_video_id_key", "video_study_progress", type_="unique")
    op.create_unique_constraint(
        "uq_video_progress_user_video", "video_study_progress", ["user_id", "video_id"]
    )
    op.drop_constraint("vocab_entry_word_key", "vocab_entry", type_="unique")
    op.create_index("ix_vocab_entry_word", "vocab_entry", ["word"])
    op.create_unique_constraint(
        "uq_vocab_entry_user_word", "vocab_entry", ["user_id", "word"]
    )
    op.drop_constraint("uq_deck_scene_state", "deck_scene_state", type_="unique")
    op.create_unique_constraint(
        "uq_deck_scene_state_user", "deck_scene_state", ["user_id", "deck", "scene"]
    )
    op.drop_constraint("reading_progress_article_id_key", "reading_progress", type_="unique")
    op.create_unique_constraint(
        "uq_reading_progress_user_article", "reading_progress", ["user_id", "article_id"]
    )
    op.drop_constraint("uq_bookmark_para", "bookmark", type_="unique")
    op.create_unique_constraint(
        "uq_bookmark_user_para", "bookmark", ["user_id", "article_id", "paragraph_id"]
    )
    op.drop_constraint("uq_phoneme_card", "phoneme_card_state", type_="unique")
    op.create_unique_constraint(
        "uq_phoneme_card_user", "phoneme_card_state", ["user_id", "kind", "card_key"]
    )


def downgrade() -> None:
    op.drop_constraint("uq_phoneme_card_user", "phoneme_card_state", type_="unique")
    op.create_unique_constraint("uq_phoneme_card", "phoneme_card_state", ["kind", "card_key"])
    op.drop_constraint("uq_bookmark_user_para", "bookmark", type_="unique")
    op.create_unique_constraint("uq_bookmark_para", "bookmark", ["article_id", "paragraph_id"])
    op.drop_constraint("uq_reading_progress_user_article", "reading_progress", type_="unique")
    op.create_unique_constraint("reading_progress_article_id_key", "reading_progress", ["article_id"])
    op.drop_constraint("uq_deck_scene_state_user", "deck_scene_state", type_="unique")
    op.create_unique_constraint("uq_deck_scene_state", "deck_scene_state", ["deck", "scene"])
    op.drop_constraint("uq_vocab_entry_user_word", "vocab_entry", type_="unique")
    op.drop_index("ix_vocab_entry_word", table_name="vocab_entry")
    op.create_unique_constraint("vocab_entry_word_key", "vocab_entry", ["word"])
    op.drop_constraint("uq_video_progress_user_video", "video_study_progress", type_="unique")
    op.create_unique_constraint("video_study_progress_video_id_key", "video_study_progress", ["video_id"])
    op.drop_constraint("uq_study_unit_state_user_unit", "study_unit_state", type_="unique")
    op.create_unique_constraint("study_unit_state_unit_id_key", "study_unit_state", ["unit_id"])

    for table in reversed(TABLES):
        op.drop_index(f"ix_{table}_user_id", table_name=table)
        op.drop_constraint(f"fk_{table}_user_id", table, type_="foreignkey")
        op.drop_column(table, "user_id")
