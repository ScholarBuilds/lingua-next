"""退役场景百科词本，保留共享学习记录。"""

import sqlalchemy as sa
from alembic import op

revision = "b8c9d0e1f2a3"
down_revision = "a7b8c9d0e1f2"
branch_labels = None
depends_on = None


def upgrade():
    connection = op.get_bind()
    # 关联短文可能已有阅读记录，解除归属而不级联删除。
    connection.execute(
        sa.text(
            "UPDATE article SET deck_id = NULL WHERE deck_id IN "
            "(SELECT id FROM wordlist WHERE catalog_key = 'scene-atlas')"
        )
    )
    connection.execute(
        sa.text(
            "DELETE FROM wordlist_item WHERE wordlist_id IN "
            "(SELECT id FROM wordlist WHERE catalog_key = 'scene-atlas')"
        )
    )
    connection.execute(sa.text("DELETE FROM wordlist WHERE catalog_key = 'scene-atlas'"))


def downgrade():
    raise RuntimeError("退役词本的内容需从迁移前备份恢复")
