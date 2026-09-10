"""发音特征原始量抽取（FR-399 的第一步）。

用法（server 目录）：
    uv run python scripts/extract_pronunciation_features.py --split train
    uv run python scripts/extract_pronunciation_features.py --split test

**只抽原始量，不算分**。产物是 `data/phonetics/raw_{split}.jsonl`，
每行一条语料：专家分 + 逐音素的（符号/重音/所属词/时长/GOP/帧级置信度）。

为什么要拆这一步：一次推理 0.5 秒，全量 5000 条要 40 分钟。
特征工程与模型拟合放在 `calibrate_pronunciation.py` 里读这份缓存，
调一次模型是秒级而不是 40 分钟——**否则根本没法做特征迭代**。
"""

import argparse
import json
import random
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from domain.phoneme_asr import analyze_utterance  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent.parent / "data" / "phonetics"
DATASET = ROOT / "speechocean762"
SCORES = ROOT / "so762_scores.json"


def out_path(split: str) -> Path:
    return ROOT / f"raw_{split}.jsonl"


def load_items(split: str) -> list[tuple[str, Path]]:
    scp = DATASET / split / "wav.scp"
    if not scp.exists():
        print(f"缺 {scp}，先解开 speechocean762.tar.gz")
        sys.exit(1)
    out = []
    for line in scp.read_text(encoding="utf-8").splitlines():
        parts = line.split()
        if len(parts) == 2:
            out.append((parts[0], DATASET / parts[1]))
    return out


def run(split: str, limit: int | None, resume: bool) -> None:
    scores = json.loads(SCORES.read_text(encoding="utf-8"))
    items = [(k, p) for k, p in load_items(split) if k in scores and p.exists()]
    # 固定种子打乱。**wav.scp 是按说话人排好序的**，不打乱的话任何 --limit
    # 或中途停掉的运行都只覆盖前几十个说话人——而且那批人恰好偏好，
    # 实测截断子集里 accuracy ≤5 只占 1.7%，全量是 13.8%。
    # 在这种「好学生子集」上统计基准表、拟合权重、报 ρ，全都是偏的
    random.Random(20260819).shuffle(items)
    if limit:
        items = items[:limit]

    dest = out_path(split)
    done: set[str] = set()
    if resume and dest.exists():
        for line in dest.read_text(encoding="utf-8").splitlines():
            try:
                done.add(json.loads(line)["utt"])
            except (ValueError, KeyError):
                continue
        print(f"续跑：已有 {len(done)} 条")
    todo = [(k, p) for k, p in items if k not in done]
    print(f"{split} 集 {len(items)} 条，待抽 {len(todo)} 条")

    t0 = time.time()
    failed = 0
    with dest.open("a" if resume else "w", encoding="utf-8") as sink:
        for i, (utt, wav) in enumerate(todo):
            gold = scores[utt]
            text = str(gold.get("text") or "").strip()
            if not text:
                continue
            try:
                raw = analyze_utterance(str(wav), text)
            except Exception as exc:  # noqa: BLE001 - 单条失败不该中断整轮
                failed += 1
                if failed <= 5:
                    print(f"  跳过 {utt}：{str(exc)[:90]}")
                continue
            sink.write(
                json.dumps(
                    {
                        "utt": utt,
                        "text": text,
                        "expert": {
                            "total": gold.get("total"),
                            "accuracy": gold.get("accuracy"),
                            "fluency": gold.get("fluency"),
                            "completeness": gold.get("completeness"),
                            "prosodic": gold.get("prosodic"),
                            # 词级重音分：重音特征的直接对照目标
                            "word_stress": [w.get("stress") for w in gold.get("words", [])],
                            "word_accuracy": [w.get("accuracy") for w in gold.get("words", [])],
                        },
                        "raw": raw,
                    },
                    ensure_ascii=False,
                )
                + "\n"
            )
            if (i + 1) % 200 == 0:
                rate = (time.time() - t0) / (i + 1)
                left = rate * (len(todo) - i - 1) / 60
                print(f"  {i + 1}/{len(todo)}  {rate:.2f}s/条，剩余 {left:.1f} 分钟")
    print(f"完成，失败 {failed} 条，写入 {dest}")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--split", default="test", choices=["test", "train"])
    ap.add_argument("--limit", type=int)
    ap.add_argument("--resume", action="store_true")
    args = ap.parse_args()
    run(args.split, args.limit, args.resume)


if __name__ == "__main__":
    main()
