"""考纲本按场景学：给一批单词定场景归属、造例句（模块 01）。

八本考纲是**虚拟本**（由 `dict_entry.tag` 现算，没有 wordlist 行），产物按词落
`word_scene`，读取时 LEFT JOIN 进去。去重后 14,942 词，按本存要存 38,855 份。

## 三条轨，不是一套分法打天下

实测把 100 个 GRE 词硬套「生活场景」，模型给出的是
`expurgate（删节）→ 校园课堂`、`finable（可罚款的）→ 工作职业`、
`exiguous（稀少的）→ 方位数量`——这是硬凑，比留个「抽象」桶更误导。
而 100 个中考词里 `抽象思维` 一个桶就占 32%。

所以按词的性质分流：

- `scene` 具象场景（校园课堂 / 饮食餐厅 / 出行交通）——中考高考四级的主体
- `family` 词根词族（`-duce` / `bene-` / `-vert`）——GRE 托福的主体，
  传统上这批词就是按词根背的，硬套场景是削足适履
- `theme` 抽象语义主题（因果逻辑 / 褒贬评价 / 程度强弱）——抽象但无共同词根的那批

## 三步走，顺序不能反

1. `build_taxonomy` 先看全本词，定出这一本的场景表（分桶数按「每桶 40~80 词」算）
2. `classify_batch` 拿**固定的**场景表逐批归类——不给固定表的话，
   第 1 批说「校园课堂」第 5 批说「学校学习」，同一个意思两个桶
3. `make_examples` 造例句时**把该词的场景喂进去**，例句就落在这个场景里。
   一个场景里的例句因此是连贯的，背起来成篇——这是先分类后造句的唯一理由

## 批量大小

`llm.CHAT_TIMEOUT_S = 60` 是整请求硬墙，超时即整批丢。实测 gpt-5.4-mini：
分类 100 词 18.5s、例句 60 词 36.6s、例句 30 词 18.4s。
例句取 25 是给长词表留余量——不是为省 token，是别贴着墙跑。
"""

import asyncio
import json
import logging
import math

from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from domain.llm import complete_json
from domain.models import DeckScene, DictEntry, WordScene

logger = logging.getLogger(__name__)

ALIAS = "explain-standard"

TAXONOMY_CHUNK = 400  # 建表阶段每次给模型看多少词
CLASSIFY_BATCH = 50
EXAMPLE_BATCH = 25
CONCURRENCY = 4  # 同 domain/subtitle_review.py 的既有口径

# 每个场景装多少词。太细则「学完一个场景」的成就感消失、相关词被拆散；
# 太粗则一个场景一次学不完。40~80 是一次学习会话吃得下的量。
WORDS_PER_SCENE = 60
MIN_SCENES, MAX_SCENES = 8, 140

TRACKS = ("scene", "family", "theme")


def _short(translation: str | None) -> str:
    """ECDICT 的释义是多行多义项，喂给模型只取第一条、截断。"""
    if not translation:
        return ""
    return translation.split("\n")[0].strip()[:40]


def target_scene_count(total: int) -> int:
    return max(MIN_SCENES, min(MAX_SCENES, math.ceil(total / WORDS_PER_SCENE)))


# ───────────────────────────── 第 1 步：建场景表 ─────────────────────────────

_TAXONOMY_SYSTEM = """你在为中国学生设计背单词的分组方案。给你一批英语单词（带中文释义），
你要提出适合它们的分组名。

只输出 JSON：{"buckets":[{"name":"分组名","track":"scene|family|theme","root":"词根或空"}]}

三种 track 各自的判据：
- scene：**具象**词能落进的真实生活场景。名如 校园课堂 / 饮食餐厅 / 出行交通 / 身体健康。
- family：共享**真正的拉丁/希腊词根词缀**的词族。name 写词族名（如「-duce 引导」），
  root 写词根本身（如 -duce）。判据从严：
  · 必须是构词词根/词缀（-duce / -vert / -spect / bene- / mal- / re- / -ject），
    **不是**复合词的组成部分（schoolbag 的 -bag、football 的 -ball 都不算）
  · 这批词里至少有 4 个词共享它，凑不够就别立这个族
  · 以具象词为主的词表（中考、高考、四级）本来就没多少词根族，
    没有就一个都不给，不要为了凑数硬造
- theme：抽象、且没有共同词根的词，按语义主题分。名如 因果逻辑 / 褒贬评价 / 程度强弱 / 认知思维。

要求：
- 分组名用中文 2-8 字，彼此不重叠、不同义
- 不要造「其他」「杂项」「通用」这类兜底桶——那等于没分
- 具象词多就多给 scene，抽象词多就多给 family/theme，按这批词的实际构成来
- 只提出分组，不要分配单词"""

_MERGE_SYSTEM = """你在合并若干批次各自提出的分组方案，得到一份**最终**分组表。

只输出 JSON：{"buckets":[{"name":"分组名","track":"scene|family|theme","root":"词根或空"}]}

要求：
- 同义或高度重叠的分组合并成一个，保留最贴切的名字（「校园课堂」和「学校学习」留一个）
- 最终数量必须是 {want} 个左右（±15%），多了就合并，少了就把过宽的拆开
- 三种 track 的比例要反映输入里的实际比例，不要强行拉平
- 不要「其他」「杂项」这类兜底桶
- 分组名彼此不重叠、不同义"""


async def build_taxonomy(words: list[dict], want: int) -> list[dict]:
    """看全本词，产出这一本的固定场景表。

    分块看是因为一次塞 7,504 个词进 prompt 会顶爆上下文，也会让模型只顾头尾。
    各块独立提方案，最后合并去重——合并这一步不能省，否则各块的命名对不齐。
    """
    chunks = [words[i : i + TAXONOMY_CHUNK] for i in range(0, len(words), TAXONOMY_CHUNK)]
    per_chunk = max(4, math.ceil(want / max(len(chunks), 1)) + 4)
    sem = asyncio.Semaphore(CONCURRENCY)

    async def one(chunk: list[dict]) -> list[dict]:
        async with sem:
            payload = {
                "want": per_chunk,
                "words": [{"w": w["word"], "zh": _short(w.get("translation"))} for w in chunk],
            }
            try:
                out, _model, _ms = await complete_json(
                    ALIAS, _TAXONOMY_SYSTEM, json.dumps(payload, ensure_ascii=False)
                )
            except Exception:
                logger.exception("建场景表分块失败，跳过该块")
                return []
            return [b for b in (out.get("buckets") or []) if isinstance(b, dict) and b.get("name")]

    proposed: list[dict] = []
    for got in await asyncio.gather(*(one(c) for c in chunks)):
        proposed.extend(got)
    if not proposed:
        raise RuntimeError("建场景表失败：所有分块都没有产出")

    merged, _model, _ms = await complete_json(
        ALIAS,
        _MERGE_SYSTEM.replace("{want}", str(want)),
        json.dumps({"want": want, "buckets": proposed}, ensure_ascii=False),
    )
    buckets = [
        {
            "name": str(b["name"]).strip()[:48],
            "track": b.get("track") if b.get("track") in TRACKS else "theme",
            "root": (str(b.get("root") or "").strip() or None),
        }
        for b in (merged.get("buckets") or [])
        if isinstance(b, dict) and str(b.get("name") or "").strip()
    ]
    # 合并阶段偶尔仍会吐重名，按名字去重保序
    seen: set[str] = set()
    out: list[dict] = []
    for b in buckets:
        name = str(b["name"])
        if name in seen:
            continue
        seen.add(name)
        out.append(b)
    if not out:
        raise RuntimeError("建场景表失败：合并后为空")
    return out


# ───────────────────────────── 第 2 步：归类 ─────────────────────────────

_CLASSIFY_SYSTEM = """你把英语单词分配到**给定的**分组里，服务背单词的中国学生。

只输出 JSON：{"assign":[{"w":单词,"g":分组名}]}

铁律：
- `g` **必须**是给定分组表里的原名，一字不差。不要自造新分组，不要改写分组名。
- 每个输入词都要出现在输出里，一个都不能漏。
- 每个词只给一个最贴切的分组。
- 具象词优先进 scene 类分组；抽象词看有没有共同词根，有就进对应的 family，没有就进 theme。
- 拿不准时选**语义最近**的那个，不要因为不确定就都堆进同一个分组。"""


async def classify_batch(batch: list[dict], taxonomy: list[dict]) -> dict[str, str]:
    """把一批词分配到固定场景表里，返回 {word: 分组名}。未命中表内名字的丢弃。"""
    names = {b["name"] for b in taxonomy}
    payload = {
        "buckets": [
            {"name": b["name"], "track": b["track"], **({"root": b["root"]} if b["root"] else {})}
            for b in taxonomy
        ],
        "words": [{"w": w["word"], "zh": _short(w.get("translation"))} for w in batch],
    }
    out, _model, _ms = await complete_json(
        ALIAS, _CLASSIFY_SYSTEM, json.dumps(payload, ensure_ascii=False)
    )
    got: dict[str, str] = {}
    for a in out.get("assign") or []:
        if not isinstance(a, dict):
            continue
        w, g = str(a.get("w") or ""), str(a.get("g") or "")
        if w and g in names:
            got[w] = g
    return got


# ───────────────────────────── 第 3 步：例句 ─────────────────────────────

_EXAMPLE_SYSTEM = """你给英语单词造例句，服务背单词的中国学生。

只输出 JSON：{"items":[{"w":单词,"en":例句,"zh":中文翻译}]}

例句要求：
- 8~16 词，当代自然英语（口语或常见书面语均可），不要百科式定义句
- **必须落在该词所属的分组场景里**——输入里每个词都带 `g`（分组名），
  例句的情境要贴合它。同一分组的例句连起来读应该像同一个场景下发生的事。
- 必须用上该词本身（原形或常见变形），不要用同义词替换
- 不要生僻搭配、不要为炫技堆难词：句中除目标词外应尽量用常见词
- 中文翻译要自然通顺，不要逐词硬译

每个输入词都要出现在输出里，一个都不能漏。"""


async def make_examples(batch: list[dict]) -> dict[str, dict]:
    """给一批（已带分组的）词造例句，返回 {word: {"en":…, "zh":…}}。"""
    payload = {
        "words": [
            {"w": w["word"], "zh": _short(w.get("translation")), "g": w.get("scene") or ""}
            for w in batch
        ]
    }
    out, model, _ms = await complete_json(
        ALIAS, _EXAMPLE_SYSTEM, json.dumps(payload, ensure_ascii=False)
    )
    got: dict[str, dict] = {}
    for it in out.get("items") or []:
        if not isinstance(it, dict):
            continue
        w, en, zh = str(it.get("w") or ""), str(it.get("en") or ""), str(it.get("zh") or "")
        if w and en and zh:
            got[w] = {"en": en, "zh": zh, "model": model}
    return got


# ───────────────────────────── 第 4 步：按实际词数重平衡 ─────────────────────────────

_SPLIT_SYSTEM = """你要为一个过大的单词分组，设计若干个更小的子分组名。

只输出 JSON：{"buckets":[{"name":"子分组名"}]}

要求：
- **正好 {parts} 个**，不多不少
- 名字用中文 2-8 字，要比原名「{origin}」更具体，彼此不重叠不同义
- 只给名字，**不要分配单词**——分配由下一步做
- 不要「其他」「杂项」这类兜底名"""

_MERGE_SMALL_SYSTEM = """你要把几个过小的单词分组，并进给定的目标分组里。

只输出 JSON：{"assign":[{"w":单词,"g":目标分组名}]}

要求：
- `g` 必须是目标分组表里的原名，一字不差，不要自造
- 每个输入词都要出现在输出里
- 按语义就近并，拿不准时选语义最接近的那个"""


async def split_bucket(name: str, words: list[dict], parts: int) -> dict[str, str]:
    """把一个过大的分组按语义拆成 parts 个，返回 {word: 新分组名}。

    建表阶段看不到最终词数（它只看词、不做分配），所以过大过小只能等分类完成后
    用**实际计数**来修。实测中考建出的表里「认知判断」吃进 176 词、「评价判断」139 词，
    都远超一次学习会话吃得下的量。

    > [!danger] 造名和分配必须分两步做
    >
    > 第一版让模型边造名边分配（一次调用出 {w, g}），结果 139 词被拆成 **73 组**、
    > 176 词拆成 49 组——基本每两个词一个新组名，27 组的表被打成 165 组、
    > 其中 83 组只有 1~2 个词。
    > 分类那步之所以稳，是因为组名**是给定的、代码会校验**（表外的名字直接丢弃）。
    > 所以这里也拆成两步：先只要 parts 个名字，再走同一条 `classify_batch`
    > 把词分进去。上限由代码保证，不靠模型自觉。
    """
    named, _model, _ms = await complete_json(
        ALIAS,
        _SPLIT_SYSTEM.replace("{parts}", str(parts)).replace("{origin}", name),
        json.dumps(
            {"origin": name, "parts": parts,
             "words": [{"w": w["word"], "zh": _short(w.get("translation"))} for w in words]},
            ensure_ascii=False,
        ),
    )
    buckets = [
        {"name": str(b["name"]).strip()[:48], "track": "theme", "root": None}
        for b in (named.get("buckets") or [])
        if isinstance(b, dict) and str(b.get("name") or "").strip()
    ][:parts]
    if len(buckets) < 2:  # 名字都没造出来，保持原样比拆坏强
        return {}

    got: dict[str, str] = {}
    for i in range(0, len(words), CLASSIFY_BATCH):
        batch = words[i : i + CLASSIFY_BATCH]
        got.update(await classify_batch(batch, buckets))
    return got


async def merge_small(words: list[dict], targets: list[str]) -> dict[str, str]:
    """把零碎分组的词并进目标分组，返回 {word: 目标分组名}。"""
    names = set(targets)
    out, _model, _ms = await complete_json(
        ALIAS,
        _MERGE_SMALL_SYSTEM,
        json.dumps(
            {"buckets": targets,
             "words": [{"w": w["word"], "zh": _short(w.get("translation")),
                        "from": w.get("scene")} for w in words]},
            ensure_ascii=False,
        ),
    )
    return {
        str(a["w"]): str(a["g"])
        for a in (out.get("assign") or [])
        if isinstance(a, dict) and a.get("w") and str(a.get("g")) in names
    }


# ───────────────────────────── 落库 ─────────────────────────────


async def load_words(session: AsyncSession, tag: str) -> list[dict]:
    """取某个考纲 tag 下的全部词，词频序（常用词排前面，先学的先有素材）。"""
    stmt = (
        select(DictEntry.word, DictEntry.translation)
        .where(DictEntry.tag.op("~")(f"(^| ){tag}( |$)"))
        .order_by(DictEntry.frq.nulls_last(), DictEntry.word)
    )
    return [{"word": r[0], "translation": r[1]} for r in (await session.execute(stmt)).all()]


async def deck_scenes(session: AsyncSession, deck: str) -> dict[str, DeckScene]:
    """这一本里已归好类的词。分类按本（见 DeckScene 的注释）。"""
    rows = (
        await session.execute(select(DeckScene).where(DeckScene.deck == deck))
    ).scalars()
    return {r.word: r for r in rows}


async def word_examples(session: AsyncSession, words: list[str]) -> dict[str, WordScene]:
    """这些词已有的例句。例句按词，跨本共用一句——同一个词在四级和六级里
    没必要造两句不同的，生成六遍还会不一致。"""
    if not words:
        return {}
    rows = (
        await session.execute(select(WordScene).where(WordScene.word.in_(words)))
    ).scalars()
    return {r.word: r for r in rows}


async def upsert_scenes(session: AsyncSession, deck: str, rows: list[dict]) -> int:
    """写入/更新某本的场景归属。"""
    for r in rows:
        cur = await session.get(DeckScene, (deck, r["word"]))
        if cur is None:
            session.add(DeckScene(deck=deck, **r))
        else:
            cur.scene = r["scene"]
            cur.track = r["track"]
            cur.root = r.get("root")
    await session.commit()
    return len(rows)


async def upsert_examples(session: AsyncSession, rows: list[dict]) -> int:
    """写入/更新例句（按词）。"""
    for r in rows:
        cur = await session.get(WordScene, r["word"])
        if cur is None:
            session.add(WordScene(**r))
        else:
            for k, v in r.items():
                if k != "word" and v is not None:
                    setattr(cur, k, v)
    await session.commit()
    return len(rows)


async def clear_deck(session: AsyncSession, deck: str) -> None:
    """清掉某本的场景归属，供整本重建分组时用。例句不动。"""
    await session.execute(delete(DeckScene).where(DeckScene.deck == deck))
    await session.commit()
