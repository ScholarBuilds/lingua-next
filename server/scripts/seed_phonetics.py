"""音位卡片与最小对立对入库（FR-392、FR-393c）。

用法（server 目录）：
    uv run python scripts/seed_phonetics.py            # 音位卡 + 最小对立对
    uv run python scripts/seed_phonetics.py --cards    # 只重建音位卡
    uv run python scripts/seed_phonetics.py --pairs    # 只重建最小对立对

两件事都是**从数据算出来的**，不是手写清单：

- **例词按音素在词中的位置分组**（FR-392g）：拿 CMUdict 的音素序列判定
  词首/词中/词尾，再按 ECDICT 词频挑常用的。手写例词容易出现「这个音其实不在词首」
  的错（`/ŋ/` 就根本不出现在词首）。
- **最小对立对**（FR-393c）：音素序列长度相同且恰好差一位，差的那位落在 13 个对比组里。
  用「挖空位」哈希一次扫完，不做两两比较。
"""

import argparse
import asyncio
import re
import sys
from collections import defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from sqlalchemy import func, select, text  # noqa: E402

from app.db import SessionFactory  # noqa: E402
from domain.models import DictEntry, MinimalPair, Phoneme, WordPhoneme  # noqa: E402
from domain.phoneme_cards import ALL_CARDS, CONTRAST_GROUPS  # noqa: E402
from domain.phonetics import arpabet_to_ipa, parse_arpabet, strip_stress  # noqa: E402

# 例词只从这个词频档里挑：frq 是 COCA 位次，越小越常用。
# 0 是专有名词的哨兵值（CLAUDE.md 里记过），必须排除。
EXAMPLE_MAX_FRQ = 12000
# 最小对立对两词都要在这个档内，否则出题会出现谁也没见过的词。
# 比例词宽是有意的：θ/f、ð/z 这类对比在英语里本来就稀缺
# （ð/z 全语言的最小对立对不过十来组），卡太死就凑不够一组题。
PAIR_MAX_FRQ = 60000
PER_POSITION = 3
MIN_PAIRS_PER_GROUP = 20

# 词 → (去重音音素, 带重音音素, 词频位次)
LEX = dict[str, tuple[list[str], list[str], int]]
# ECDICT 里既无 COCA 也无 BNC 位次的词用这个哨兵，排序时自然沉底
UNRANKED = 999_999

# 专有名词过滤：ECDICT 的人名/地名条目 frq 恒为 0，只在 BNC 里有位次，
# 不挡掉就会出现 tim / pete / phil 这种「最小对立对」。
PROPER_NOUN_RE = re.compile(r"(男子名|女子名|人名|姓氏|地名|城市|州名|国名|品牌|公司名)")
# 缩写词与专业术语条目：ECDICT 里 THI（温度-湿度指数）、`[计] vi文本编辑器`
# 这类条目有音标也有词频，但它们不是普通词，出成听辨题就是废题
ABBREV_RE = re.compile(r"^\s*(abbr\.|\[)")
# 学习材料不出现的词。列表短是有意的：只挡最直接的几个，不做泛化过滤
BLOCKLIST = frozenset({"shit", "fuck", "cunt", "piss", "tit", "tits", "arse", "ass"})


async def load_lexicon() -> dict[str, tuple[list[str], list[str], int]]:
    """词 → (去重音音素序列, 原始带重音序列, 词频位次)。

    两份序列都要：**匹配**用去重音的（AH0 与 AH1 是同一个音位），
    **展示**用带重音的（AH0 是 ə、AH1 是 ʌ，混起来会把 apiece 写成 ʌpiːs）。
    """
    async with SessionFactory() as s:
        rows = (
            await s.execute(
                select(
                    WordPhoneme.word,
                    WordPhoneme.arpabet,
                    # frq=0 是专有名词哨兵，这类词退回 BNC 位次；两者都无则排除
                    func.coalesce(func.nullif(DictEntry.frq, 0), DictEntry.bnc).label("rank"),
                    DictEntry.frq,
                    DictEntry.translation,
                )
                .join(DictEntry, func.lower(DictEntry.word) == WordPhoneme.word)
                # ECDICT 用大小写区分专名：Essex / Bayes / Y 都是首字母大写存的。
                # 这一条比中文释义正则可靠得多，直接挡掉 50 万条专名与缩写
                .where(DictEntry.word == func.lower(DictEntry.word))
                .where(WordPhoneme.arpabet.is_not(None))

            )
        ).all()
    out: dict[str, tuple[list[str], list[str], int]] = {}
    for word, arpabet, rank, frq, translation in rows:
        if not word.isalpha() or word in BLOCKLIST:
            continue
        if translation and ABBREV_RE.match(translation):
            continue
        if not frq and translation and PROPER_NOUN_RE.search(translation):
            continue
        raw = parse_arpabet(arpabet)
        if raw:
            # rank 为空表示 ECDICT 既无 COCA 也无 BNC 位次（teethe 就是这种）。
            # 常规对比组按 UNRANKED 直接被词频门槛挡掉，稀缺组另有放宽路径
            out[word] = ([strip_stress(p) for p in raw], raw, rank or UNRANKED)
    return out


def pick_examples(lex: LEX, phone: str) -> dict[str, list[str]]:
    """按音素在词中的位置挑例词：词首 / 词中 / 词尾各取几个高频短词。

    多音素音位（ɪə 写作 `IH R`）取首音素判定位置——两个音素连着出现才算命中。
    """
    want = phone.split()
    n = len(want)
    buckets: dict[str, list[tuple[int, int, str]]] = {"initial": [], "medial": [], "final": []}
    for word, (phones, _raw, frq) in lex.items():
        if frq > EXAMPLE_MAX_FRQ or len(word) > 9:
            continue
        for i in range(len(phones) - n + 1):
            if phones[i : i + n] != want:
                continue
            if i == 0:
                pos = "initial"
            elif i + n == len(phones):
                pos = "final"
            else:
                pos = "medial"
            # 排序键：先按词频，同频优先短词
            buckets[pos].append((frq, len(word), word))
            break
    return {
        pos: [w for _, _, w in sorted(items)[:PER_POSITION]] for pos, items in buckets.items()
    }


async def seed_cards(lex: LEX) -> None:
    rows = []
    for idx, c in enumerate(ALL_CARDS):
        ex = pick_examples(lex, c.arpabet)
        rows.append(
            {
                "symbol": c.symbol,
                "symbol_us": c.symbol_us,
                "arpabet": c.arpabet,
                "kind": c.kind,
                "manner": c.manner,
                "place": c.place,
                "voiced": c.voiced,
                "zh_name": c.zh_name,
                "examples": ex,
                "common_errors": c.common_errors,
                "tips": c.tips,
                "svg_frames": c.svg_frames,
                "chart_x": c.chart[0] if c.chart else None,
                "chart_y": c.chart[1] if c.chart else None,
                "chart_to_x": c.chart_to[0] if c.chart_to else None,
                "chart_to_y": c.chart_to[1] if c.chart_to else None,
                "highlight": c.highlight,
                "contrast_with": c.contrast_with,
                "order_index": idx,
            }
        )
    async with SessionFactory() as s:
        await s.execute(text("TRUNCATE TABLE phoneme"))
        await s.execute(Phoneme.__table__.insert(), rows)
        await s.commit()
    empty = [r["symbol"] for r in rows if not any(r["examples"].values())]
    thin = [
        f"{r['symbol']}({sum(1 for v in r['examples'].values() if v)}/3)"
        for r in rows
        if any(r["examples"].values()) and not all(r["examples"].values())
    ]
    print(f"音位卡 {len(rows)} 条入库")
    if empty:
        print(f"  ⚠ 完全没取到例词：{empty}")
    if thin:
        print(f"  位置不全（正常，如 /ŋ/ 不出现在词首）：{' '.join(thin)}")


def build_pairs(lex: LEX) -> list[dict]:
    """挖空位哈希：同一个 (前缀, 后缀, 位置) 下不同音素的词互为最小对立对。"""
    group_by_phones = {}
    for g in CONTRAST_GROUPS:
        group_by_phones[frozenset((g["a"], g["b"]))] = g["key"]

    scarce_phones = {
        p for g in CONTRAST_GROUPS if g.get("scarce") for p in (g["a"], g["b"])
    }
    slots: dict[tuple, list[tuple[str, str, int]]] = defaultdict(list)
    for word, (phones, _raw, frq) in lex.items():
        if len(phones) > 8:
            continue
        # 稀缺对比组（ð/z）的词放宽词频门槛：英语里这个对比总共不到二十组，
        # 卡死词频就只剩十来组，凑不出一轮练习。放宽只对含该音素的词生效
        if frq > PAIR_MAX_FRQ and not (scarce_phones & set(phones)):
            continue
        for i, p in enumerate(phones):
            key = (i, tuple(phones[:i]), tuple(phones[i + 1 :]))
            slots[key].append((word, p, frq))

    seen: set[tuple[str, str, int]] = set()
    out: list[dict] = []
    for (idx, _pre, _post), items in slots.items():
        if len(items) < 2:
            continue
        for a in range(len(items)):
            for b in range(a + 1, len(items)):
                wa, pa, fa = items[a]
                wb, pb, fb = items[b]
                if pa == pb or wa == wb:
                    continue
                gkey = group_by_phones.get(frozenset((pa, pb)))
                if gkey is None:
                    continue
                # 词尾 s/z 单独成组：只有差异位在词尾才算（price/prize），
                # 词中的 s/z（fasten/…）练的不是同一件事
                is_final = idx == len(lex[wa][0]) - 1  # noqa: SIM300
                if gkey == "s/z" and not is_final:
                    continue
                first, second = (wa, pa), (wb, pb)
                if pa != CONTRAST_LEAD.get(gkey, pa) and pb == CONTRAST_LEAD.get(gkey, pa):
                    first, second = second, first
                sig = (first[0], second[0], idx)
                if sig in seen:
                    continue
                seen.add(sig)
                out.append(
                    {
                        "contrast_group": gkey,
                        "word_a": first[0],
                        "word_b": second[0],
                        "phone_a": first[1],
                        "phone_b": second[1],
                        "diff_index": idx,
                        "freq_rank": max(fa, fb),
                    }
                )
    out.sort(key=lambda r: (r["contrast_group"], r["freq_rank"]))
    return out


# 每个对比组里「排在前面」的那个音素，保证 word_a 恒定属于同一侧
CONTRAST_LEAD = {g["key"]: g["a"] for g in CONTRAST_GROUPS}


async def seed_pairs(lex: LEX) -> None:
    rows = build_pairs(lex)
    # 展示用 IPA 由 ARPAbet 现算，不取 ipa-dict 原串：
    # 两者来源不同，wheel 在 ipa-dict 里是 /hwiɫ/ 而 CMUdict 是 W IY1 L，
    # 直接拿原串会出现「标着最小对立对、IPA 却差两位」的自相矛盾。
    for r in rows:
        r["ipa_a"] = arpabet_to_ipa(lex[r["word_a"]][1], teach=True)[:128]
        r["ipa_b"] = arpabet_to_ipa(lex[r["word_b"]][1], teach=True)[:128]
    async with SessionFactory() as s:
        await s.execute(text("TRUNCATE TABLE minimal_pair RESTART IDENTITY"))
        for i in range(0, len(rows), 2000):
            await s.execute(MinimalPair.__table__.insert(), rows[i : i + 2000])
        await s.commit()
        counts = dict(
            (
                await s.execute(
                    select(MinimalPair.contrast_group, func.count()).group_by(
                        MinimalPair.contrast_group
                    )
                )
            ).all()
        )
    print(f"最小对立对 {len(rows)} 组入库")
    for g in CONTRAST_GROUPS:
        n = counts.get(g["key"], 0)
        flag = "  " if n >= MIN_PAIRS_PER_GROUP else " ⚠"
        print(f"{flag} {g['key']:8s} {n:5d}   AC-91 要求 ≥{MIN_PAIRS_PER_GROUP}")
    bad = [g["key"] for g in CONTRAST_GROUPS if counts.get(g["key"], 0) < MIN_PAIRS_PER_GROUP]
    if bad:
        print(f"AC-91 未达标的对比组：{bad}")


async def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--cards", action="store_true")
    ap.add_argument("--pairs", action="store_true")
    args = ap.parse_args()
    both = not (args.cards or args.pairs)

    lex = await load_lexicon()
    print(f"可用词表 {len(lex)} 条（有 ARPAbet 且有词频）")
    if both or args.cards:
        await seed_cards(lex)
    if both or args.pairs:
        await seed_pairs(lex)


if __name__ == "__main__":
    asyncio.run(main())
