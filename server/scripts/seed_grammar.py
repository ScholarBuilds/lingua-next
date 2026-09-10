"""CEFR-J Grammar Profile 入库（FR-400）。

用法（server 目录）：
    uv run python scripts/seed_grammar.py --download    # 拉官方 xlsx
    uv run python scripts/seed_grammar.py               # 建表入库（不翻译）
    uv run python scripts/seed_grammar.py --translate   # 批量翻译中文名与备考
    uv run python scripts/seed_grammar.py --check

数据来源：CEFR-J Grammar Profile full（TUFS 投野研究室，研究与商业均免费，需正确引用）。
`ITEM LIST` 是主表，`教員版` 给 CEFR-J 细分等级，`EFL SUMMARY (FULL)` 给各 CEFR 段的
相对频率——**没有教员版等级的条目按频率首次显著出现的段推断**，并在 `cefr_level`
上标注来源，不假装两者同源。

`Notes` 与条目名都是日文，翻译单独一步跑：入库与翻译分离，翻译失败不影响主表可用。
"""

import argparse
import asyncio
import sys
import urllib.request
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from sqlalchemy import func, select, text  # noqa: E402

from app.db import SessionFactory  # noqa: E402
from domain.llm import LLMUnavailable, complete_json  # noqa: E402
from domain.models import GrammarPoint  # noqa: E402

DATA_DIR = Path(__file__).resolve().parent.parent.parent / "data" / "grammar"
ZIP_URL = "https://www.cefr-j.org/PDF/sympo2025/CEFRJGP_FULL_20250225.zip"
XLSX_NAME = "CEFR-J Grammar Profile full 20250225.xlsx"

# shorthand code 前缀 → 中文语法范畴。范畴是浏览用的分组，不是难度排序（FR-400d）
CATEGORY_BY_PREFIX = {
    "PP": "代词", "PGEN": "代词", "PPO": "代词", "PPOS": "代词",
    "PREFL": "代词", "PIND": "代词", "PREF": "代词", "P": "代词",
    "DT": "限定词与数量", "QUANT": "限定词与数量", "PREDET": "限定词与数量",
    "NN": "名词",
    "IN": "介词", "PREP": "介词",
    "RB": "副词", "RBDEG": "副词",
    "COMP": "比较与级",
    "V": "动词", "PHV": "短语动词",
    "TA": "时态与体",
    "PASS": "被动语态",
    "TO": "非谓语动词", "VG": "非谓语动词", "VN": "非谓语动词",
    "IMP": "祈使句",
    "MD": "情态动词",
    "EX": "there be 句型",
    "CC": "连词与从句", "CL": "连词与从句", "CL_after": "连词与从句",
    "PREL": "关系从句", "PRELO": "关系从句", "PRELGEN": "关系从句",
    "RBREL": "关系从句", "WH": "关系从句",
    "EXCL": "感叹句",
    "TAG": "反义疑问句",
    "VP": "基本句型",
    "INDSP": "间接引语", "INDQ": "间接引语",
    "EMP": "强调与倒装", "INV": "强调与倒装",
    "CAUS": "使役与感官", "PERC": "使役与感官",
    "SUBJ": "虚拟与条件",
    "INT": "疑问句", "INTF": "疑问句",
}  # fmt: skip

CEFR_ORDER = ("A1", "A2", "B1", "B2", "C1")
# EFL SUMMARY 的相对频率（每百万词）超过这个值即视为该等级已"真正出现"。
# 低于它的是零星噪声——用它推等级会把所有条目都判成 A1
FREQ_THRESHOLD = 5.0


def download() -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    xlsx = DATA_DIR / XLSX_NAME
    if xlsx.exists():
        print(f"跳过已存在 {XLSX_NAME}")
        return
    print(f"下载 {ZIP_URL} …")
    req = urllib.request.Request(ZIP_URL, headers={"User-Agent": "lingua-next/1.0"})
    with urllib.request.urlopen(req, timeout=300) as resp:
        blob = resp.read()
    zpath = DATA_DIR / "CEFRJGP_FULL.zip"
    zpath.write_bytes(blob)
    zipfile.ZipFile(zpath).extractall(DATA_DIR)
    print(f"  解出 {xlsx.name}")


def _sheets() -> dict:
    try:
        import openpyxl
    except ImportError:
        print("需要 openpyxl：uv run --with openpyxl python scripts/seed_grammar.py")
        sys.exit(1)
    wb = openpyxl.load_workbook(DATA_DIR / XLSX_NAME, read_only=True, data_only=True)
    return {
        "items": list(wb["ITEM LIST"].iter_rows(values_only=True))[2:],
        "teacher": list(wb["教員版"].iter_rows(values_only=True))[2:],
        "freq": list(wb["EFL SUMMARY (FULL)"].iter_rows(values_only=True))[3:],
    }


def _teacher_levels(rows: list[tuple]) -> dict[str, str]:
    """教员版：ID → CEFR-J 细分等级（A1.1 ~ B2.2）。"""
    out: dict[str, str] = {}
    for r in rows:
        if r and r[0] and r[4]:
            out[str(r[0]).strip()] = str(r[4]).strip()
    return out


def _freq_levels(rows: list[tuple]) -> dict[str, str]:
    """EFL 语料频率：ID → 首个显著出现的 CEFR 段。"""
    out: dict[str, str] = {}
    for r in rows:
        if not r or not r[0]:
            continue
        vals = []
        for i in range(6, 11):  # A1 A2 B1 B2 C1 五列
            try:
                vals.append(float(r[i]) if r[i] not in (None, "") else 0.0)
            except (TypeError, ValueError):
                vals.append(0.0)
        hit = next((CEFR_ORDER[i] for i, v in enumerate(vals) if v >= FREQ_THRESHOLD), None)
        if hit is None and any(v > 0 for v in vals):
            hit = CEFR_ORDER[max(range(len(vals)), key=lambda i: vals[i])]
        if hit:
            out[str(r[0]).strip()] = hit
    return out


def _category(shorthand: str | None) -> str:
    if not shorthand:
        return "其他"
    prefix = str(shorthand).split(".")[0]
    return CATEGORY_BY_PREFIX.get(prefix, "其他")


def build_rows() -> list[dict]:
    sheets = _sheets()
    teacher = _teacher_levels(sheets["teacher"])
    freq = _freq_levels(sheets["freq"])
    rows: list[dict] = []
    for idx, r in enumerate(sheets["items"]):
        if not r or not r[0]:
            continue
        ext_id = str(r[0]).strip()
        cefrj = teacher.get(ext_id)
        # 教员版给的是 A1.1 这类细分级，取前两位就是 CEFR 主级
        cefr = cefrj[:2] if cefrj else freq.get(ext_id)
        rows.append(
            {
                "ext_id": ext_id,
                "shorthand_code": (str(r[3]) if r[3] else ext_id)[:64],
                "item": (str(r[4]) if r[4] else str(r[1] or ext_id))[:256],
                "item_ja": (str(r[1]) if r[1] else None),
                "item_zh": None,
                "sentence_type": (str(r[5])[:32] if r[5] else None),
                "cefr_level": cefr,
                "cefrj_level": cefrj,
                "note_zh": None,
                # 备考栏原文是日文，翻译前先原样落库，`--translate` 再覆盖
                "explanation": None,
                "examples": [],
                "pattern_regex": (str(r[8]) if len(r) > 8 and r[8] else None),
                "category": _category(r[3]),
                "order_index": idx,
            }
        )
        rows[-1]["_note_ja"] = str(r[6]) if r[6] else None
    return rows


async def write(rows: list[dict]) -> None:
    notes = {r["ext_id"]: r.pop("_note_ja", None) for r in rows}
    async with SessionFactory() as s:
        await s.execute(text("TRUNCATE TABLE grammar_point RESTART IDENTITY CASCADE"))
        await s.execute(GrammarPoint.__table__.insert(), rows)
        await s.commit()
    (DATA_DIR / "cefrj_notes_ja.json").write_text(
        __import__("json").dumps(notes, ensure_ascii=False, indent=1), encoding="utf-8"
    )
    print(f"grammar_point {len(rows)} 条入库；日文备考另存 cefrj_notes_ja.json 供翻译步骤取用")


# ─────────────── 翻译（FR-400b） ───────────────

BATCH = 20
TRANSLATE_SYSTEM = (
    "你在把英语语法点目录译成中文，读者是中国英语学习者。\n"
    "输入是若干条目，每条有 id、英文条目名、日文条目名、日文备考。\n"
    "输出 JSON：{\"items\":[{\"id\":\"...\",\"zh\":\"中文条目名\",\"note\":\"中文备考或空串\"}]}\n"
    "条目名要短、像教材目录里的标题（如「一般过去时否定句」「关系代词 who 作主语」），"
    "不要照抄英文语法术语的音译，不要加书名号。\n"
    "备考是对适用范围的限定说明（如「限于句首或连词之后、以问号结尾的句子」），"
    "照实翻译，没有就给空串。"
)


async def translate(limit: int) -> int:
    import json as _json

    notes_path = DATA_DIR / "cefrj_notes_ja.json"
    notes = _json.loads(notes_path.read_text(encoding="utf-8")) if notes_path.exists() else {}
    async with SessionFactory() as s:
        pending = (
            await s.execute(
                select(GrammarPoint)
                .where(GrammarPoint.item_zh.is_(None))
                .order_by(GrammarPoint.order_index)
                .limit(limit)
            )
        ).scalars().all()
        if not pending:
            print("全部已翻译")
            return 0
        print(f"待翻译 {len(pending)} 条，每批 {BATCH}")
        done = 0
        for i in range(0, len(pending), BATCH):
            chunk = pending[i : i + BATCH]
            payload = _json.dumps(
                {
                    "items": [
                        {
                            "id": p.ext_id,
                            "en": p.item,
                            "ja": p.item_ja,
                            "note_ja": notes.get(p.ext_id) or "",
                        }
                        for p in chunk
                    ]
                },
                ensure_ascii=False,
            )
            try:
                parsed, _model, _ms = await complete_json(
                    "translate-fast", TRANSLATE_SYSTEM, payload
                )
            except LLMUnavailable as exc:
                print(f"  LLM 不可用，已翻译 {done} 条后中止：{exc}")
                await s.commit()
                return done
            by_id = {str(it.get("id")): it for it in parsed.get("items", [])}
            for p in chunk:
                got = by_id.get(p.ext_id)
                if not got:
                    continue
                p.item_zh = (got.get("zh") or "").strip()[:256] or None
                p.note_zh = (got.get("note") or "").strip() or None
                done += 1
            await s.commit()
            print(f"  {min(i + BATCH, len(pending))}/{len(pending)}", end="\r")
    print()
    return done


async def check() -> None:
    async with SessionFactory() as s:
        total = (await s.execute(select(func.count()).select_from(GrammarPoint))).scalar_one()
        translated = (
            await s.execute(
                select(func.count()).select_from(GrammarPoint).where(GrammarPoint.item_zh.is_not(None))
            )
        ).scalar_one()
        by_cat = (
            await s.execute(
                select(GrammarPoint.category, func.count())
                .group_by(GrammarPoint.category)
                .order_by(func.count().desc())
            )
        ).all()
        by_level = (
            await s.execute(
                select(GrammarPoint.cefr_level, func.count())
                .group_by(GrammarPoint.cefr_level)
                .order_by(GrammarPoint.cefr_level)
            )
        ).all()
        no_level = (
            await s.execute(
                select(func.count()).select_from(GrammarPoint).where(GrammarPoint.cefr_level.is_(None))
            )
        ).scalar_one()
    print(f"grammar_point {total} 条  AC-100 要求 499 条全部入库")
    print(f"中文翻译完成 {translated}/{total}")
    print(f"无等级 {no_level}")
    print("按范畴：", {c or "?": n for c, n in by_cat})
    print("按等级：", {c or "?": n for c, n in by_level})


async def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--download", action="store_true")
    ap.add_argument("--translate", action="store_true")
    ap.add_argument("--limit", type=int, default=600)
    ap.add_argument("--check", action="store_true")
    args = ap.parse_args()

    if args.download:
        download()
    if args.check:
        await check()
        return
    if args.translate:
        n = await translate(args.limit)
        print(f"翻译 {n} 条")
        await check()
        return
    if not (DATA_DIR / XLSX_NAME).exists():
        print(f"缺 {XLSX_NAME}，先跑 --download")
        sys.exit(1)
    rows = build_rows()
    print(f"解析出 {len(rows)} 条")
    await write(rows)
    await check()


if __name__ == "__main__":
    asyncio.run(main())
