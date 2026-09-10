"""生图提示词层：用途注册表 + 风格预设 + 提示词渲染（模块 16 FR-410~414）。

结构抄 `~/.claude/skills/gpt-image-2` 的 JSON 模板方法论：一张图的提示词拆成
`type / goal / subject / scene / layout / style / constraints` 七段，字段按
「必问 / 可默认 / 可随机」分类。这里做的适配是把「问用户」换成「问 LLM」——
平台已经握有场景本的标题、描述、关键词、CEFR，没必要再问一遍。

分工是这一层的全部设计：

- **LLM 只写 subject 与 scene**：把「咖啡馆点单」变成具体的可画之物（吧台、
  意式咖啡机、糕点柜、吊挂菜单板、清晨侧光）。这是模型真正擅长且不可替代的一步。
- **style 与 constraints 由预设写死**：13 个场景本各自发挥会得到 13 种画风，
  列表页就成了大杂烩。一致性在这个位置比单张好看重要得多。
- **layout 由展示位反推**：封面不是孤立的画，它被卡片的徽章和进度环压住四角，
  构图禁区必须进提示词。

统一画风只对**学习资产**成立——那些图要摆在同一个列表里。通用出图（`free`）没有
这个约束，默认就是 `NO_STYLE`「不指定画风」：给它套插画风是缺陷不是一致性。

> [!warning] 尺寸不是随便填的
>
> gpt-image-2 要求宽高都能被 16 整除、宽高比在 1:3 到 3:1 之间。这里所有
> 预置尺寸都已按此校验（`validate_size`），新增尺寸务必走同一个校验。
"""

from __future__ import annotations

import json
import logging
from collections.abc import Callable
from dataclasses import dataclass, field, replace
from pathlib import Path

from domain import image_defaults

# gpt-image-2 的尺寸硬约束（官方 API 文档，2026-08）
logger = logging.getLogger(__name__)

SIZE_STEP = 16
MIN_RATIO = 1 / 3
MAX_RATIO = 3.0
MAX_EDGE = 3840
# 超过这个像素面积官方标注为实验性，默认不放开
SAFE_MAX_PIXELS = 2560 * 1440

QUALITIES = ("low", "medium", "high")

#: 「不指定画幅」的一等选项。与画风的 `NO_STYLE_KEY` 完全同构，理由也一样。
#:
#: 空串/None 表达不了「我明确不要指定」——它一路被 `size or 默认` 吞掉，
#: 回落到 Tunable 的 `1536x608`（那个数当初是给单词卡横幅调的）。后果实测过：
#: 画布上选着「画幅自动」、写「出一个移动端 app 的登录页面」，发出去的提示词是
#: `…… Canvas: 1536x608, aspect ratio 2.53:1. Compose for this exact shape.`
#: 模型只能把三个手机屏并排塞进一张超宽 banner——它没有不听话，是我们让它这么画的。
#:
#: 三态因此必须分开：
#: - None / ""  = 没说，回落该用途的默认（词卡横幅那条链不变）
#: - "auto"     = 明确不指定：不传 size 给上游，也不补画布句，由模型自己判断
#: - "1024x1536" 等 = 用它，并补画布句（上游按提示词里的比例出图，不看 size 参数）
AUTO_SIZE = "auto"


def is_auto_size(size: str | None) -> bool:
    """这个尺寸是不是「明确不指定」。空串不算——那是「没说」。"""
    return str(size or "").strip().lower() == AUTO_SIZE


class PromptError(Exception):
    """模板或参数不合法，消息面向调用方。"""


def parse_size(size: str) -> tuple[int, int]:
    raw = str(size or "").lower().replace("×", "x").strip()
    if raw == AUTO_SIZE:
        raise PromptError("画幅为「自动」时没有具体尺寸，调用方应先用 is_auto_size 分流")
    if "x" not in raw:
        raise PromptError(f"尺寸格式应为 宽x高，收到 {size!r}")
    w_s, _, h_s = raw.partition("x")
    try:
        return int(w_s), int(h_s)
    except ValueError as exc:
        raise PromptError(f"尺寸格式应为 宽x高，收到 {size!r}") from exc


def validate_size(size: str) -> str:
    """校验并归一化尺寸；不合法直接抛，不做静默纠正。

    静默纠正在这里是有害的：用户在节点里填了 1000x600，被悄悄改成 1008x608
    之后产物指纹与他填的值对不上，下次重跑会莫名其妙不命中缓存。

    `"auto"` 原样放行——它是一等选项而不是"缺了个值"，见 `AUTO_SIZE`。
    """
    if is_auto_size(size):
        return AUTO_SIZE
    w, h = parse_size(size)
    if w <= 0 or h <= 0:
        raise PromptError(f"尺寸必须为正数，收到 {size!r}")
    if w % SIZE_STEP or h % SIZE_STEP:
        raise PromptError(f"宽高都必须是 {SIZE_STEP} 的倍数，{w}x{h} 不满足")
    if max(w, h) > MAX_EDGE:
        raise PromptError(f"单边不得超过 {MAX_EDGE}，{w}x{h} 超了")
    ratio = w / h
    if not (MIN_RATIO <= ratio <= MAX_RATIO):
        raise PromptError(f"宽高比须在 1:3 与 3:1 之间，{w}x{h} 是 {ratio:.2f}:1")
    return f"{w}x{h}"


def _canvas_line(size: str) -> str:
    w, h = parse_size(size)
    return f"{w}x{h} ({w / h:.2f}:1)"


def is_experimental(size: str) -> bool:
    """超过 2560x1440 与否。上游文档把这以上标为实验性分辨率。

    这条**不再拦人**：用户明确要 4K，且自有账号 token 不是约束。但它仍然是个事实，
    UI 该照实标出来——「能出」和「上游保证出得好」是两回事。硬约束（16 的倍数、
    1:3~3:1、单边不超 3840）仍在 `validate_size` 里拦。

    画幅「自动」时返回 False：没指定分辨率就谈不上"超没超"，
    而这个函数被 UI 直接调用，让它抛等于点开尺寸选择器就白屏。
    """
    if is_auto_size(size):
        return False
    w, h = parse_size(size)
    return w * h > SAFE_MAX_PIXELS


# ---- 风格预设 ----


@dataclass(frozen=True)
class StylePreset:
    """一套画风。同一预设下不同主体的图放在一起要像同一个人画的。"""

    key: str
    label: str
    hint: str  # 给用户看的一句话
    render: str  # 注入 style.render
    palette: str = ""
    lighting: str = ""
    texture: str = ""
    extra_avoid: tuple[str, ...] = ()
    builtin: bool = True
    # 分类与检索：一百多个风格摆在一起，没有分类和标签就没法挑
    category: str = "general"
    tags: tuple[str, ...] = ()
    # 出处。自制的写「自制」，导入的写清楚仓库与许可，自定义的写「自定义」
    source: str = "自制"


STYLE_PRESETS: dict[str, StylePreset] = {
    "soft-flat": StylePreset(
        key="soft-flat",
        label="柔和扁平插画",
        hint="降饱和扁平矢量，留白多，缩到 92px 高也认得出主体（默认）",
        render="flat vector illustration, simplified geometric shapes, no outlines, "
        "generous negative space, single clear focal object",
        palette="muted desaturated palette, two dominant hues plus one warm accent, "
        "mid-tone brightness overall",
        lighting="soft even ambient light, no harsh shadows, no strong highlights",
        texture="very subtle paper grain",
    ),
    "warm-gouache": StylePreset(
        key="warm-gouache",
        label="暖调水粉",
        hint="手绘水粉笔触，颜色温暖，适合日常生活类场景",
        render="gouache painting, visible soft brush strokes, hand-painted edges, "
        "simplified forms",
        palette="warm earthy palette, terracotta and sage and cream",
        lighting="warm afternoon light from the side",
        texture="cold-press watercolour paper texture",
    ),
    "clean-isometric": StylePreset(
        key="clean-isometric",
        label="清爽等距",
        hint="等距视角小场景，结构清楚，适合职场、编程、器械类场景",
        render="isometric illustration, 30 degree axonometric view, clean edges, "
        "small tidy diorama of the scene",
        palette="cool neutral palette with a single saturated accent",
        lighting="soft top-down light, gentle contact shadows",
    ),
    "airy-photo": StylePreset(
        key="airy-photo",
        label="通透摄影",
        hint="浅景深实拍感，适合食物、旅行、实物类场景",
        render="photographic, shallow depth of field, natural composition, "
        "realistic materials",
        palette="natural colours, slightly lifted shadows, low contrast grade",
        lighting="diffused daylight from a large window",
        extra_avoid=("over-saturated HDR look", "stock-photo posed people"),
    ),
    "abstract-texture": StylePreset(
        key="abstract-texture",
        label="抽象底纹",
        hint="不画具体物体，只出与主题呼应的抽象纹理——emoji 仍然是主角",
        render="abstract non-representational texture, soft organic shapes and "
        "gradients, no recognisable objects",
        palette="two-tone gradient wash derived from the theme mood",
        lighting="flat, no directional light",
        texture="fine noise grain",
    ),
}

DEFAULT_STYLE = "soft-flat"

# 所有用途共用的红线。生成图里出现文字是这类模型最常见的翻车点：
# 拼写基本靠猜，缩到卡片尺寸后就是一团糊掉的伪字母。除非用途显式允许，一律禁掉。
GLOBAL_AVOID: tuple[str, ...] = (
    "any text, letters, numbers, words or captions",
    "logos, watermarks, signatures, UI chrome",
    "collage or multi-panel layout",
    "borders, frames, vignettes",
    "gore, weapons, anything unsettling",
)


STYLE_CATEGORIES: dict[str, str] = {
    "cover": "封面专用",
    "general": "通用",
    "photo": "摄影",
    "art": "绘画",
    "concept": "概念与科幻",
    "game": "游戏",
    "craft": "手作质感",
    "commerce": "广告电商",
    "misc": "其它",
    # 独占一档，排在最后：它不是一种画风，与其它分类不可比，混进任何一档都会
    # 让那一档多出一个「不属于它」的成员
    "none": "不指定",
}

# 本仓自制的五个都归到「封面专用」：它们是照着卡片封面的实际显示尺寸调的，
# 与导入的通用风格不是一回事，混在一起挑会选错
for _preset in list(STYLE_PRESETS.values()):
    STYLE_PRESETS[_preset.key] = replace(_preset, category="cover")

NO_STYLE_CATEGORY = "none"
NO_STYLE_KEY = "none"

# 「不指定画风」必须是注册表里真实存在的一项，不能靠传空串表达。
# 空串会被 `style_key or default_style` 吞掉、回落成用途的默认画风——于是通用出图
# 被硬套上了给单词卡调的插画风，用户反馈的「文生图全是柔和扁平插画」就是这么来的。
# 四个描述字段全空，渲染时整段 style 不进结构，一个风格词都不注入。
#
# 注册放在上面那个「归类到封面专用」的循环之后：它不是照卡片尺寸调出来的画风，
# 不该被一起改成 cover 分类。
NO_STYLE = StylePreset(
    key=NO_STYLE_KEY,
    label="不指定画风",
    hint="不注入任何风格描述词，画面风格由你的意图和模型自己决定",
    render="",
    palette="",
    lighting="",
    texture="",
    category=NO_STYLE_CATEGORY,
    source="自制",
)
STYLE_PRESETS[NO_STYLE_KEY] = NO_STYLE


def _load_imported_styles() -> int:
    """把 `data/image_styles.json` 里的风格并进注册表。

    那份数据由 `scripts/import_image_styles.py` 从 twri/sdxl_prompt_styler（MIT）
    抓取并清洗而来——原始提示词是给 SDXL 那类模型调的，塞满「8K / masterpiece /
    highly detailed」这种质量咒，对指令跟随模型只是稀释真正的风格描述，导入时已剔除。

    文件缺失不算错：它是可再生成的产物，没有就只剩自制的那几个，功能不受影响。
    """
    path = Path(__file__).resolve().parents[1] / "data" / "image_styles.json"
    if not path.exists():
        logger.info(
            "没有 data/image_styles.json，只用自制风格。"
            "跑 scripts/import_image_styles.py 可生成"
        )
        return 0
    payload = json.loads(path.read_text(encoding="utf-8"))
    STYLE_CATEGORIES.update(payload.get("categories") or {})
    added = 0
    for row in payload.get("styles") or []:
        key = str(row.get("key") or "")
        # 自制的优先：同名不覆盖，那几个是照着真实显示尺寸调过的
        if not key or key in STYLE_PRESETS:
            continue
        STYLE_PRESETS[key] = StylePreset(
            key=key,
            label=str(row.get("label") or row.get("origin_name") or key),
            hint=str(row.get("hint") or ""),
            render=str(row.get("render") or ""),
            extra_avoid=tuple(row.get("extra_avoid") or ()),
            category=str(row.get("category") or "misc"),
            tags=tuple(str(row.get("origin_name") or "").replace("-", " ").split()),
            source=str(row.get("source") or ""),
        )
        added += 1
    return added


IMPORTED_STYLE_COUNT = _load_imported_styles()


# ---- 用途注册表 ----


@dataclass(frozen=True)
class ImageTarget:
    """一个生图用途：它长什么样、放在哪、画完写回哪。

    `safe_areas` 是这个 dataclass 存在的主要理由——同样一张插画，放在书架里
    是整块可见的，放在单词本卡片上左上角被 AI/CEFR 徽章压着、右下角被进度环
    压着。构图禁区不进提示词，主体就会正好被挡住。
    """

    key: str
    label: str
    goal: str  # 注入 goal，说明这张图要干什么
    size: str
    sizes: tuple[str, ...]
    quality: str = image_defaults.FALLBACK_QUALITY
    default_style: str = DEFAULT_STYLE
    allow_text: bool = False
    aspect_note: str = ""  # 展示比例与生成比例不一致时的裁切说明
    safe_areas: tuple[str, ...] = ()
    composition: str = ""
    subject_kind: str = ""  # 提示 LLM 该往哪个方向想
    extra_avoid: tuple[str, ...] = ()
    # 主体取数：(session, subject_id) -> dict，由各域在 image_targets 里注册
    loader: Callable | None = field(default=None, compare=False)
    applier: Callable | None = field(default=None, compare=False)

    def resolved_style(self, style_key: str | None) -> StylePreset:
        """把「没选」「明确不要」「选了某个」三件事分开。

        - `None` 或空串 = **没选**，用这个用途调好的 `default_style`
        - `"none"`（`NO_STYLE_KEY`）= **明确不要画风**，拿到 `NO_STYLE`，不注入任何风格词
        - 其它 = 查表，查不到抛 `PromptError`

        前两者以前是同一条路：空串被 `or` 吞掉回落默认，于是「不要画风」根本无法表达。
        """
        key = (style_key or "").strip() or self.default_style
        preset = STYLE_PRESETS.get(key)
        if preset is None:
            raise PromptError(f"未知风格预设：{key}")
        return preset


# 卡片封面：`.deck-cover` 高度锁死 92px，网格是 minmax(196px, 1fr)，
# 于是实际显示比例在 2.1:1 到 2.8:1 之间浮动（web/src/features/vocab/deck.css:92）。
# 取 1536x608（2.53:1）落在区间中段，两端裁切都最少。
DECK_COVER_SIZE = "1536x608"

TARGETS: dict[str, ImageTarget] = {
    "deck_cover": ImageTarget(
        key="deck_cover",
        label="单词本封面",
        goal="a wide banner illustration used as the cover strip of a vocabulary "
        "deck card in a language-learning app",
        size=DECK_COVER_SIZE,
        sizes=(DECK_COVER_SIZE, "1536x512", "1024x416"),
        aspect_note="卡片实际显示 2.1:1~2.8:1，按 cover 裁切，重要内容留在中间 80%",
        safe_areas=(
            "keep the top-left corner calm and free of important detail "
            "(status badges are overlaid there)",
            "keep the bottom-right corner calm and free of important detail "
            "(a progress ring is overlaid there)",
        ),
        composition="single focal object slightly left of centre, wide empty space "
        "on the right, horizon low, nothing important within 8% of any edge",
        subject_kind="the one object or small arrangement of objects that instantly "
        "says which real-life situation this deck is about",
    ),
    "exam_deck_cover": ImageTarget(
        key="exam_deck_cover",
        label="考纲本封面",
        goal="a wide banner illustration used as the cover strip of an exam "
        "vocabulary deck card in a language-learning app",
        size=DECK_COVER_SIZE,
        sizes=(DECK_COVER_SIZE, "1536x512", "1024x416"),
        aspect_note="卡片实际显示 2.1:1~2.8:1，按 cover 裁切，重要内容留在中间 80%",
        safe_areas=(
            "keep the top-left corner calm and free of important detail "
            "(status badges are overlaid there)",
            "keep the bottom-right corner calm and free of important detail "
            "(a progress ring is overlaid there)",
        ),
        composition="a small arrangement of two or three concrete objects slightly "
        "left of centre, wide empty space on the right, horizon low, "
        "nothing important within 8% of any edge",
        # 考纲本没有「真实生活场景」——中考、GRE 都不是一个地点。
        # 沿用 deck_cover 的 subject_kind（「说明这本讲哪个真实场景」）时，
        # 模型对八本一律回答「书桌 + 单词卡 + 台灯」，八张封面长得一模一样，
        # keywords 全被无视。这里改问「这本装的是哪几类词」，让主体从场景名长出来。
        subject_kind="two or three concrete everyday objects drawn from the deck's "
        "dominant word groups (given in subject.keywords) — the objects must let a "
        "learner tell this deck apart from every other exam deck at a glance; "
        "translate the abstract groups into things you can actually draw",
        extra_avoid=(
            "study desks, notebooks, flashcards, pencils, mugs, desk lamps, "
            "eyeglasses, stacks of textbooks or any other generic exam-prep imagery",
            "classrooms, libraries, graduation caps, diplomas, clocks, checklists",
        ),
    ),
    "book_cover": ImageTarget(
        key="book_cover",
        label="书籍封面",
        goal="a portrait book cover illustration for a reader's bookshelf",
        size="1024x1536",
        sizes=("1024x1536", "832x1248"),
        quality="high",
        aspect_note="书架按 2:3 展示，生成尺寸即展示尺寸，不裁切",
        composition="centred symmetrical composition, clear silhouette, "
        "reads well at 150px wide",
        subject_kind="a single emblematic image for the book's theme — an object, "
        "a landscape or a symbolic motif, never a portrait of a real person",
    ),
    "talk_scene": ImageTarget(
        key="talk_scene",
        label="对话场景卡",
        goal="a scene illustration for a spoken-English roleplay scenario card",
        size="1024x576",
        sizes=("1024x576", "1536x864"),
        composition="establishing shot of the place where the conversation happens, "
        "wide angle, people implied but faces never in focus",
        subject_kind="the physical setting where this conversation would take place",
        extra_avoid=("close-up human faces",),
    ),
    "passage_illustration": ImageTarget(
        key="passage_illustration",
        label="场景短文配图",
        goal="an illustration accompanying a short reading passage",
        size="1024x576",
        sizes=("1024x576", "1024x1024"),
        composition="a single moment from the passage, calm and uncluttered",
        subject_kind="one concrete moment or object from the passage's storyline",
    ),
    "word_mnemonic": ImageTarget(
        key="word_mnemonic",
        label="单词助记图",
        goal="a small square mnemonic picture that makes one English word stick",
        size="1024x1024",
        sizes=("1024x1024", "768x768"),
        quality="low",
        composition="one exaggerated, slightly absurd image that literally acts out "
        "the word's meaning, centred, plain background",
        subject_kind="a visual pun or exaggerated literal scene for the word's meaning",
    ),
    "free": ImageTarget(
        key="free",
        label="自由出图",
        goal="a standalone image",
        size="1024x1024",
        sizes=("1024x1024", "1536x1024", "1024x1536", "1536x608"),
        allow_text=True,
        composition="",
        subject_kind="whatever the user described",
        # 通用出图不预设画风：这里过去继承 dataclass 默认的 soft-flat，
        # 于是「随便画一张」也被套上给单词卡调的插画风（用户反馈的那个 bug）
        default_style=NO_STYLE_KEY,
    ),
}


def get_target(key: str) -> ImageTarget:
    target = TARGETS.get(key)
    if target is None:
        raise PromptError(f"未知生图用途：{key}")
    return target


def register_target(target: ImageTarget) -> None:
    """新域接生图只需注册一条，提示词层与工作台零改动。"""
    TARGETS[target.key] = target


# ---- 第一步：让 LLM 把主体想具体 ----

_BRIEF_HEAD = """你是插画指导，把一个学习场景翻译成「可以画出来的东西」。

只输出 JSON 对象，全部字段用**英文**（提示词要喂给图像模型），字段：
- focal: 画面主体，一句话，必须是具体可见的物体或小场景，不能是抽象概念。
  反例 "learning English"（画不出来）；正例 "a cafe counter with an espresso
  machine and a pastry case"。
- supporting: 2-4 个陪衬元素的数组，每项一个具体名词短语，用来把场景坐实。
- setting: 环境与视角，一句话。
- mood: 三到五个形容词，描述情绪与温度。
- palette: 一句话描述配色倾向，要贴合场景本身（咖啡馆偏暖棕，医院偏冷白）。
- avoid: 这个主题下特别要避开的东西的数组，可以为空数组。"""

# 「不指定比例」时插进字段列表里的那一条。
#
# 必须插在字段列表**中间**、硬要求**之前**：追加在最后面时实测模型一律回空串
# （三个意图全部答 ""，包括「手机整屏 UI」这种画幅再明显不过的），
# 因为它读起来像是正文讲完之后的补充说明。也不给「拿不准填空」的出口——
# 有出口它就一定走出口。
_BRIEF_ASPECT_FIELD = """
- aspect: **必填**。从 `aspect_choices` 里原样挑一个 key（照抄，不要自己造
  "16:9 " 之类的变体）。挑法按优先级：
  1. **用户原话里说了画幅就照他说的**——「竖版 / 竖屏 / 手机屏」一律选 9:16 或 2:3，
     「横版 / 横屏 / 宽幅 / 横图」一律选 16:9 或 3:2，「方形 / 正方」选 1:1。
     这一条压过下面所有判断，不要自作主张改成你觉得更好看的。
  2. 用户没说时按画面本身选：手机整屏界面选 9:16，横幅与场景配图选 16:9，
     头像与单个物件选 1:1，书封与竖版海报选 2:3。
  3. 2.5:1 是给卡片顶部那条窄横幅专用的极端画幅，**除非用户明说要窄长横条，
     否则不要选它**。
  想不出来也要选一个最接近的，不许留空。"""

_BRIEF_TAIL = """

硬要求：
- 只描述**看得见的**东西，不要写风格、画法、光照参数——那些由平台统一控制。
- 不要出现任何文字、招牌字、标签字的描述。
- 不要写人物的脸部特写；需要人时只写背影、手部或远景剪影。"""

BRIEF_SYSTEM = _BRIEF_HEAD + _BRIEF_TAIL
BRIEF_SYSTEM_WITH_ASPECT = _BRIEF_HEAD + _BRIEF_ASPECT_FIELD + _BRIEF_TAIL


def build_brief_prompt(
    target: ImageTarget,
    subject: dict,
    idea: str = "",
    *,
    aspects: list[dict] | None = None,
) -> tuple[str, str]:
    """(system, user)：把主体信息交给 LLM 想成具体画面。

    `aspects` 非空时额外让它挑画幅（用户选了「不指定比例」的情况）。
    候选清单由调用方给：比例目录住在 `image_sizes`，而那个模块反过来 import 本模块，
    这里再 import 回去就成环了。
    """
    payload = {
        "purpose": target.goal,
        "what_to_depict": target.subject_kind,
        "subject": {k: v for k, v in subject.items() if v not in (None, "", [], {})},
    }
    if idea:
        payload["user_note"] = idea
    if aspects:
        payload["aspect_choices"] = aspects
        return BRIEF_SYSTEM_WITH_ASPECT, json.dumps(payload, ensure_ascii=False)
    return BRIEF_SYSTEM, json.dumps(payload, ensure_ascii=False)


def clean_brief(raw: object) -> dict:
    """收敛模型输出，缺字段用空值兜住——brief 不完整也要能渲染出可用提示词。"""
    src = raw if isinstance(raw, dict) else {}

    def text(key: str) -> str:
        """取文本字段。

        模型经常把 mood / palette 这类字段答成数组（实测「咖啡馆点单」那次的 mood
        就是 `["warm","busy",...]`）。直接 str() 会把 Python 字面量原样漏进提示词，
        图像模型看到的就是一串带方括号和引号的噪声。这里统一拍平成逗号分隔。
        """
        value = src.get(key)
        if isinstance(value, list | tuple):
            value = ", ".join(str(v).strip() for v in value if str(v).strip())
        return " ".join(str(value or "").split())[:400]

    def items(key: str, limit: int) -> list[str]:
        value = src.get(key)
        if not isinstance(value, list):
            return []
        out = [" ".join(str(v).split())[:120] for v in value if str(v).strip()]
        return out[:limit]

    return {
        "focal": text("focal"),
        "supporting": items("supporting", 4),
        "setting": text("setting"),
        "mood": text("mood"),
        "palette": text("palette"),
        "avoid": items("avoid", 6),
        # 只做形态收敛，**不校验是不是真的存在这个比例**——比例目录在 image_sizes，
        # 由调用方核对，查不到就当没选
        "aspect": text("aspect")[:16],
    }


# ---- 第二步：拼成最终提示词 ----


def build_structure(
    target: ImageTarget,
    style: StylePreset,
    brief: dict,
    *,
    size: str,
    text_content: dict | None = None,
) -> dict:
    """七段式提示词结构。返回 dict 便于落库与前端展示，发送前再拍平成字符串。

    画幅「自动」时 `layout.canvas` 整条不写：那一条正是决定出图比例的东西
    （实测上游看提示词里的比例、不看 size 参数），写一个占位值等于替用户定了比例。
    """
    canvas = "" if is_auto_size(size) else _canvas_line(size)
    avoid = list(GLOBAL_AVOID) if not target.allow_text else list(GLOBAL_AVOID[1:])
    avoid.extend(style.extra_avoid)
    avoid.extend(target.extra_avoid)
    avoid.extend(brief.get("avoid") or [])

    # 逐键过滤空值：末尾那个推导式只看顶层，够不着嵌在 style 里的空字符串。
    # 选了「不指定画风」时五个字段全空，整段就不进结构——留一串空字段比不写更糟，
    # 模型对空字段的解读并不稳定。
    # 立意（brief）自带配色时 style 只剩 palette，这是对的：用户没指定画风，但立意给了配色。
    style_section = {
        key: value
        for key, value in (
            ("render", style.render),
            ("palette", brief.get("palette") or style.palette),
            ("palette_discipline", style.palette),
            ("lighting", style.lighting),
            ("texture", style.texture),
        )
        if value
    }

    structure: dict = {
        "type": target.label,
        "goal": target.goal,
        "subject": {
            "focal": brief.get("focal") or target.subject_kind,
            "supporting": brief.get("supporting") or [],
        },
        "scene": {
            "setting": brief.get("setting") or "",
            "mood": brief.get("mood") or "",
        },
        "layout": {
            "canvas": canvas,
            "composition": target.composition,
            "safe_areas": list(target.safe_areas),
        },
        "style": style_section,
        "constraints": {
            "must_keep": [
                "one unmistakable focal subject",
                "reads correctly when scaled down to thumbnail size",
                "consistent with the stated render style",
            ],
            "avoid": _dedupe(avoid),
        },
    }
    if target.allow_text and text_content:
        structure["text"] = {
            **text_content,
            "rule": "render these strings verbatim, exact spelling, no extra words",
        }
        structure["constraints"]["must_keep"].append(
            "every supplied string spelled exactly as given"
        )
    return {k: v for k, v in structure.items() if v not in ("", [], {})}


def _dedupe(items: list[str]) -> list[str]:
    seen: set[str] = set()
    out: list[str] = []
    for item in items:
        key = item.strip().lower()
        if key and key not in seen:
            seen.add(key)
            out.append(item.strip())
    return out


def flatten(structure: dict) -> str:
    """结构 → 发给模型的字符串。

    保留 JSON 形态而不是拼成散文：gpt-image-2 对结构化输入的服从度明显更高，
    而且散文化之后 constraints 那一段的否定句很容易被当成正向描述画进去。
    """
    return json.dumps(structure, ensure_ascii=False, indent=2)


def render_prompt(
    target: ImageTarget,
    brief: dict,
    *,
    style_key: str | None = None,
    size: str | None = None,
    text_content: dict | None = None,
) -> tuple[str, dict]:
    """(最终提示词字符串, 结构体)。结构体一并落库，便于在工作台里改字段重出。"""
    style = target.resolved_style(style_key)
    resolved_size = validate_size(size or target.size)
    structure = build_structure(
        target, style, brief, size=resolved_size, text_content=text_content
    )
    return flatten(structure), structure


def ensure_canvas(prompt: str, size: str) -> str:
    """给提示词补上画布比例，除非它已经写了。

    实测（gpt 中转 + gpt-image-2，2026-08-20）：**`size` 这个 API 参数不决定出图
    比例，提示词里写的画布才决定。** 同样请求 1536x608——

    - 自动生成的提示词带 `layout.canvas: "1536x608 (2.53:1)"` → 回 1994x789（2.527:1）✓
    - 手写的提示词没写画布 → 回 1536x1024（1.500:1）✗

    上游只把 size 当参考、按自己的档位取整（1024 也被放大成 1254）。所以用户在
    节点里手写提示词时，封面会静默变成错误比例——这一层就是防这个的。
    """
    # 画幅「自动」= 明确不给画布约束，让模型按提示词内容自己判断。
    # 这里补一句就等于把「自动」变成了某个具体比例——用户选的是自动，
    # 却收到一张按 1536x608 构图的超宽 banner（实测过，见 AUTO_SIZE）。
    if is_auto_size(size):
        return prompt
    # 走 validate_size 而不是 parse_size：非法尺寸在这里就炸掉，
    # 比等到调模型时才报错定位快得多
    w, h = parse_size(validate_size(size))
    ratio = w / h
    if "aspect" in prompt.lower() or "canvas" in prompt.lower():
        return prompt
    return (
        f"{prompt}\n\n"
        f"Canvas: {w}x{h}, aspect ratio {ratio:.2f}:1. "
        f"Compose for this exact shape."
    )


def preset_view() -> list[dict]:
    """全部可选画风，**含 `none`**。

    与 `style_category_view()` 故意不对称：前端要按 key 反查名字（任务详情、资产详情
    里显示的是画风名而不是裸键），这份列表漏掉 `none` 就只能显示 "none"。前端把它
    渲染成置顶的特殊卡片，不跟着分类走。
    """
    order = list(STYLE_CATEGORIES)
    presets = sorted(
        STYLE_PRESETS.values(),
        key=lambda p: (order.index(p.category) if p.category in order else 99, p.label),
    )
    return [
        {
            "key": p.key,
            "label": p.label,
            "hint": p.hint,
            "builtin": p.builtin,
            "category": p.category,
            "render": p.render,
            "avoid": list(p.extra_avoid),
            "tags": list(p.tags),
            "source": p.source,
        }
        for p in presets
    ]


def style_category_view() -> list[dict]:
    """分类页签，**排除 `none`**。

    它永远只有一项，做成页签就是一个点进去只有一张卡的空壳分类；而且它压根不是
    一种画风，和「摄影」「绘画」并排会误导。`preset_view()` 则必须留着它——那份是
    key→名字的反查表，两处的取舍不一样。
    """
    counts: dict[str, int] = {}
    for preset in STYLE_PRESETS.values():
        counts[preset.category] = counts.get(preset.category, 0) + 1
    return [
        {"key": key, "label": label, "count": counts.get(key, 0)}
        for key, label in STYLE_CATEGORIES.items()
        if key != NO_STYLE_CATEGORY and counts.get(key)
    ]


def register_style(preset: StylePreset) -> None:
    """新增风格只需注册一条。用户自定义风格走这条路进来。"""
    STYLE_PRESETS[preset.key] = preset


def drop_style(key: str) -> None:
    STYLE_PRESETS.pop(key, None)


def target_view() -> list[dict]:
    return [
        {
            "key": t.key,
            "label": t.label,
            "size": t.size,
            "sizes": list(t.sizes),
            "quality": t.quality,
            "default_style": t.default_style,
            "allow_text": t.allow_text,
            "aspect_note": t.aspect_note,
            "applies": t.applier is not None,
        }
        for t in TARGETS.values()
    ]
