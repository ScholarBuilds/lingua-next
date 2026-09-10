"""用户自定义画风（模块 16 FR-442）。

内置风格有两批：代码里自制的五个（照着卡片封面的真实显示尺寸调过），以及
`data/image_styles.json` 里从 twri/sdxl_prompt_styler（MIT）导入并清洗的一百多个。
这两批都是只读。这里管的是用户自己攒的那批，存 `image_style` 表。

> [!danger] 别只往内存注册表里塞
>
> API 与 worker 是**两个进程**。用户在网页上新建一个风格，只写进 API 进程的
> `STYLE_PRESETS`，worker 那边一无所知，出图时就报「未知风格预设」——网页上能下单、
> 任务在后台失败，本模块刚踩过一模一样的坑（§14.6）。所以凡是要用到风格的地方，
> 先 `await ensure_loaded(session)`：从库里把自定义风格补进本进程的注册表。
"""

from __future__ import annotations

import re
from dataclasses import dataclass

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from domain.image_prompts import (
    STYLE_PRESETS,
    PromptError,
    StylePreset,
    drop_style,
    register_style,
)
from domain.models import ImageStyle

CUSTOM_SOURCE = "自定义"
KEY_PATTERN = re.compile(r"^[a-z][a-z0-9-]{1,47}$")

# 自定义风格能落在哪些分类里。不给「封面专用」——那一档是自制那五个的专属，
# 它们的构图禁区是照着真实卡片尺寸量的，用户自己写的提示词没有这层保证
ALLOWED_CATEGORIES = (
    "general", "photo", "art", "concept", "game", "craft", "commerce", "misc",
)


@dataclass(frozen=True)
class StyleDraft:
    """新建/编辑自定义风格的入参，校验后才落库。"""

    key: str
    label: str
    hint: str = ""
    category: str = "misc"
    render: str = ""
    palette: str = ""
    lighting: str = ""
    texture: str = ""
    extra_avoid: tuple[str, ...] = ()

    def validated(self, *, existing: bool) -> StyleDraft:
        key = self.key.strip().lower()
        if not KEY_PATTERN.match(key):
            raise PromptError("标识只能用小写字母、数字和短横线，2~48 位且以字母开头")
        if not existing and key in STYLE_PRESETS:
            hit = STYLE_PRESETS[key]
            if hit.source != CUSTOM_SOURCE:
                raise PromptError(f"「{key}」已被内置风格「{hit.label}」占用，换一个标识")
        label = " ".join(self.label.split())
        if not label:
            raise PromptError("给这个风格起个名字")
        if len(label) > 24:
            raise PromptError("名字太长了，24 个字以内")
        if self.category not in ALLOWED_CATEGORIES:
            raise PromptError(f"未知分类：{self.category}")
        if not self.render.strip():
            raise PromptError("「画面描述」是这个风格的主体，不能为空")
        return StyleDraft(
            key=key,
            label=label,
            hint=" ".join(self.hint.split())[:160],
            category=self.category,
            render=self.render.strip(),
            palette=self.palette.strip(),
            lighting=self.lighting.strip(),
            texture=self.texture.strip(),
            extra_avoid=tuple(
                term for term in (t.strip() for t in self.extra_avoid) if term
            ),
        )


def to_preset(row: ImageStyle) -> StylePreset:
    return StylePreset(
        key=row.key,
        label=row.label,
        hint=row.hint or "",
        render=row.render,
        palette=row.palette or "",
        lighting=row.lighting or "",
        texture=row.texture or "",
        extra_avoid=tuple(row.extra_avoid or ()),
        builtin=False,
        category=row.category,
        source=CUSTOM_SOURCE,
    )


async def ensure_loaded(session: AsyncSession) -> int:
    """把库里的自定义风格补进本进程的注册表。幂等，可以随便调。"""
    rows = (await session.execute(select(ImageStyle))).scalars().all()
    live = {row.key for row in rows}
    for row in rows:
        register_style(to_preset(row))
    # 别的进程删掉的，这里也要跟着掉，否则会一直用着已经不存在的风格出图
    for key, preset in list(STYLE_PRESETS.items()):
        if preset.source == CUSTOM_SOURCE and key not in live:
            drop_style(key)
    return len(rows)


async def list_styles(session: AsyncSession) -> list[ImageStyle]:
    rows = await session.execute(
        select(ImageStyle).order_by(ImageStyle.updated_at.desc())
    )
    return list(rows.scalars().all())


async def create(session: AsyncSession, draft: StyleDraft) -> ImageStyle:
    clean = draft.validated(existing=False)
    if await session.get(ImageStyle, clean.key) is not None:
        raise PromptError(f"「{clean.key}」已经有了，换一个标识或者直接改它")
    row = ImageStyle(
        key=clean.key,
        label=clean.label,
        hint=clean.hint,
        category=clean.category,
        render=clean.render,
        palette=clean.palette,
        lighting=clean.lighting,
        texture=clean.texture,
        extra_avoid=list(clean.extra_avoid),
    )
    session.add(row)
    await session.commit()
    await session.refresh(row)
    register_style(to_preset(row))
    return row


async def update(session: AsyncSession, key: str, draft: StyleDraft) -> ImageStyle:
    row = await session.get(ImageStyle, key)
    if row is None:
        raise PromptError(f"没有这个自定义风格：{key}")
    clean = draft.validated(existing=True)
    if clean.key != key:
        raise PromptError("标识建好之后不能改——已经出过的图记着它，改了就追不回来了")
    row.label = clean.label
    row.hint = clean.hint
    row.category = clean.category
    row.render = clean.render
    row.palette = clean.palette
    row.lighting = clean.lighting
    row.texture = clean.texture
    row.extra_avoid = list(clean.extra_avoid)
    await session.commit()
    await session.refresh(row)
    register_style(to_preset(row))
    return row


async def delete(session: AsyncSession, key: str) -> None:
    row = await session.get(ImageStyle, key)
    if row is None:
        raise PromptError(f"没有这个自定义风格：{key}")
    await session.delete(row)
    await session.commit()
    drop_style(key)


def view(row: ImageStyle) -> dict:
    return {
        "key": row.key,
        "label": row.label,
        "hint": row.hint or "",
        "category": row.category,
        "render": row.render,
        "palette": row.palette or "",
        "lighting": row.lighting or "",
        "texture": row.texture or "",
        "avoid": list(row.extra_avoid or ()),
        "builtin": False,
        "source": CUSTOM_SOURCE,
        "updated_at": row.updated_at.isoformat() if row.updated_at else None,
    }
