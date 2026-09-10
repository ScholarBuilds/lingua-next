"""音标数据地基入库（FR-390）：ipa-dict + CMUdict → `word_phoneme`。

用法（server 目录）：
    uv run python scripts/seed_phonemes.py                # 全量重建
    uv run python scripts/seed_phonemes.py --oov          # 只跑 g2p 兜底补缺
    uv run python scripts/seed_phonemes.py --check        # 只体检不写库

数据来源（都在 `data/phonetics/`，由 `--download` 拉取）：

| 文件 | 来源 | 许可 | 提供 |
| --- | --- | --- | --- |
| `en_US.txt` / `en_UK.txt` | open-dict-data/ipa-dict | MIT | 单一记法的 IPA 主档 |
| `cmudict.dict` | cmusphinx/cmudict | BSD-2 | ARPAbet 带重音数字 → 音节数与重音型 |

ECDICT 的 `phonetic` 一律不动（35.3 万条 IPA/DJ 混排，28% 含西里尔字符），
它降级为兜底展示，主展示读这张新表。
"""

import argparse
import asyncio
import sys
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from sqlalchemy import func, select, text  # noqa: E402

from app.db import SessionFactory  # noqa: E402
from domain.models import DictEntry, WordPhoneme  # noqa: E402
from domain.phonetics import (  # noqa: E402
    arpabet_to_ipa,
    first_pron,
    normalize_word,
    parse_arpabet,
    stress_pattern,
    syllable_count,
)

DATA_DIR = Path(__file__).resolve().parent.parent.parent / "data" / "phonetics"

SOURCES = {
    "en_US.txt": "https://raw.githubusercontent.com/open-dict-data/ipa-dict/master/data/en_US.txt",
    "en_UK.txt": "https://raw.githubusercontent.com/open-dict-data/ipa-dict/master/data/en_UK.txt",
    "cmudict.dict": "https://raw.githubusercontent.com/cmusphinx/cmudict/master/cmudict.dict",
}

BATCH = 5000


def download() -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    for name, url in SOURCES.items():
        dest = DATA_DIR / name
        if dest.exists():
            print(f"跳过已存在 {name}")
            continue
        print(f"下载 {name} …")
        req = urllib.request.Request(url, headers={"User-Agent": "lingua-next/1.0"})
        with urllib.request.urlopen(req, timeout=180) as resp:
            dest.write_bytes(resp.read())
        print(f"  {dest.stat().st_size / 1e6:.1f} MB")


def load_ipa_dict(path: Path) -> dict[str, str]:
    """ipa-dict 行格式 `word\\t/ipa/, /ipa2/`，取首个主读音。"""
    out: dict[str, str] = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        if "\t" not in line:
            continue
        word, prons = line.split("\t", 1)
        word = normalize_word(word)
        if not word or not word.isascii():
            continue
        pron = first_pron(prons)
        if pron:
            out.setdefault(word, pron)
    return out


def load_cmudict(path: Path) -> dict[str, list[str]]:
    """CMUdict 行格式 `word AA1 B C  # comment`；`word(2)` 是次要读音，只保留主读音。"""
    out: dict[str, list[str]] = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.split("#", 1)[0].strip()
        if not line:
            continue
        head, _, rest = line.partition(" ")
        if head.endswith(")"):  # 次要读音，主读音已在前面出现过
            continue
        word = normalize_word(head)
        if not word or not word.isascii():
            continue
        phones = parse_arpabet(rest)
        if phones:
            out.setdefault(word, phones)
    return out


def build_rows() -> list[dict]:
    us = load_ipa_dict(DATA_DIR / "en_US.txt")
    uk = load_ipa_dict(DATA_DIR / "en_UK.txt")
    cmu = load_cmudict(DATA_DIR / "cmudict.dict")
    print(f"ipa-dict en_US {len(us)}，en_UK {len(uk)}，CMUdict {len(cmu)}")

    words = set(us) | set(uk) | set(cmu)
    rows: list[dict] = []
    for w in sorted(words):
        if len(w) > 128:
            continue
        phones = cmu.get(w)
        ipa_us = us.get(w)
        # en_US 缺的词用 CMUdict 转写补上：同为词典事实，来源仍记 cmudict
        source = "ipa-dict" if ipa_us else ("cmudict" if phones else "ipa-dict")
        if not ipa_us and phones:
            ipa_us = arpabet_to_ipa(phones)
        ipa_uk = uk.get(w)
        rows.append(
            {
                "word": w,
                "ipa_us": ipa_us[:256] if ipa_us else None,
                "ipa_uk": ipa_uk[:256] if ipa_uk else None,
                "arpabet": " ".join(phones)[:256] if phones else None,
                "syllables": syllable_count(phones) if phones else None,
                "stress": stress_pattern(phones)[:32] if phones else None,
                "source": source,
            }
        )
    return rows


async def write_rows(rows: list[dict], *, replace: bool) -> None:
    async with SessionFactory() as s:
        if replace:
            await s.execute(text("TRUNCATE TABLE word_phoneme"))
            await s.commit()
        for i in range(0, len(rows), BATCH):
            chunk = rows[i : i + BATCH]
            await s.execute(WordPhoneme.__table__.insert(), chunk)
            await s.commit()
            print(f"  写入 {min(i + BATCH, len(rows))}/{len(rows)}", end="\r")
    print()


# nltk 自带的 downloader 走的是重定向到 CDN 的地址，受限网络下会直接失败；
# 这里改成拉官方 nltk_data 仓库的原始 zip，路径与 downloader 落盘的完全一致。
NLTK_PACKAGES = (
    ("corpora/cmudict", "corpora"),
    ("taggers/averaged_perceptron_tagger", "taggers"),
    ("taggers/averaged_perceptron_tagger_eng", "taggers"),
)
NLTK_BASE = "https://raw.githubusercontent.com/nltk/nltk_data/gh-pages/packages"


def _ensure_nltk() -> None:
    """g2p_en 依赖的 nltk 语料按需落盘。只有离线 OOV 兜底走这条路径，运行时不需要。"""
    import io
    import zipfile

    import nltk

    root = Path(nltk.data.path[0] if nltk.data.path else Path.home() / "nltk_data")
    for rel, subdir in NLTK_PACKAGES:
        try:
            nltk.data.find(rel)
            continue
        except LookupError:
            pass
        print(f"下载 nltk 语料 {rel} …")
        req = urllib.request.Request(
            f"{NLTK_BASE}/{rel}.zip", headers={"User-Agent": "lingua-next/1.0"}
        )
        with urllib.request.urlopen(req, timeout=180) as resp:
            blob = resp.read()
        dest = root / subdir
        dest.mkdir(parents=True, exist_ok=True)
        zipfile.ZipFile(io.BytesIO(blob)).extractall(dest)


async def fill_oov(limit: int) -> int:
    """ECDICT 高频词里 word_phoneme 没覆盖到的，用 g2p_en 兜底（FR-390e）。

    `source='g2p'` 是算法推测不是词典事实，前端要能与词典来源区分（BR-93）。
    """
    _ensure_nltk()
    from g2p_en import G2p  # 延迟导入：只有这条路径需要 nltk 语料

    async with SessionFactory() as s:
        missing = (
            await s.execute(
                select(DictEntry.word)
                .outerjoin(WordPhoneme, WordPhoneme.word == func.lower(DictEntry.word))
                .where(WordPhoneme.word.is_(None))
                .where(DictEntry.frq > 0, DictEntry.frq < 20000)
                .limit(limit)
            )
        ).scalars().all()
    words = [w.lower() for w in missing if w and w.isascii() and w.replace(" ", "").isalpha()]
    words = sorted(set(words))
    if not words:
        print("高频词已全覆盖，无需兜底")
        return 0
    print(f"g2p 兜底 {len(words)} 个词 …")
    g2p = G2p()
    rows = []
    for w in words:
        phones = [p for p in g2p(w) if p.strip() and p[0].isalpha()]
        if not phones:
            continue
        rows.append(
            {
                "word": w[:128],
                "ipa_us": arpabet_to_ipa(phones)[:256],
                "ipa_uk": None,
                "arpabet": " ".join(phones)[:256],
                "syllables": syllable_count(phones),
                "stress": stress_pattern(phones)[:32],
                "source": "g2p",
            }
        )
    async with SessionFactory() as s:
        for i in range(0, len(rows), BATCH):
            await s.execute(WordPhoneme.__table__.insert(), rows[i : i + BATCH])
            await s.commit()
    return len(rows)


async def check() -> None:
    """AC-90 体检：高频词覆盖率、记法统一性。"""
    async with SessionFactory() as s:
        total = (await s.execute(select(func.count()).select_from(WordPhoneme))).scalar_one()
        hi = (
            await s.execute(
                select(func.count())
                .select_from(DictEntry)
                .where(DictEntry.frq > 0, DictEntry.frq < 20000)
            )
        ).scalar_one()
        hit = (
            await s.execute(
                select(func.count())
                .select_from(DictEntry)
                .join(WordPhoneme, WordPhoneme.word == func.lower(DictEntry.word))
                .where(DictEntry.frq > 0, DictEntry.frq < 20000)
            )
        ).scalar_one()
        # 西里尔字符检查：ә U+04D9 是 ECDICT 那批脏数据的标志
        dirty = (
            await s.execute(
                select(func.count())
                .select_from(WordPhoneme)
                .where(WordPhoneme.ipa_us.op("~")("[Ѐ-ӿ]"))
            )
        ).scalar_one()
        by_src = (
            await s.execute(select(WordPhoneme.source, func.count()).group_by(WordPhoneme.source))
        ).all()
    rate = hit / hi * 100 if hi else 0
    print(f"word_phoneme 总数 {total}")
    print(f"来源分布 {dict(by_src)}")
    print(f"ECDICT 高频词（frq<20000）{hi}，覆盖 {hit}（{rate:.1f}%）  AC-90 要求 ≥95%")
    print(f"含西里尔字符条数 {dirty}  AC-90 要求 0")


async def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--download", action="store_true", help="缺文件时先下载")
    ap.add_argument("--oov", action="store_true", help="只跑 g2p 兜底")
    ap.add_argument("--oov-limit", type=int, default=20000)
    ap.add_argument("--check", action="store_true", help="只体检")
    args = ap.parse_args()

    if args.download:
        download()
    if args.check:
        await check()
        return
    if args.oov:
        n = await fill_oov(args.oov_limit)
        print(f"g2p 补入 {n} 条")
        await check()
        return

    missing = [n for n in SOURCES if not (DATA_DIR / n).exists()]
    if missing:
        print(f"缺数据文件 {missing}，先跑 --download")
        sys.exit(1)
    rows = build_rows()
    print(f"合并后 {len(rows)} 条，开始写库")
    await write_rows(rows, replace=True)
    await check()


if __name__ == "__main__":
    asyncio.run(main())
