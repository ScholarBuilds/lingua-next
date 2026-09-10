"""全库回填校验：逐条视频跑 `domain.pipeline_health.inspect` 并汇总。

检查逻辑不在本脚本里——它与入库末节点 `verify` 共用同一个体检模块（需求 09 v6
FR-80），避免"脚本一套标准、产品另一套标准"。脚本只负责批量跑与排版输出。
"""

import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from sqlalchemy import select  # noqa: E402

from app.db import SessionFactory  # noqa: E402
from domain.models import Video  # noqa: E402
from domain.pipeline_health import inspect  # noqa: E402

LEVEL_MARK = {"error": "✗", "warn": "!", "info": "·"}


async def main() -> None:
    rows: list[dict] = []
    problems: list[str] = []

    async with SessionFactory() as session:
        videos = (
            (await session.execute(select(Video).where(Video.file_key.is_not(None))))
            .scalars()
            .all()
        )
        for video in videos:
            report = await inspect(session, video.id)
            metrics = report["metrics"]
            rows.append({
                "id": video.id,
                "title": (video.title_zh or video.title)[:18],
                "status": video.status,
                "gate": report["gate"],
                "sents": metrics.get("sentences", 0),
                "units": metrics.get("units", 0),
                "noise": metrics.get("noise", 0),
                "zh": metrics.get("translated", 0),
                "phrases": metrics.get("with_phrases", 0),
                "over": metrics.get("over_limit", 0),
                "longest": metrics.get("longest_sentence", 0),
                "engine": metrics.get("align_engine") or "?",
            })
            for issue in report["issues"]:
                mark = LEVEL_MARK.get(issue["level"], "·")
                fix = f"（重跑 {issue['fix_step']}）" if issue["fix_step"] else ""
                problems.append(
                    f"{mark} [{video.id}] {video.title[:20]}：{issue['message']}{fix}"
                )

    print(f"{'id':>3} {'标题':<20} {'门禁':>8} {'句':>4} {'学习句':>6} {'噪声':>4} "
          f"{'已译':>4} {'有词组':>6} {'超限':>4} {'最长句':>6} {'对齐':>5}")
    for r in rows:
        print(
            f"{r['id']:>3} {r['title']:<20} {r['gate']:>8} {r['sents']:>4} {r['units']:>6} "
            f"{r['noise']:>4} {r['zh']:>4} {r['phrases']:>6} {r['over']:>4} "
            f"{r['longest']:>6} {r['engine']:>5}"
        )

    total_u = sum(r["units"] for r in rows) or 1
    total_over = sum(r["over"] for r in rows)
    degraded = [r for r in rows if r["gate"] != "ready"]
    print(
        f"\n合计 {len(rows)} 条视频：{sum(r['sents'] for r in rows)} 语法句 / "
        f"{sum(r['units'] for r in rows)} 学习句 / 超限 {total_over}（{total_over / total_u:.1%}）"
    )
    print(f"门禁未过 {len(degraded)} 条" if degraded else "门禁全过 ✓")
    if problems:
        print(f"\n问题 {len(problems)} 项：")
        for p in problems:
            print("  ", p)


if __name__ == "__main__":
    asyncio.run(main())
