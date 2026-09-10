"""应用注册表（模块 16 FR-427）：功能格子是数据，不是代码。

竞品的生图工作台有 40+ 个功能格子。逐个写成前端组件是灾难——三十个格子就是三十
份参数表单、三十条调用路径。盘完发现它们背后只有**四条通路**：

| engine | 通路 | 花钱 |
| --- | --- | --- |
| `generate` | `/v1/images/generations` | 是 |
| `edit` | `/v1/images/edits`（1~N 图 + 可选蒙版） | 是 |
| `vision` | 既有视觉 LLM 别名 | 是（便宜） |
| `local` | 浏览器 Canvas / 服务端 Pillow | 否 |

于是一个应用就是一条记录。**加应用 = 加一条数据 + 一条用途，不改服务层、不改
控制台、不改资产库**（AC-109）——「电商与人像」那一整包能进来而不涨复杂度，
靠的就是这条。

与 `ImageTarget` 的分工：

- `ImageTarget`（`image_prompts.TARGETS`）管**画面**：goal、构图、禁区、画幅、风格
- `ImageApp`（这里）管**入口**：引擎、要用户给什么、UI 怎么呈现、锁死哪些上游参数

所以电商/人像这类新应用需要的新画面，走 `register_target()` 注册进既有注册表，
不在这里另立一套提示词机制。
"""

from __future__ import annotations

from dataclasses import dataclass, field

from domain.image_prompts import (
    TARGETS,
    ImageTarget,
    PromptError,
    register_target,
)

# ---- 分类 ----

CATEGORIES: tuple[tuple[str, str, str], ...] = (
    # (key, 中文名, 一句话说明)
    ("learning", "学习资产", "平台里真正要用的图，出完能直接应用到对应位置"),
    ("create", "AI 创作", "从零出图、照着图出图、以及把图变回提示词"),
    ("edit", "编辑应用", "在已有图上改：涂哪改哪、往外扩、换背景、抠透明"),
    ("commerce", "产品电商", "商品图的几种常见成片"),
    ("portrait", "人像写真", "人脸类，一律锁高保真档"),
    ("retouch", "基础修图", "裁剪、标注、滤镜、水印——纯前端，不调模型不花钱"),
)

CATEGORY_LABELS: dict[str, str] = {key: label for key, label, _ in CATEGORIES}

ENGINES = ("generate", "edit", "vision", "local")

# 输入形态。`mask` 与 `outpaint` 都隐含 `image`，前端据此决定给不给画布
INPUTS = ("prompt", "image", "images", "mask", "outpaint")


@dataclass(frozen=True)
class ImageApp:
    """一个应用格子。"""

    key: str
    label: str
    category: str
    engine: str
    target_key: str
    hint: str
    inputs: tuple[str, ...] = ("prompt",)
    # 锁死的上游参数（background / input_fidelity / output_format）。
    # 锁死而不是给用户选，是因为它们是这个应用能不能用的分水岭而非偏好
    fixed: dict[str, str] = field(default_factory=dict)
    ratio: str | None = None  # 锁比例；None = 用户可选
    style_key: str | None = None  # 锁风格；None = 用户可选
    badge: str | None = None  # 格子右上角的小标，如「不花钱」「需 2 张图」
    order: int = 0

    def __post_init__(self) -> None:
        if self.engine not in ENGINES:
            raise ValueError(f"{self.key}: 未知引擎 {self.engine}")
        if self.category not in CATEGORY_LABELS:
            raise ValueError(f"{self.key}: 未知分类 {self.category}")
        for item in self.inputs:
            if item not in INPUTS:
                raise ValueError(f"{self.key}: 未知输入形态 {item}")

    @property
    def needs_image(self) -> bool:
        return bool({"image", "images", "mask", "outpaint"} & set(self.inputs))

    @property
    def needs_mask(self) -> bool:
        return "mask" in self.inputs

    @property
    def costs_money(self) -> bool:
        return self.engine != "local"

    @property
    def target(self) -> ImageTarget:
        target = TARGETS.get(self.target_key)
        if target is None:
            raise PromptError(f"应用 {self.key} 指向了不存在的用途 {self.target_key}")
        return target


# ---- 应用专属用途 ----
#
# 电商与人像不是新能力，是新画面。所以只注册用途，不加代码路径。
#
# 关于 `default_style`：只在**用途本身规定了呈现方式**时才写死（商品场景图与人像
# 必须是照片，出成插画就是废图，所以钉 airy-photo）。用途没这个要求的一律别钉——
# 通用出图 `free` 就因为继承了 dataclass 默认的 soft-flat，把给单词卡调的插画风
# 套到了所有自由出图上，现已改成 `NO_STYLE_KEY`（见 image_prompts）。

_EXTRA_TARGETS: tuple[ImageTarget, ...] = (
    ImageTarget(
        key="product_white_bg",
        label="白底商品图",
        goal="a clean e-commerce product shot on a pure white background",
        size="1024x1024",
        sizes=("1024x1024", "1536x1024"),
        composition="the product centred and fully in frame, occupying about 80% of "
        "the canvas, a soft contact shadow directly beneath it, nothing else in shot",
        subject_kind="the product itself, photographed straight on",
        extra_avoid=("props", "background scenery", "reflections of a studio"),
    ),
    ImageTarget(
        key="product_scene",
        label="商品场景图",
        goal="a lifestyle photo placing a product in the environment where it is used",
        size="1536x1024",
        sizes=("1536x1024", "1024x1024", "1024x1536"),
        composition="the product clearly the subject but naturally placed in a real "
        "setting, shallow depth of field, environment readable but not competing",
        subject_kind="the product plus the room or surface it naturally lives on",
        default_style="airy-photo",
    ),
    ImageTarget(
        key="product_selling",
        label="商品卖点图",
        goal="a product hero image laid out to leave room for marketing copy",
        size="1024x1024",
        sizes=("1024x1024", "1536x1024", "1024x1536"),
        composition="product on one side, a large calm empty area on the other side "
        "reserved for text that will be added later - leave that area genuinely empty",
        subject_kind="the product, shot to sell one specific feature",
        # 文案后期叠上去，图里不写字：模型拼写不可靠，缩略后是糊字（BR-103）
        extra_avoid=("any lettering", "any logo", "any price tag"),
    ),
    ImageTarget(
        key="portrait_pro",
        label="职业头像",
        goal="a professional headshot suitable for a profile picture",
        size="1024x1024",
        sizes=("1024x1024", "768x768"),
        quality="high",
        composition="head and shoulders, eyes at the upper third, neutral uncluttered "
        "background, subject facing slightly off-axis",
        subject_kind="the person in the reference photo, same face, tidied presentation",
        default_style="airy-photo",
    ),
    ImageTarget(
        key="portrait_style",
        label="风格化写真",
        goal="a stylised portrait of the person in the reference image",
        size="1024x1536",
        sizes=("1024x1536", "1024x1024", "768x1024"),
        quality="high",
        composition="upper body, the styling carries the mood, face stays recognisable",
        subject_kind="the same person, restyled",
        default_style="airy-photo",
    ),
    ImageTarget(
        key="ui_illustration",
        label="空状态插画",
        goal="a small friendly illustration for an empty state in a learning app",
        size="1024x1024",
        sizes=("1024x1024", "768x768"),
        quality="low",
        composition="one simple object or tiny scene, lots of white space, "
        "reads clearly at 160px",
        subject_kind="a gentle visual metaphor for 'nothing here yet'",
    ),
    ImageTarget(
        key="avatar",
        label="头像",
        goal="a square avatar image",
        size="1024x1024",
        sizes=("1024x1024", "768x768"),
        composition="single subject centred, safe inside a circular crop - "
        "nothing important within 12% of any edge",
        subject_kind="whatever the user described, framed as an avatar",
    ),
)

for _target in _EXTRA_TARGETS:
    register_target(_target)


# ---- 应用注册表 ----

_APP_LIST: tuple[ImageApp, ...] = (
    # -- 学习资产：绑定既有用途，出完能直接应用回去。
    #    这一类一律锁比例——画幅由展示它的那块 UI 决定，不是偏好（FR-432）--
    ImageApp("deck_cover", "场景本封面", "learning", "generate", "deck_cover",
             "单词本卡片顶部那条宽幅封面，构图已避开徽章与进度环",
             ratio="2.5:1", order=1),
    ImageApp("book_cover", "书籍封面", "learning", "generate", "book_cover",
             "书架上的竖版封面，缺封面的书用它补", ratio="2:3", order=2),
    ImageApp("talk_scene", "对话场景卡", "learning", "generate", "talk_scene",
             "口语陪练场景卡的配图，画环境不画人脸", ratio="16:9", order=3),
    ImageApp("passage_illustration", "短文配图", "learning", "generate",
             "passage_illustration", "场景短文的插图，取文中一个具体瞬间",
             ratio="16:9", order=4),
    ImageApp("word_mnemonic", "单词助记图", "learning", "generate", "word_mnemonic",
             "把词义演成一张夸张的小图，帮着记住", ratio="1:1", order=5),
    ImageApp("ui_illustration", "空状态插画", "learning", "generate", "ui_illustration",
             "列表为空时那块地方的配图", ratio="1:1", order=6),

    # -- AI 创作 --
    ImageApp("text_to_image", "文生图", "create", "generate", "free",
             "写一句话出图，比例风格都能自己挑", order=10),
    ImageApp("image_to_image", "参考图生图", "create", "edit", "free",
             "照着一张图重画，用来出同系列的下一张",
             inputs=("prompt", "image"), order=11),
    ImageApp("consistent_edit", "一致性续画", "create", "edit", "free",
             "继承参考图的主体、服装、构图和材质，只改这一轮指定的内容",
             inputs=("prompt", "image"), fixed={"input_fidelity": "high"},
             badge="锁高保真", order=12),
    ImageApp("image_fusion", "多图融合", "create", "edit", "free",
             "把两张以上的图揉成一张，比如把这个物体放进那个场景",
             inputs=("prompt", "images"), badge="需 2 张以上", order=13),
    ImageApp("describe", "描述词反推", "create", "vision", "free",
             "传一张图反推出提示词——手上有满意的图想要同系列时最省事",
             inputs=("image",), badge="不出图", order=14),
    ImageApp("avatar", "头像", "create", "generate", "avatar",
             "方形头像，构图留了圆形裁切的安全边", ratio="1:1", order=15),
    ImageApp("batch_plan", "批量策划", "create", "generate", "free",
             "一句话交给 AI 拆成若干张的方案，逐条改完再一起出", order=16),

    # -- 编辑应用：差别只在蒙版怎么来，通路是同一条 --
    ImageApp("inpaint", "局部重绘", "edit", "edit", "free",
             "涂哪改哪，其余像素不动",
             inputs=("prompt", "image", "mask"), badge="需涂选区", order=20),
    ImageApp("erase", "万物消除", "edit", "edit", "free",
             "涂掉不想要的东西，模型按周围补上",
             inputs=("prompt", "image", "mask"), badge="需涂选区", order=21),
    ImageApp("replace_object", "万物替换", "edit", "edit", "free",
             "涂住一个东西，说要换成什么",
             inputs=("prompt", "image", "mask"), badge="需涂选区", order=22),
    ImageApp("replace_bg", "换背景", "edit", "edit", "free",
             "涂住主体，背景整个换掉",
             inputs=("prompt", "image", "mask"), badge="涂主体，取反", order=23),
    ImageApp("outpaint", "AI 扩图", "edit", "edit", "free",
             "把画面往外补，改比例又不想裁掉东西时用",
             inputs=("prompt", "image", "outpaint"), badge="拖边框", order=24),
    ImageApp("transparent", "透明底", "edit", "generate", "free",
             "直接出透明背景的 PNG，贴到任何底色上都不出白边",
             fixed={"background": "transparent", "output_format": "png"}, order=25),
    ImageApp("restyle", "换风格", "edit", "edit", "free",
             "画面内容不动，换一套画风",
             inputs=("prompt", "image"), order=26),
    ImageApp("enhance_detail", "细节增强", "edit", "edit", "free",
             "重绘式增强：纹理边缘更清楚，构图主体配色都不动，像素尺寸不变",
             inputs=("prompt", "image"), order=27),
    ImageApp("angle_shift", "角度控制", "edit", "edit", "free",
             "换个机位重画：转盘选好角度，指令自动写进提示词",
             inputs=("prompt", "image"), order=28),

    # -- 产品电商 --
    ImageApp("product_white_bg", "白底商品图", "commerce", "generate",
             "product_white_bg", "纯白底、居中、柔和落影，电商主图那一套",
             ratio="1:1", order=30),
    ImageApp("product_scene", "商品场景图", "commerce", "edit", "product_scene",
             "把商品放进真实使用环境里",
             inputs=("prompt", "image"), order=31),
    ImageApp("product_selling", "商品卖点图", "commerce", "generate",
             "product_selling", "一侧放商品，另一侧留空给后期加文案（图里不写字）",
             order=32),
    ImageApp("product_set", "商品套图", "commerce", "generate", "product_scene",
             "一个商品一次出多种场景，走批量策划那条路", order=33),

    # -- 人像写真：一律锁高保真，否则会换脸 --
    ImageApp("portrait_pro", "职业头像", "portrait", "edit", "portrait_pro",
             "证件照式的干净头像，脸保持是同一个人",
             inputs=("prompt", "image"), fixed={"input_fidelity": "high"},
             ratio="1:1", badge="锁高保真", order=40),
    ImageApp("portrait_style", "风格化写真", "portrait", "edit", "portrait_style",
             "换服装换氛围，脸不变",
             inputs=("prompt", "image"), fixed={"input_fidelity": "high"},
             badge="锁高保真", order=41),
    ImageApp("portrait_poses", "多姿势", "portrait", "edit", "portrait_style",
             "同一个人出多种姿态，走批量策划那条路",
             inputs=("prompt", "image"), fixed={"input_fidelity": "high"},
             badge="锁高保真", order=42),

    # -- 基础修图：纯前端，不调模型 --
    ImageApp("retouch", "图片编辑器", "retouch", "local", "free",
             "裁剪、旋转、标注、文字、水印、滤镜、缩放，改完存回资产库",
             inputs=("image",), badge="不花钱", order=50),
)

APPS: dict[str, ImageApp] = {app.key: app for app in _APP_LIST}

_CONSISTENCY_INSTRUCTION = (
    "Use every supplied image as a strict visual reference. Preserve identity, facial "
    "structure, hairstyle, clothing, accessories, body proportions, materials, colour "
    "palette, camera relationship, and every detail not explicitly changed below. "
    "Apply only the requested change; do not redesign the subject, replace it with a "
    "similar subject, or add labels or text. Requested change: "
)


def get_app(key: str) -> ImageApp:
    app = APPS.get(key)
    if app is None:
        raise PromptError(f"未知生图应用：{key}")
    return app


def prepare_edit_prompt(app: ImageApp, prompt: str) -> str:
    """一致性续画用稳定的系统约束包住用户指令，其他编辑应用保持原文。"""
    cleaned = prompt.strip()
    if app.key != "consistent_edit":
        return cleaned
    return f"{_CONSISTENCY_INSTRUCTION}{cleaned}"


def register_app(app: ImageApp) -> None:
    """新增应用只需注册一条（AC-109）。"""
    APPS[app.key] = app


def app_view() -> list[dict]:
    """给应用选择器的数据。按分类顺序、组内按 order 排。"""
    order_of = {key: i for i, (key, _, _) in enumerate(CATEGORIES)}
    apps = sorted(APPS.values(), key=lambda a: (order_of.get(a.category, 99), a.order))
    out = []
    for app in apps:
        target = app.target
        out.append(
            {
                "key": app.key,
                "label": app.label,
                "category": app.category,
                "engine": app.engine,
                "target_key": app.target_key,
                "hint": app.hint,
                "inputs": list(app.inputs),
                "fixed": dict(app.fixed),
                "ratio": app.ratio,
                "style_key": app.style_key,
                "badge": app.badge,
                "needs_image": app.needs_image,
                "needs_mask": app.needs_mask,
                "costs_money": app.costs_money,
                "default_style": app.style_key or target.default_style,
                "default_size": target.size,
                "sizes": list(target.sizes),
                "quality": target.quality,
                "aspect_note": target.aspect_note,
                "applies": target.applier is not None,
            }
        )
    return out


def category_view() -> list[dict]:
    counts: dict[str, int] = {}
    for app in APPS.values():
        counts[app.category] = counts.get(app.category, 0) + 1
    return [
        {"key": key, "label": label, "hint": hint, "count": counts.get(key, 0)}
        for key, label, hint in CATEGORIES
    ]
