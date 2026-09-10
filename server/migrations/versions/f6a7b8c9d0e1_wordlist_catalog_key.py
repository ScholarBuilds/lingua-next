"""内置内容与正式单词本的稳定关联。"""

import sqlalchemy as sa
from alembic import op

revision = "f6a7b8c9d0e1"
down_revision = "e5f6a7b8c9d0"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column("wordlist", sa.Column("catalog_key", sa.String(64), nullable=True))
    op.create_index("ix_wordlist_catalog_key", "wordlist", ["catalog_key"], unique=True)


def downgrade():
    op.drop_index("ix_wordlist_catalog_key", table_name="wordlist")
    op.drop_column("wordlist", "catalog_key")
