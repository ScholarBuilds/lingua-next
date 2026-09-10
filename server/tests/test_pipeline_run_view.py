"""GET /pipeline/runs 的 run 视图字段与按域过滤（P3b T3）。

任务中心把管线 run 与工坊任务、工作流 run 合并成一个列表，非视频域的历史 run
在没有实时帧时只能靠列表字段判断归属，`domain` / `subject_id` 缺一条就跳不到
`/pipeline/{domain}/{subject_id}`。
"""

from __future__ import annotations

from domain.models import PipelineRun, Video, Wordlist


async def _seed(session) -> dict[str, int]:
    """三个域各一条 run：视频域挂真实 video，另两域只有 subject_id。"""
    video = Video(title="Kurzgesagt: Black Holes", status="ready")
    deck = Wordlist(name="机场值机", kind="scenario", emoji="✈️")
    session.add_all([video, deck])
    await session.flush()

    runs = {
        "video": PipelineRun(
            domain="video", subject_id=video.id, video_id=video.id,
            kind="ingest", status="success",
        ),
        "scenario_deck": PipelineRun(
            domain="scenario_deck", subject_id=deck.id, kind="generate", status="success",
        ),
        "image_gen": PipelineRun(
            domain="image_gen", subject_id=907, kind="generate", status="failed",
        ),
    }
    session.add_all(list(runs.values()))
    await session.commit()
    return {
        "video_pk": video.id,
        "deck_pk": deck.id,
        **{f"{d}_run": r.id for d, r in runs.items()},
    }


async def test_run_view_carries_domain_and_subject_for_every_domain(client, session) -> None:
    """三个域的 run 都要带准确的 domain/subject_id，否则前端只能按视频域兜底。"""
    ids = await _seed(session)

    resp = await client.get("/pipeline/runs")
    assert resp.status_code == 200, resp.text
    items = {row["id"]: row for row in resp.json()["items"]}
    assert set(ids[k] for k in ("video_run", "scenario_deck_run", "image_gen_run")) <= set(items)

    video_row = items[ids["video_run"]]
    assert video_row["domain"] == "video"
    assert video_row["subject_id"] == ids["video_pk"]
    # 视频域的 video_id 是老调用方的入口，不能因为新增字段被挤掉
    assert video_row["video_id"] == ids["video_pk"]

    deck_row = items[ids["scenario_deck_run"]]
    assert deck_row["domain"] == "scenario_deck"
    assert deck_row["subject_id"] == ids["deck_pk"]
    assert deck_row["video_id"] is None

    image_row = items[ids["image_gen_run"]]
    assert image_row["domain"] == "image_gen"
    assert image_row["subject_id"] == 907
    assert image_row["video_id"] is None


async def test_runs_filter_by_domain(client, session) -> None:
    """按域过滤只回该域的 run，任务中心的域分区靠它做服务端筛选。"""
    ids = await _seed(session)

    for domain, run_key in (
        ("video", "video_run"),
        ("scenario_deck", "scenario_deck_run"),
        ("image_gen", "image_gen_run"),
    ):
        resp = await client.get("/pipeline/runs", params={"domain": domain})
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["total"] == 1
        assert [row["id"] for row in body["items"]] == [ids[run_key]]
        assert {row["domain"] for row in body["items"]} == {domain}

    empty = await client.get("/pipeline/runs", params={"domain": "no_such_domain"})
    assert empty.status_code == 200
    assert empty.json() == {"total": 0, "items": []}


async def test_video_pipeline_run_rows_carry_domain(client, session) -> None:
    """单视频页的 run 列表复用同一视图，字段要一致。"""
    ids = await _seed(session)

    resp = await client.get(f"/pipeline/videos/{ids['video_pk']}")
    assert resp.status_code == 200, resp.text
    body = resp.json()
    rows = body["runs"] + ([body["run"]] if body.get("run") else [])
    assert rows, "视频应至少有一条 run"
    for row in rows:
        assert row["domain"] == "video"
        assert row["subject_id"] == ids["video_pk"]
