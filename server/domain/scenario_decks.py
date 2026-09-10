"""AI 场景本生成流水线（需求 01 v2 §6，FR-167 ~ FR-177）。

LLM 只负责判断"这个词属不属于这个场景"，本地 340 万条 ECDICT 负责判断
"这个词是否真实存在、难度如何"，两层都过了才进草稿，用户确认后才落正式本。
学术界同款做法：候选生成 → 难度词表过滤 → 数量不足再生成一轮。
"""

import json
import logging
import re
from collections.abc import Awaitable, Callable

from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from domain import artifacts, image_defaults
from domain.dict_forms import lemma_guesses
from domain.llm import complete_json
from domain.models import DictEntry, Wordlist, WordlistItem
from domain.passages import FORM_LABEL, coverable_words, generate_passage, persist_passage
from domain.pipeline import (
    DomainAction,
    HealthBucket,
    HelpSection,
    PipelineDef,
    StepSpec,
    SubjectColumn,
    Tunable,
    register_pipeline,
)

ALIAS = "explain-standard"
DOMAIN = "scenario_deck"

logger = logging.getLogger(__name__)

# 单词组要过词典校验；短语与句型天然不在词典里，不参与剔除（BR-30 的适用边界）
WORD_GROUPS = ("core_noun", "action", "descriptor")
PHRASE_GROUPS = ("phrase", "pattern")
ALL_GROUPS = WORD_GROUPS + PHRASE_GROUPS

LEVELS = ("A1", "A2", "B1", "B2", "C1", "C2")
KEY_RE = re.compile(r"^[a-z][a-z0-9_]{1,63}$")

# 目标词数与重试阈值：低于下限才回到候选生成，最多两轮（FR-170）
TARGET_WORDS = 70
MIN_WORDS = 55
MAX_ROUNDS = 3

# 词频离群上界：超过此位次的词在任何场景下都属于生僻，标记但不剔除
FRQ_OUTLIER = 60000

STAGES: dict[str, str] = {
    "normalize": "场景归一化",
    "generate": "候选词生成",
    "verify": "词典校验",
    "refill": "补齐词量",
    "examples": "场景例句",
    "persist": "写入草稿",
    "confirm": "人工确认",
    "done": "完成",
}

# 场景本管线定义（需求 12 FR-209）：原先只是 Redis 里的进度字符串，
# 现在升格为与视频管线同构的节点，可在拓扑图上查看、单独重跑、看产物。
SCENARIO_STEPS: tuple[StepSpec, ...] = (
    StepSpec(
        name="normalize", label="场景归一化", group="ingest",
        tunables=(Tunable("alias", "LLM 别名", "text", ALIAS),),
        note="把你输入的一句话变成规范的场景定义：中英文名称、emoji、所属分类、"
             "难度等级和几个关键词。后面所有步骤都以这份定义为准。",
        rerun_hint="重新理解你的描述，场景名与难度可能变化",
        progress_span=(0, 10), deterministic=False, artifact_kind="json",
    ),
    StepSpec(
        name="generate", label="候选词生成", group="ingest", depends_on=("normalize",),
        tunables=(
            Tunable("alias", "LLM 别名", "text", ALIAS),
            Tunable("want_total", "目标词数", "number", TARGET_WORDS),
        ),
        note="让 AI 按五组挑出这个场景真正用得上的词：核心名词、常用动作、描述词、"
             "高频短语、可直接说出口的句型。分组本身就是场景本比考纲词表好用的地方。",
        rerun_hint="会得到一批全新的词，之前删掉的可能重新出现",
        progress_span=(10, 40), deterministic=False, single_ok=True,
    ),
    StepSpec(
        name="verify", label="词典校验", group="check", depends_on=("generate",),
        note="拿每个单词去本地 340 万条词典核对：查得到的补上音标、释义、词频与考纲标签；"
             "查不到的剔除，因为 AI 偶尔会造出不存在的词。短语和句型不参与核对——"
             "它们本来就不是词典条目。",
        rerun_hint="纯本地比对，不消耗 AI 额度，几毫秒就跑完",
        progress_span=(40, 55), single_ok=True,
    ),
    StepSpec(
        name="refill", label="补齐词量", group="ingest", depends_on=("verify",),
        tunables=(Tunable("min_words", "词量下限", "number", MIN_WORDS),),
        note="词数不够时再让 AI 补一批，只补缺的部分——已有的词会一并告诉 AI 别重复。"
             "最多补两轮，仍然不够就按实际数量入库。",
        skip_when=f"校验后词数已达 {MIN_WORDS} 个就整步跳过（你这次跳过说明词量够了）",
        rerun_hint="会再调一次 AI 补词",
        progress_span=(55, 70), deterministic=False, single_ok=True,
    ),
    StepSpec(
        name="examples", label="场景例句", group="enrich", depends_on=("refill",),
        tunables=(Tunable("enabled", "生成例句", "bool", True),),
        note="给每个词写一句这个场景里的例句，帮你记住它到底怎么用。"
             "例句会显示在单词本详情页的词条卡片上。",
        skip_when="生成时关掉「为每个词生成场景例句」则跳过",
        rerun_hint="重新生成全部例句，消耗一次 AI 调用",
        progress_span=(70, 90), deterministic=False, single_ok=True,
    ),
    StepSpec(
        name="persist", label="写入草稿", group="ingest", depends_on=("examples",),
        note="把整理好的词表存下来。注意这一步只是存，本还没有进书架，"
             "也不会出现在复习队列里。",
        rerun_hint="只是重新存一遍，不调用 AI",
        progress_span=(88, 92), artifact_kind="none",
    ),
    StepSpec(
        name="cover", label="封面配图", group="enrich", depends_on=("persist",),
        tunables=(
            Tunable("enabled", "生成封面", "bool", True),
            Tunable("prompt", "提示词", "textarea", "",
                    hint="留空 = 按场景自动写。不满意就把想要的画面写在这儿再重跑"),
            Tunable("style", "风格", "select", "soft-flat",
                    ("soft-flat", "warm-gouache", "clean-isometric",
                     "airy-photo", "abstract-texture"),
                    option_labels=("柔和扁平插画", "暖调水粉", "清爽等距",
                                   "通透摄影", "抽象底纹")),
            Tunable(
                "quality", "质量", "select",
                image_defaults.FALLBACK_QUALITY, image_defaults.QUALITIES,
                hint="全局默认已提到高档（CR-005）；这里可以单独调低省时间",
                option_labels=("低（草稿）", "中", "高（默认）"),
            ),
            Tunable("n", "张数", "number", 1, hint="按张计费；先出一张，不满意重跑这一步"),
        ),
        note="给这个本画一张封面。AI 先把场景想成具体可画的东西（「咖啡馆点单」→ "
             "吧台 + 咖啡机 + 糕点柜），再套统一画风出图。生成前后卡片都能用，"
             "没有封面时仍是原来的 emoji + 渐变。",
        skip_when="关掉「生成封面」或没绑生图能力时跳过",
        rerun_hint="重新画一张，词表与短文都不受影响",
        progress_span=(92, 95), deterministic=False, single_ok=True,
    ),
    StepSpec(
        name="passage", label="场景短文", group="enrich", depends_on=("cover",),
        tunables=(Tunable("enabled", "生成短文", "bool", True),),
        note="把本内的词织进一篇真实语境：有角色互动的场景写成对话，"
             "描述性场景写成短文。生成后可以像读书架文章一样逐句点读、点词查义。",
        skip_when="生成时关掉「场景短文」则跳过",
        rerun_hint="重写一篇新的短文，词表本身不受影响",
        progress_span=(95, 98), deterministic=False, single_ok=True,
    ),
    StepSpec(
        name="confirm", label="人工确认", group="check", depends_on=("passage",),
        tunables=(
            Tunable("need_confirm", "生成后由我确认", "bool", False,
                    hint="默认生成完直接入库；打开后停在这一步等你过目删词"),
        ),
        note="默认关着，生成完直接进书架和复习队列。打开「生成后由我确认」之后会停在"
             "这一步等你过目，可以勾掉不想要的词再入库。",
        skip_when="没开启「生成后由我确认」时跳过",
        progress_span=(95, 100), pause_after="on_demand", artifact_kind="none",
    ),
)

SCENARIO_PIPELINE = PipelineDef(
    domain="scenario_deck",
    label="词库场景本",
    subject_table="wordlist",
    steps=SCENARIO_STEPS,
    columns=(
        SubjectColumn("title", "场景本", "text"),
        SubjectColumn("status", "状态", "status", width=96),
        SubjectColumn("words", "词数", "number", "right", 72),
        SubjectColumn("dict_hit", "词典命中", "ratio", "right", 96),
        SubjectColumn("cefr", "CEFR", "text", "left", 64),
        SubjectColumn("last_run", "最近运行", "run", "left", 120),
    ),
    health=(
        HealthBucket("ready", "已入库", "ok"),
        HealthBucket("draft", "待确认", "accent", actionable=True),
        HealthBucket("failed", "生成失败", "err", actionable=True),
        HealthBucket("processing", "生成中", "accent"),
    ),
    actions=(
        DomainAction("seed_all", "批量生成种子场景", "primary"),
        DomainAction(
            "purge_drafts", "清理过期草稿", "normal",
            confirm="将删除 24 小时前未确认的草稿",
        ),
    ),
    run_kinds=(("generate", "生成"), ("rerun", "重跑")),
    detail_route="/pipeline/scenario_deck/{id}",
    empty_hint="还没有场景本，去「词库」用一句话生成第一个",
    help=(
        HelpSection(
            "这条管线在做什么",
            "把你的一句话（比如「我想学会在星巴克点咖啡」）变成一本可以直接背的词表，"
            "外加一篇把这些词全用上的短文。每一步的产出都能点开查看。",
        ),
        HelpSection(
            "七步分别在干什么",
            bullets=(
                "场景归一化：把你的话整理成规范的场景定义",
                "候选词生成：AI 按五组挑出这个场景用得上的词",
                "词典校验：拿本地词典核对，剔掉 AI 编造的词",
                "补齐词量：词不够时再补一批，够了就跳过",
                "场景例句：给每个词写一句这个场景里的例句",
                "写入草稿：存下来，此时还没进书架",
                "封面配图：给这个本画一张封面，提示词可以自己改后重跑",
                "场景短文：把这些词织进一篇对话或短文，可以像读文章一样学",
                "人工确认：默认跳过直接入库，开了开关才停下等你过目",
            ),
        ),
        HelpSection(
            "AI 生成的词靠谱吗",
            "三层把关：AI 只负责判断「这个词属不属于这个场景」，"
            "本地 340 万条词典负责判断「这个词是否真实存在」，"
            "你自己做最终确认。任何一层都不单独决定入库内容。",
        ),
        HelpSection(
            "为什么有的节点是灰的",
            "灰色表示这一步本次没有执行——可能是不需要（比如词量够了不用补齐），"
            "也可能是重跑时不在范围内直接复用了上次的产物。点开节点能看到具体原因。",
        ),
        HelpSection(
            "重跑的两种范围",
            bullets=(
                "这一步及后面全部：改了这一步的结果，后面的必须跟着重来（最常用）",
                "只重算这一步：后面的沿用旧产物，适合只想看看换个结果什么样",
                "范围外且已有产物的节点会直接复用，不重算也不重新消耗 AI 额度",
            ),
        ),
        HelpSection(
            "不满意怎么办",
            "候选词不满意就重跑「候选词生成」；例句不满意就只重跑「场景例句」，"
            "前面几步的结果会原样复用，不用从头再来一遍。",
        ),
    ),
)

register_pipeline(SCENARIO_PIPELINE)

ProgressFn = Callable[[dict], Awaitable[None]]


class GenerateFailed(Exception):
    """流水线可预期的失败：模型输出不合规、词量补不够等。"""


async def _noop(_: dict) -> None:
    return None


# ---- ① 场景归一化 ----


def _normalize_prompt(idea: str, level: str | None) -> tuple[str, str]:
    system = (
        "你是英语学习场景设计师，把用户的一句话想法整理成规范的场景定义。"
        "只输出 JSON 对象，字段："
        "key（英文标识，小写字母开头，仅含小写字母/数字/下划线，如 coffee_order）、"
        "title_zh（中文场景名，4-10 字）、title_en（英文场景名）、"
        "emoji（一个最能代表该场景的 emoji）、"
        "category（八选一：日常生活/出行旅游/社交人际/职场商务/学术教育/健康医疗/科技编程/兴趣娱乐）、"
        "cefr（A1/A2/B1/B2/C1/C2 之一，用户指定时必须采用）、"
        "description（一句话说明这个场景学完能做什么，中文，不超过 30 字）、"
        "keywords（3-6 个英文关键词数组，描述该场景的核心概念）。"
    )
    return system, json.dumps({"idea": idea, "level": level}, ensure_ascii=False)


def _clean_scene(raw: dict, level: str | None) -> dict:
    key = re.sub(r"[^a-z0-9_]+", "_", str(raw.get("key") or "").strip().lower()).strip("_")
    if key and not key[0].isalpha():
        key = f"s_{key}"
    cefr = str(raw.get("cefr") or "").strip().upper()
    if level:
        cefr = level.upper()
    if cefr not in LEVELS:
        cefr = "B1"
    emoji = str(raw.get("emoji") or "").strip()
    keywords = raw.get("keywords")
    return {
        "key": key,
        "title_zh": str(raw.get("title_zh") or "").strip(),
        "title_en": str(raw.get("title_en") or "").strip(),
        # emoji 可能被模型输出成多字符组合，截断到两个码点避免撑破封面
        "emoji": emoji[:2] if emoji else "📘",
        "category": str(raw.get("category") or "").strip() or None,
        "cefr": cefr,
        "description": str(raw.get("description") or "").strip() or None,
        "keywords": [str(k).strip() for k in keywords if str(k).strip()]
        if isinstance(keywords, list)
        else [],
    }


async def normalize_scene(idea: str, level: str | None = None) -> dict:
    system, user = _normalize_prompt(idea, level)
    raw, _model, _ms = await complete_json(ALIAS, system, user)
    scene = _clean_scene(raw if isinstance(raw, dict) else {}, level)
    if not scene["key"] or not KEY_RE.match(scene["key"]) or not scene["title_zh"]:
        raise GenerateFailed("模型没能给出规范的场景定义，请换个说法再试")
    return scene


# ---- ② 候选词生成 ----


def _candidate_prompt(scene: dict, exclude: list[str], want: int) -> tuple[str, str]:
    system = (
        "你是英语教材编者，为指定场景挑选学习者真正用得上的词汇。"
        "只输出 JSON 对象，五个字段各是一个数组："
        "core_noun（场景里的核心名词）、action（常用动词）、descriptor（形容词与副词）、"
        "phrase（高频固定搭配或短语）、pattern（可直接说出口的句型）。"
        "数组每项是 {en, zh}：en 是英文（单词组用词典原形小写，短语与句型保持自然形态），"
        "zh 是它在该场景下的中文意思。"
        "只收录该场景真实会用到的表达，不要为凑数塞入通用词；"
        "已有词列表中的词不要重复给出。"
    )
    user = json.dumps(
        {
            "scene": {
                "title": scene["title_en"] or scene["title_zh"],
                "description": scene.get("description"),
                "keywords": scene.get("keywords", []),
                "cefr": scene["cefr"],
            },
            "want_total": want,
            "exclude": exclude,
        },
        ensure_ascii=False,
    )
    return system, user


def _clean_candidates(raw: dict) -> dict[str, list[dict]]:
    out: dict[str, list[dict]] = {g: [] for g in ALL_GROUPS}
    if not isinstance(raw, dict):
        return out
    for group in ALL_GROUPS:
        items = raw.get(group)
        if not isinstance(items, list):
            continue
        for item in items:
            if not isinstance(item, dict):
                continue
            en = str(item.get("en") or "").strip()
            zh = str(item.get("zh") or "").strip()
            if not en or not zh:
                continue
            # 单词组统一小写；短语与句型规范首字母，模型常把整句压成小写
            if group in WORD_GROUPS:
                en = en.lower()
                if not re.fullmatch(r"[a-z][a-z\-']*", en):
                    continue
            else:
                if len(en) > 120:  # word 列 128 字符，超长句型直接丢弃而非截断成半句
                    continue
                if group == "pattern" and en[:1].islower():
                    en = en[0].upper() + en[1:]
            out[group].append({"en": en, "zh": zh})
    return out


async def generate_candidates(scene: dict, exclude: list[str], want: int) -> dict[str, list[dict]]:
    system, user = _candidate_prompt(scene, exclude, want)
    raw, _model, _ms = await complete_json(ALIAS, system, user)
    return _clean_candidates(raw)


# ---- ③ 词典校验与富化 ----

async def verify_against_dict(
    session: AsyncSession, candidates: dict[str, list[dict]]
) -> tuple[list[dict], list[dict]]:
    """单词组查 ECDICT 定去留，短语组直接放行。

    返回 (保留词条, 被剔除的词条)。命中的词带上音标、词频、考纲标签，
    未命中的先做屈折回退再查一次，仍不中才判为词典外（BR-30）。
    """
    wanted: set[str] = set()
    for group in WORD_GROUPS:
        for item in candidates[group]:
            wanted.add(item["en"])
            wanted.update(lemma_guesses(item["en"]))
    hits: dict[str, DictEntry] = {}
    if wanted:
        rows = (
            await session.execute(select(DictEntry).where(DictEntry.word.in_(wanted)))
        ).scalars()
        hits = {row.word: row for row in rows}

    kept: list[dict] = []
    dropped: list[dict] = []
    for group in ALL_GROUPS:
        for item in candidates[group]:
            en = item["en"]
            if group in PHRASE_GROUPS:
                # 短语与句型不过词典校验：它们本就不是词典条目，标 dict_miss 会变成假警报
                kept.append({**item, "group": group, "dict_miss": False, "frq": None})
                continue
            entry = hits.get(en)
            resolved = en
            if entry is None:
                for guess in lemma_guesses(en):
                    if guess in hits:
                        entry, resolved = hits[guess], guess
                        break
            if entry is None:
                dropped.append({**item, "group": group, "reason": "词典未收录"})
                continue
            kept.append(
                {
                    "en": resolved,
                    "zh": item["zh"],
                    "group": group,
                    "dict_miss": False,
                    "frq": entry.frq or None,
                    "phonetic": entry.phonetic,
                    "tags": entry.tag.split() if entry.tag else [],
                    # 词频离群只标记不剔除：专业场景的低频词（middleware）是刚需
                    "beyond_level": bool(entry.frq and entry.frq > FRQ_OUTLIER),
                }
            )
    return kept, dropped


# ---- ⑤ 场景例句 ----


async def generate_examples(scene: dict, words: list[dict]) -> dict[str, dict]:
    """整批一次调用产出例句，按词回填；失败不阻断流水线，例句可为空。"""
    system = (
        "你是英语教师，为给定场景中的每个表达写一句该场景下的自然例句。"
        "只输出 JSON 对象，字段 examples 是数组，每项 {en, sentence, zh}："
        "en 与输入词条完全一致，sentence 是英文例句（不超过 16 词），zh 是中文翻译。"
        "例句必须发生在该场景内，能体现这个词的典型用法。"
    )
    user = json.dumps(
        {
            "scene": {"title": scene["title_en"] or scene["title_zh"], "cefr": scene["cefr"]},
            "words": [w["en"] for w in words],
        },
        ensure_ascii=False,
    )
    try:
        raw, _model, _ms = await complete_json(ALIAS, system, user)
    except Exception:
        return {}
    examples = raw.get("examples") if isinstance(raw, dict) else None
    if not isinstance(examples, list):
        return {}
    out: dict[str, dict] = {}
    for item in examples:
        if not isinstance(item, dict):
            continue
        en = str(item.get("en") or "").strip()
        sentence = str(item.get("sentence") or "").strip()
        if not en or not sentence:
            continue
        out[en] = {"en": sentence, "zh": str(item.get("zh") or "").strip() or None}
    return out


# ---- ⑥ 落库草稿 ----


def _color_seed(key: str) -> int:
    seed = 0
    for ch in key:
        seed = (seed * 31 + ord(ch)) % 360
    return seed


async def create_shell(session: AsyncSession, idea: str) -> int:
    """先建空草稿作为管线主体（需求 12 §7.2）。

    场景本的 subject 是 wordlist.id，而内容要到 persist 节点才产出——
    先建空壳，run 从第一个节点起就有主体可挂，拓扑图与重跑才定位得到。
    """
    wordlist = Wordlist(
        name=idea[:60] or "生成中",
        kind="scenario",
        emoji="✨",
        color_seed=_color_seed(idea),
        source="ai",
        status="draft",
    )
    session.add(wordlist)
    await session.flush()
    await session.commit()
    return wordlist.id


async def apply_scene(session: AsyncSession, wordlist_id: int, scene: dict) -> None:
    """归一化产物回填到空壳上，让草稿在生成过程中就有正确的名字与封面。"""
    wordlist = await session.get(Wordlist, wordlist_id)
    if wordlist is None:
        return
    wordlist.name = scene["title_zh"]
    wordlist.emoji = scene["emoji"]
    wordlist.color_seed = _color_seed(scene["key"])
    wordlist.description = scene.get("description")
    wordlist.category = scene.get("category")
    wordlist.cefr = scene["cefr"]
    await session.commit()


async def persist_draft(
    session: AsyncSession,
    scene: dict,
    words: list[dict],
    examples: dict[str, dict],
    wordlist_id: int,
) -> int:
    """把词条写进草稿本；重跑时先清机器产出的旧词条再写，一律不碰人工编辑。"""
    wordlist = await session.get(Wordlist, wordlist_id)
    if wordlist is None:
        raise GenerateFailed("草稿本已不存在")
    # 重跑该节点时清掉上一轮的机器词条；人工加的词（dict_miss 手动保留）不在此列
    await session.execute(
        delete(WordlistItem).where(WordlistItem.wordlist_id == wordlist_id)
    )
    seen: set[str] = set()
    ordinal = 0
    for word in words:
        en = word["en"]
        if en in seen:  # 多轮生成可能重复给词，唯一约束在 flush 时才报，先自行去重
            continue
        seen.add(en)
        example = examples.get(en, {})
        session.add(
            WordlistItem(
                wordlist_id=wordlist.id,
                word=en,
                translation=word["zh"],
                ordinal=ordinal,
                group_key=word["group"],
                example_en=example.get("en"),
                example_zh=example.get("zh"),
                dict_miss=word["dict_miss"],
            )
        )
        ordinal += 1
    await session.commit()
    return wordlist.id


# ---- 流水线编排 ----


async def _do_cover(session, handle, recorder, scene: dict, wordlist_id: int) -> dict:
    """封面配图。调用的是 imagegen 服务层，与生图管线同一组函数。

    产物里只放资产 id 与尺寸，图片走 `/api/images/assets/{id}` 发——
    产物列是 JSONB，图片字节塞进去会撑爆库行（BR-101）。
    """
    from domain import image_assets, imagegen
    from domain.models import Wordlist

    subject = {
        "title": scene.get("title_zh"),
        "title_en": scene.get("title_en"),
        "description": scene.get("description"),
        "category": scene.get("category"),
        "cefr": scene.get("cefr"),
        "keywords": scene.get("keywords") or [],
    }
    result = await imagegen.generate_for(
        session,
        target_key="deck_cover",
        subject=subject,
        alias="image-cover",
        prompt_override=str(recorder.cfg("cover", "prompt", "") or ""),
        style_key=str(recorder.cfg("cover", "style", "soft-flat")),
        quality=image_defaults.normalize_quality(
                    recorder.cfg("cover", "quality", None)
                ),
        n=int(recorder.cfg("cover", "n", 1) or 1),
        subject_domain="wordlist",
        subject_id=wordlist_id,
        run_id=recorder.run_id,
        step="cover",
        source="pipeline",
    )
    assets = result["assets"]
    picked = assets[0]
    wordlist = await session.get(Wordlist, wordlist_id)

    # 首次自动采用，之后只做候选（BR-109）。已经有封面还自动覆盖的话，
    # 手滑重跑一次就把满意的那张冲掉了，而模型是非确定性的、原图找不回来
    had_cover = bool(wordlist is not None and wordlist.cover_key)
    applied_id = None
    if wordlist is not None and not had_cover:
        wordlist.cover_key = picked.storage_key
        await image_assets.mark_applied(session, picked, "wordlist", wordlist_id)
        applied_id = picked.id
    else:
        # 候选也要挂上归属，否则资产库里认不出它是给哪个本画的
        for asset in assets:
            asset.subject_domain = asset.subject_domain or "wordlist"
            asset.subject_id = asset.subject_id if asset.subject_id is not None else wordlist_id
    await session.commit()

    handle.measure(
        assets=len(assets), size=picked.size_req, ms=result["latency_ms"],
        model=result.get("model"), applied=applied_id is not None,
    )
    handle.log(
        f"封面已生成并应用，{picked.width}x{picked.height}"
        if applied_id is not None
        else f"已生成 {len(assets)} 张候选，{picked.width}x{picked.height}；"
        "本已有封面，点「设为封面」才替换"
    )
    return {
        "asset_ids": [a.id for a in assets],
        "applied_asset_id": applied_id,
        "size": f"{picked.width}x{picked.height}",
        "prompt": result["prompt"],
        "brief": result.get("brief"),
    }


async def _do_passage(session, handle, scene: dict, words: list[dict], wordlist_id: int) -> dict:
    """生成短文并落成可读文章，产物返回结构供短文页使用。"""
    # 句型组不参与统计：它们是整句，短文本来就是它们的载体
    vocab = coverable_words(words)
    passage = await generate_passage(scene, vocab)
    article_id = await persist_passage(session, wordlist_id, scene["title_zh"], passage)
    await session.commit()
    cov = passage["coverage"]
    handle.measure(
        form=passage["form"],
        paragraphs=len(passage["paragraphs"]),
        covered=len(cov["covered"]),
        missing=len(cov["missing"]),
        coverage=cov["rate"],
        article_id=article_id,
    )
    handle.log(f"{FORM_LABEL[passage['form']]}，覆盖 {len(cov['covered'])}/{len(vocab)} 词")
    return {**passage, "article_id": article_id}


async def _node(
    recorder,
    session: AsyncSession,
    subject_id: int,
    spec: StepSpec,
    config: dict,
    compute,
    *,
    wanted: set[str] | None,
    summary: str | None = None,
):
    """节点执行壳：指纹缓存 → 执行 → 落产物（需求 12 FR-195~197）。

    不在本次重跑范围内、且已有产物的节点直接复用，记 skipped 而不是假装跑过。
    返回 (产物, 是否复用)。
    """
    shas = await artifacts.dep_shas(session, DOMAIN, subject_id, spec.depends_on)
    fingerprint = artifacts.input_fingerprint(spec, dep_shas=shas, config=config)
    reusable = await artifacts.cache_hit(session, DOMAIN, subject_id, spec.name, fingerprint)
    # 用户点名重跑的节点必须真跑：他要的就是"再生成一次"，
    # 此时命中缓存直接跳过等于没响应他的操作（缓存不得覆盖明确意图）
    explicit = wanted is not None and spec.name in wanted
    out_of_scope = wanted is not None and spec.name not in wanted
    if reusable is not None and not explicit and (out_of_scope or spec.cacheable):
        reason = "不在本次重跑范围" if out_of_scope else "输入未变，复用产物"
        await recorder.skip(spec.name, reason)
        return reusable.payload, True

    async with recorder.step(spec.name, config) as handle:
        payload = await compute(handle)
        # 交给 Recorder 在 step 退出时统一落库：这里再写一遍会被它用 metrics 覆盖，
        # 表现为产物 bytes 骤减、summary 丢失（实测踩过）
        if spec.artifact_kind != "none":
            handle.produce(
                payload,
                summary=summary(payload) if callable(summary) else (summary or ""),
            )
    return payload, False


async def build_scenario_deck(
    session: AsyncSession,
    idea: str,
    *,
    wordlist_id: int,
    recorder,
    level: str | None = None,
    with_examples: bool = True,
    scene: dict | None = None,
    wanted: set[str] | None = None,
    with_passage: bool = True,
    on_progress: ProgressFn | None = None,
) -> dict:
    """跑完整条场景本管线，每个节点产物落库、可单独重跑（需求 12 §7.2）。

    on_progress 保留供实时推送，真实进度另落 pipeline_step 供拓扑图读取。
    """
    report = on_progress or _noop
    steps = SCENARIO_PIPELINE.by_name
    counts = {"candidates": 0, "kept": 0, "dropped": 0, "rounds": 0, "examples": 0}

    async def note(stage: str, detail: str) -> None:
        await report({"stage": stage, "detail": detail, "counts": counts, "scene": scene})

    # ① 归一化：种子场景已是规范形态，直接作为产物落库，省一次 LLM 调用
    await note("normalize", "解析场景描述")
    seed_scene = scene

    async def do_normalize(handle):
        result = seed_scene if seed_scene is not None else await normalize_scene(idea, level)
        handle.measure(title=result["title_zh"], cefr=result["cefr"], seeded=seed_scene is not None)
        return result

    scene, _ = await _node(
        recorder, session, wordlist_id, steps["normalize"],
        {"alias": ALIAS, "level": level or ""}, do_normalize,
        wanted=wanted, summary=lambda p: f"{p['emoji']} {p['title_zh']} · {p['cefr']}",
    )
    await apply_scene(session, wordlist_id, scene)

    # ② 候选词生成
    await note("generate", "生成候选词")

    async def do_generate(handle):
        result = await generate_candidates(scene, [], TARGET_WORDS)
        total = sum(len(v) for v in result.values())
        handle.measure(candidates=total, **{k: len(v) for k, v in result.items()})
        return result

    candidates, _ = await _node(
        recorder, session, wordlist_id, steps["generate"],
        {"alias": ALIAS, "want_total": TARGET_WORDS}, do_generate,
        wanted=wanted, summary=lambda p: f"候选 {sum(len(v) for v in p.values())} 词",
    )
    counts["candidates"] = sum(len(v) for v in candidates.values())
    counts["rounds"] = 1

    # ③ 词典校验：纯本地，零 token
    await note("verify", "比对本地词典")

    async def do_verify(handle):
        kept_now, dropped_now = await verify_against_dict(session, candidates)
        handle.measure(kept=len(kept_now), dropped=len(dropped_now))
        return {"kept": kept_now, "dropped": dropped_now}

    verified, _ = await _node(
        recorder, session, wordlist_id, steps["verify"], {}, do_verify,
        wanted=wanted, summary=lambda p: f"命中 {len(p['kept'])} / 剔除 {len(p['dropped'])}",
    )
    kept: list[dict] = list(verified["kept"])
    dropped: list[dict] = list(verified["dropped"])
    counts["kept"], counts["dropped"] = len(kept), len(dropped)

    # ④ 补齐：词量够就整节点跳过，而不是假装跑了一轮
    await note("refill", "检查词量")

    async def do_refill(handle):
        rounds = 0
        pool = list(kept)
        while len(pool) < MIN_WORDS and rounds < MAX_ROUNDS - 1:
            rounds += 1
            extra = await generate_candidates(
                scene, [w["en"] for w in pool], TARGET_WORDS - len(pool)
            )
            more_kept, more_dropped = await verify_against_dict(session, extra)
            existing = {w["en"] for w in pool}
            pool.extend(w for w in more_kept if w["en"] not in existing)
            dropped.extend(more_dropped)
        handle.measure(extra_rounds=rounds, total=len(pool))
        return {"words": pool, "rounds": rounds}

    if len(kept) >= MIN_WORDS:
        await recorder.skip("refill", f"词量 {len(kept)} 已达下限 {MIN_WORDS}")
        words = kept
    else:
        refilled, _ = await _node(
            recorder, session, wordlist_id, steps["refill"],
            {"min_words": MIN_WORDS}, do_refill,
            wanted=wanted, summary=lambda p: f"补齐后 {len(p['words'])} 词",
        )
        words = refilled["words"]
        counts["rounds"] = 1 + int(refilled.get("rounds", 0))
    counts["kept"], counts["dropped"] = len(words), len(dropped)

    if not words:
        raise GenerateFailed("没有生成出任何可用词条，请换个更具体的场景描述")

    # ⑤ 例句
    await note("examples", "生成场景例句")

    async def do_examples(handle):
        result = await generate_examples(scene, words) if with_examples else {}
        handle.measure(examples=len(result))
        return result

    if not with_examples:
        await recorder.skip("examples", "本次未开启例句生成")
        examples: dict[str, dict] = {}
    else:
        examples, _ = await _node(
            recorder, session, wordlist_id, steps["examples"], {"enabled": True}, do_examples,
            wanted=wanted, summary=lambda p: f"{len(p)} 条例句",
        )
    counts["examples"] = len(examples)

    # ⑥ 落草稿
    await note("persist", "写入草稿")
    async with recorder.step("persist", {}) as handle:
        await persist_draft(session, scene, words, examples, wordlist_id)
        handle.measure(words=len(words), examples=len(examples))

    # ⑦ 封面配图：调生图服务层的同一组函数，不是第二份实现（模块 16 FR-414）。
    # 失败不阻断——没有封面仍回落 emoji + 渐变，本本身完全可用（BR-108）
    await note("cover", "生成封面")
    if not recorder.cfg("cover", "enabled", True):
        await recorder.skip("cover", "本次未开启封面生成")
    else:
        try:
            await _node(
                recorder, session, wordlist_id, steps["cover"],
                {
                    "prompt": str(recorder.cfg("cover", "prompt", "") or ""),
                    "style": str(recorder.cfg("cover", "style", "soft-flat")),
                    "quality": image_defaults.normalize_quality(
                        recorder.cfg("cover", "quality", None)
                    ),
                    "n": int(recorder.cfg("cover", "n", 1) or 1),
                },
                lambda h: _do_cover(session, h, recorder, scene, wordlist_id),
                wanted=wanted,
                summary=lambda p: f"{p.get('size', '')} · {len(p.get('asset_ids') or [])} 张",
            )
        except Exception as exc:  # noqa: BLE001
            logger.warning("封面生成失败，词表与短文不受影响：%s", exc)

    # ⑧ 场景短文：把词织进语境。失败不阻断——词表本身已可用（BR-51）
    await note("passage", "生成场景短文")
    if not with_passage:
        await recorder.skip("passage", "本次未开启短文生成")
    else:
        try:
            await _node(
                recorder, session, wordlist_id, steps["passage"], {"enabled": True},
                lambda h: _do_passage(session, h, scene, words, wordlist_id),
                wanted=wanted,
                summary=lambda p: (
                    f"{FORM_LABEL.get(p.get('form', 'prose'), '短文')} · "
                    f"覆盖 {int(p.get('coverage', {}).get('rate', 0) * 100)}%"
                ),
            )
        except Exception as exc:  # noqa: BLE001
            logger.warning("场景短文生成失败，词表不受影响：%s", exc)

    await note("done", f"共 {len(words)} 词")
    return {"wordlist_id": wordlist_id, "scene": scene, "counts": counts, "dropped": dropped}
