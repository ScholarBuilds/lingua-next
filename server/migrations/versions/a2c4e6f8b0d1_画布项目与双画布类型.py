"""画布项目与双画布类型

Revision ID: a2c4e6f8b0d1
Revises: f1a6b2c8d9e0
Create Date: 2026-08-21 19:15:00
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "a2c4e6f8b0d1"
down_revision: str | None = "f1a6b2c8d9e0"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "studio_project",
        sa.Column("id", sa.String(length=48), nullable=False),
        sa.Column("name", sa.String(length=60), nullable=False),
        sa.Column("sort", sa.Integer(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        op.f("ix_studio_project_sort"),
        "studio_project",
        ["sort"],
        unique=False,
    )
    op.execute(
        """
        INSERT INTO studio_project (id, name, sort)
        VALUES ('default', '默认项目', 0)
        ON CONFLICT (id) DO NOTHING
        """
    )
    op.execute(
        """
        INSERT INTO studio_project (id, name, sort)
        SELECT DISTINCT project, project, 1
        FROM studio_canvas
        WHERE project IS NOT NULL AND project <> '' AND project <> 'default'
        ON CONFLICT (id) DO NOTHING
        """
    )
    op.execute(
        "UPDATE studio_canvas SET project = 'default' WHERE project IS NULL OR project = ''"
    )

    op.add_column(
        "studio_canvas",
        sa.Column(
            "kind",
            sa.String(length=16),
            server_default="smart",
            nullable=False,
        ),
    )
    op.add_column(
        "studio_canvas",
        sa.Column(
            "owner",
            sa.String(length=40),
            server_default="",
            nullable=False,
        ),
    )
    op.add_column(
        "studio_canvas",
        sa.Column("board_x", sa.Float(), nullable=True),
    )
    op.add_column(
        "studio_canvas",
        sa.Column("board_y", sa.Float(), nullable=True),
    )
    op.alter_column("studio_canvas", "kind", server_default=None)
    op.alter_column("studio_canvas", "owner", server_default=None)
    op.create_index(
        op.f("ix_studio_canvas_project"),
        "studio_canvas",
        ["project"],
        unique=False,
    )
    op.create_foreign_key(
        "fk_studio_canvas_project_studio_project",
        "studio_canvas",
        "studio_project",
        ["project"],
        ["id"],
    )


def downgrade() -> None:
    op.drop_constraint(
        "fk_studio_canvas_project_studio_project",
        "studio_canvas",
        type_="foreignkey",
    )
    op.drop_index(op.f("ix_studio_canvas_project"), table_name="studio_canvas")
    op.drop_column("studio_canvas", "board_y")
    op.drop_column("studio_canvas", "board_x")
    op.drop_column("studio_canvas", "owner")
    op.drop_column("studio_canvas", "kind")
    op.drop_index(op.f("ix_studio_project_sort"), table_name="studio_project")
    op.drop_table("studio_project")
