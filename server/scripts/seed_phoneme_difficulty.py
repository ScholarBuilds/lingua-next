"""音素难度统计入库（FR-391）：speechocean762 标注 → `phoneme_difficulty`。

用法（server 目录）：
    uv run python scripts/seed_phoneme_difficulty.py --download
    uv run python scripts/seed_phoneme_difficulty.py

**只解析标注文件，不下载也不跑音频**。数据集 5000 条录音的说话人全部是普通话母语者
（125 成人 + 125 儿童），带逐音素 0/1/2 专家标注，与本项目用户画像正好对口——
所以这张表能回答「中国学习者哪个音最难」，而不是抄一份通用清单。

许可：CC BY 4.0（jimbozhang/speechocean762，OpenSLR 101）。
标注文件 `resource/scores.json` 约 9.7 MB，音频包 ~1 GB 不需要。
"""

import argparse
import asyncio
import json
import sys
import urllib.request
from collections import defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from sqlalchemy import select, text  # noqa: E402

from app.db import SessionFactory  # noqa: E402
from domain.models import PhonemeDifficulty  # noqa: E402
from domain.phonetics import strip_stress  # noqa: E402

DATA_DIR = Path(__file__).resolve().parent.parent.parent / "data" / "phonetics"
SCORES_FILE = DATA_DIR / "so762_scores.json"
SCORES_URL = (
    "https://raw.githubusercontent.com/jimbozhang/speechocean762/master/resource/scores.json"
)

# 专家标注是 0/1/2 三档（也有 1.8 这类均值）：< 2 记为「读得不到位」
LOW_THRESHOLD = 2.0


def download() -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    if SCORES_FILE.exists():
        print(f"跳过已存在 {SCORES_FILE.name}")
        return
    print(f"下载 {SCORES_URL} …")
    req = urllib.request.Request(SCORES_URL, headers={"User-Agent": "lingua-next/1.0"})
    with urllib.request.urlopen(req, timeout=300) as resp:
        SCORES_FILE.write_bytes(resp.read())
    print(f"  {SCORES_FILE.stat().st_size / 1e6:.1f} MB")


def aggregate() -> list[dict]:
    raw = json.loads(SCORES_FILE.read_text(encoding="utf-8"))
    total = defaultdict(float)
    low = defaultdict(int)
    n = defaultdict(int)
    for utt in raw.values():
        for word in utt.get("words", []):
            phones = word.get("phones") or []
            accs = word.get("phones-accuracy") or []
            for phone, acc in zip(phones, accs, strict=False):
                sym = strip_stress(phone).upper()
                if not sym or not sym.isalpha():
                    continue
                n[sym] += 1
                total[sym] += float(acc)
                if float(acc) < LOW_THRESHOLD:
                    low[sym] += 1
    rows = [
        {
            "symbol": sym,
            "low_score_rate": round(low[sym] / n[sym], 4),
            "mean_score": round(total[sym] / n[sym], 4),
            "sample_n": n[sym],
            "source": "speechocean762",
        }
        for sym in sorted(n, key=lambda s: -n[s])
    ]
    print(f"语料数 {len(raw)}，覆盖音素 {len(rows)}，标注点 {sum(n.values())}")
    return rows


async def write(rows: list[dict]) -> None:
    async with SessionFactory() as s:
        await s.execute(text("TRUNCATE TABLE phoneme_difficulty"))
        await s.execute(PhonemeDifficulty.__table__.insert(), rows)
        await s.commit()
        hardest = (
            await s.execute(
                select(PhonemeDifficulty)
                .where(PhonemeDifficulty.sample_n >= 200)
                .order_by(PhonemeDifficulty.low_score_rate.desc())
                .limit(12)
            )
        ).scalars().all()
    print("\n最难的 12 个音素（样本 ≥200）：")
    for d in hardest:
        print(f"  {d.symbol:4s} 低分率 {d.low_score_rate:.1%}  均分 {d.mean_score:.2f}  n={d.sample_n}")


async def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--download", action="store_true")
    args = ap.parse_args()
    if args.download:
        download()
    if not SCORES_FILE.exists():
        print(f"缺 {SCORES_FILE}，先跑 --download")
        sys.exit(1)
    await write(aggregate())


if __name__ == "__main__":
    asyncio.run(main())
