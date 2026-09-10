"""把开源风格库导进本仓的风格预设（模块 16 FR-442）。

数据来源：**twri/sdxl_prompt_styler（MIT）** 的 `sdxl_styles_sai.json` 与
`sdxl_styles_twri.json`，合计 106 条。

> [!warning] 为什么不取 Fooocus 那 215 条
>
> Fooocus 把这两份连同 `diva`(79) / `mre`(22) 一起收进 `sdxl_styles/`，但 Fooocus 本体
> 是 **GPL-3.0**，而多出来那 101 条只存在于它那里。本仓不设许可门禁，但许可事实要
> 登记、将来商业化 GPL 项要重估——同样的东西能从 MIT 上游拿，就没有理由去拿 GPL 的。

> [!danger] 这不是照搬，是改写
>
> 这些提示词是给 SDXL 那类 CLIP 条件扩散模型调的，里面塞满「8K / masterpiece /
> highly detailed / trending on artstation」这种质量咒和 `(word:1.4)` 权重语法。
> gpt-image-2 是指令跟随模型，这些词不提升画质，只是占位置并稀释真正的风格描述。
> 所以导入时统一清洗掉，只留**带视觉信息的那部分**。

跑法（幂等，产物是 `server/data/image_styles.json`）：

    uv run python scripts/import_image_styles.py            # 抓取 + 清洗
    uv run python scripts/import_image_styles.py --label    # 再补中文名与一句话说明（要调 LLM）
"""

from __future__ import annotations

import argparse
import asyncio
import json
import re
import sys
from pathlib import Path

import httpx

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

OUT = ROOT / "data" / "image_styles.json"

# MIT 上游。sai 是 Stability 官方那套，twri 是社区扩充的
BASE = "https://raw.githubusercontent.com/twri/sdxl_prompt_styler/main"
SOURCES = (
    ("sdxl_styles_sai.json", "twri/sdxl_prompt_styler (MIT) · Stability 官方风格"),
    ("sdxl_styles_twri.json", "twri/sdxl_prompt_styler (MIT)"),
)

# 纯质量咒：对指令跟随模型不提升画质，只稀释真正的风格描述。整词匹配后删除。
BOOSTERS = {
    "8k", "4k", "16k", "uhd", "hd", "high resolution", "highres", "high res",
    "best quality", "high quality", "masterpiece", "award winning", "award-winning",
    "highly detailed", "ultra detailed", "extremely detailed", "hyper detailed",
    "intricate details", "sharp focus", "high budget", "professional",
    "trending on artstation", "artstation", "cgsociety", "deviantart",
    "beautiful", "gorgeous", "stunning", "amazing", "epic",
    "very detailed", "detailed", "ultra-detailed", "insanely detailed",
}

# 名字前缀 → 分类。twri 的命名自带分类信息，白捡的分类法
PREFIX_CATEGORY = {
    "sai": "general",
    "ads": "commerce",
    "artstyle": "art",
    "futuristic": "concept",
    "game": "game",
    "misc": "misc",
    "papercraft": "craft",
    "photo": "photo",
    "cinematic": "photo",
    "analog": "photo",
}

CATEGORY_LABELS = {
    "general": "通用",
    "photo": "摄影",
    "art": "绘画",
    "concept": "概念与科幻",
    "game": "游戏",
    "craft": "手作质感",
    "commerce": "广告电商",
    "misc": "其它",
}

WEIGHT = re.compile(r"\(([^():]+?)(?::[\d.]+)?\)")


def strip_weights(text: str) -> str:
    """`(word:1.4)` → `word`。权重语法是 SD 的 UI 约定，别的模型只会把括号当字面量。"""
    prev = None
    while prev != text:
        prev = text
        text = WEIGHT.sub(r"\1", text)
    return text


def clean_terms(text: str) -> list[str]:
    """拆成词条、去质量咒、去重，保持原顺序。"""
    text = strip_weights(text)
    # `{prompt}` 是主体占位，主体由我们自己的立意层给
    text = text.replace("{prompt}", " ")
    # 模板里用 ` . ` 分隔前缀与描述列表，两边都是风格词
    text = text.replace(" . ", ", ")
    out: list[str] = []
    seen: set[str] = set()
    for raw in re.split(r"[,\n]", text):
        term = " ".join(raw.split()).strip(" .;:")
        low = term.lower()
        if not term or low in BOOSTERS or low in seen:
            continue
        seen.add(low)
        out.append(term)
    return out


def categorise(name: str) -> str:
    prefix = name.split("-", 1)[0].lower()
    return PREFIX_CATEGORY.get(prefix, "misc")


def key_of(name: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")


async def fetch_all() -> list[dict]:
    rows: list[dict] = []
    async with httpx.AsyncClient(timeout=60.0) as http:
        for filename, source in SOURCES:
            resp = await http.get(f"{BASE}/{filename}")
            resp.raise_for_status()
            for item in resp.json():
                name = str(item.get("name") or "").strip()
                if not name or name.lower() == "base":
                    continue
                render = clean_terms(str(item.get("prompt") or ""))
                avoid = clean_terms(str(item.get("negative_prompt") or ""))
                if not render:
                    continue
                rows.append(
                    {
                        "key": key_of(name),
                        "origin_name": name,
                        "category": categorise(name),
                        "render": ", ".join(render),
                        "extra_avoid": avoid,
                        "source": source,
                        "builtin": True,
                    }
                )
    # 同名去重：sai 与 twri 有少量重叠，先到的赢
    unique: dict[str, dict] = {}
    for row in rows:
        unique.setdefault(row["key"], row)
    return list(unique.values())


LABEL_SYSTEM = """你在给图像风格预设起中文名。

只输出 JSON 对象 {"items": [{"key": ..., "label": ..., "hint": ...}]}，逐条对应输入。
- label：4~8 个中文字的风格名，要让人一眼知道画出来什么样。不要音译，不要保留英文。
- hint：一句中文，12~26 字，说清楚这个风格适合画什么、画面什么调子。不要复述 label。
禁止出现「精美」「高质量」「令人惊叹」这类没有信息量的形容。"""


async def add_labels(rows: list[dict]) -> None:
    """补中文名与说明。面向用户的枚举必须有中文标签（BR-111）。"""
    from domain.llm import complete_json

    batch = 12
    for start in range(0, len(rows), batch):
        chunk = rows[start : start + batch]
        payload = [
            {"key": r["key"], "origin": r["origin_name"], "terms": r["render"][:200]}
            for r in chunk
        ]
        parsed, _model, _ms = await complete_json(
            "explain-standard", LABEL_SYSTEM, json.dumps(payload, ensure_ascii=False)
        )
        got = {str(i.get("key")): i for i in (parsed.get("items") or [])}
        for row in chunk:
            hit = got.get(row["key"]) or {}
            row["label"] = str(hit.get("label") or "").strip() or row["origin_name"]
            row["hint"] = str(hit.get("hint") or "").strip()
        done = min(start + batch, len(rows))
        print(f"  已命名 {done}/{len(rows)}", flush=True)


async def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--label", action="store_true", help="补中文名与说明（要调 LLM）")
    args = parser.parse_args()

    rows = await fetch_all()
    print(f"抓到 {len(rows)} 条，分类分布：")
    counts: dict[str, int] = {}
    for row in rows:
        counts[row["category"]] = counts.get(row["category"], 0) + 1
    for key, num in sorted(counts.items(), key=lambda kv: -kv[1]):
        print(f"  {CATEGORY_LABELS.get(key, key)}: {num}")

    if OUT.exists():
        # 已经命名过的保留，只补新增的，别每次重跑都花一遍钱
        old = {r["key"]: r for r in json.loads(OUT.read_text(encoding="utf-8"))["styles"]}
        for row in rows:
            hit = old.get(row["key"])
            if hit and hit.get("label"):
                row["label"] = hit["label"]
                row["hint"] = hit.get("hint", "")

    if args.label:
        todo = [r for r in rows if not r.get("label")]
        print(f"待命名 {len(todo)} 条")
        if todo:
            await add_labels(todo)

    rows.sort(key=lambda r: (r["category"], r["key"]))
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(
        json.dumps(
            {
                "note": "由 scripts/import_image_styles.py 生成，勿手改。来源与清洗规则见该脚本。",
                "categories": CATEGORY_LABELS,
                "styles": rows,
            },
            ensure_ascii=False,
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )
    named = sum(1 for r in rows if r.get("label"))
    print(f"写入 {OUT}：{len(rows)} 条，其中 {named} 条已有中文名")


if __name__ == "__main__":
    asyncio.run(main())
