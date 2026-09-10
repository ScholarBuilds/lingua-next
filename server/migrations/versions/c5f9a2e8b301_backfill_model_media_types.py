"""自动发现模型媒体类型回填

Revision ID: c5f9a2e8b301
Revises: b4e8c1d7f290
Create Date: 2026-08-22 13:10:00
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "c5f9a2e8b301"
down_revision: str | None = "b4e8c1d7f290"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_IMAGE_MARKERS = (
    "gpt-image", "dall-e", "imagen", "imagegen", "qwen-image", "z-image",
    "flux", "recraft", "stable-diffusion", "sdxl", "kolors", "banana",
)
_VIDEO_MARKERS = (
    "sora", "veo", "video", "seedance", "wan2", "hailuo", "kling", "runway", "luma",
)


def _inferred(model: str, adapter: str) -> list[str]:
    lowered = model.lower()
    if adapter in {"apimart", "tudou", "modelscope", "gemini"}:
        return ["image"]
    if adapter in {"volcengine"}:
        return ["video"]
    if adapter in {"comfyui", "runninghub"}:
        return ["workflow"]
    if adapter in {"openai", "litellm"}:
        if any(marker in lowered for marker in _IMAGE_MARKERS):
            return ["image"]
        if adapter == "openai" and any(marker in lowered for marker in _VIDEO_MARKERS):
            return ["video"]
        return ["chat"]
    return []


def upgrade() -> None:
    table = sa.table(
        "model_deployment",
        sa.column("id", sa.Integer()),
        sa.column("upstream_model_id", sa.String()),
        sa.column("adapter_type", sa.String()),
        sa.column("media_types", sa.JSON()),
        sa.column("discovered", sa.Boolean()),
    )
    connection = op.get_bind()
    rows = connection.execute(
        sa.select(
            table.c.id,
            table.c.upstream_model_id,
            table.c.adapter_type,
            table.c.media_types,
            table.c.discovered,
        )
    ).mappings()
    for row in rows:
        if not row["discovered"] or row["media_types"]:
            continue
        media_types = _inferred(row["upstream_model_id"], row["adapter_type"])
        if media_types:
            connection.execute(
                sa.update(table)
                .where(table.c.id == row["id"])
                .values(media_types=media_types)
            )


def downgrade() -> None:
    # 无法区分回填值和迁移前已有值，降级不清空业务分类。
    pass
