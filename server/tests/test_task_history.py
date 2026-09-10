from datetime import UTC, datetime, timedelta

from domain.models import PipelineRun, StudioFlowRun
from domain.studio_tasks import new_task


async def test_summary_and_history_include_old_tasks_and_deduplicate_pipeline(client, session):
    now = datetime.now(UTC)
    for index in range(201):
        task = new_task(tool_id="image", task_type="generate", invocation={"image_job_id": index})
        task.status = "failed" if index == 0 else "succeeded"
        task.created_at = now + timedelta(seconds=index)
        session.add(task)
    for index in range(101):
        session.add(
            StudioFlowRun(
                id=f"flow-{index}",
                flow_version=1,
                definition_snapshot={"nodes": []},
                status="running" if index == 0 else "succeeded",
                created_at=now + timedelta(seconds=index),
            )
        )
    for index in range(61):
        session.add(
            PipelineRun(
                domain="video",
                subject_id=index,
                status="failed" if index == 0 else "success",
                created_at=now + timedelta(seconds=index),
            )
        )
    session.add(PipelineRun(domain="image_gen", subject_id=0, status="failed"))
    await session.commit()
    summary = await client.get("/studio/tasks/summary")
    assert summary.status_code == 200, summary.text
    assert summary.json() == {"active": 1, "attention": 2, "total": 363}
    failed = await client.get("/studio/tasks/history?scope=failed")
    assert failed.status_code == 200, failed.text
    assert len(failed.json()["tasks"]) == len(failed.json()["pipeline"]) == 1
    seen = set()
    cursor = None
    while True:
        response = await client.get(
            "/studio/tasks/history", params={"limit": 100, **({"cursor": cursor} if cursor else {})}
        )
        assert response.status_code == 200, response.text
        data = response.json()
        for kind in ["tasks", "flows"]:
            dates = [row["created_at"] for row in data[kind]]
            assert dates == sorted(dates, reverse=True)
        for kind in ["tasks", "flows", "pipeline"]:
            for row in data[kind]:
                identity = (kind, str(row["id"]))
                assert identity not in seen
                seen.add(identity)
        cursor = data["next_cursor"]
        if not cursor:
            break
    assert len(seen) == 363
    focused = await client.get("/studio/tasks/history", params={"identity": "flow:flow-0"})
    assert [row["id"] for row in focused.json()["flows"]] == ["flow-0"]
    assert focused.json()["tasks"] == []
    for params in [{"cursor": "invalid"}, {"identity": "unknown:1"}, {"limit": 101}]:
        assert (await client.get("/studio/tasks/history", params=params)).status_code == 422
