"""服务端画布 projector：任务终态落图、骨架重建、幂等并集、级联落图、SSE canvas 帧。"""

from __future__ import annotations

import json
from datetime import UTC, datetime, timedelta

from domain import canvas_projector, task_event_stream
from domain.canvas_projector import (
    BRANCH_GAP,
    EMPTY_NODE_W,
    IMAGE_NODE_W,
    canvas_event_view,
    merge_items,
    project_flow_run,
    project_task,
    video_result_items,
    workflow_output_node_id,
    workflow_result_items,
)
from domain.models import StudioCanvas, StudioFlowRun, StudioTask
from domain.studio import list_canvases_updated_since
from domain.studio_flows import advance_flow_run, new_inline_flow_run
from domain.studio_tasks import new_task, transition
from domain.task_event_stream import KEEP_ALIVE_FRAME, iter_sse_frames
from worker.tasks import run_studio_flow, studio_task_job

# ---- 夹具 ----


def _canvas(nodes: list[dict], connections: list[dict] | None = None) -> StudioCanvas:
    return StudioCanvas(
        title="投影测试",
        nodes=nodes,
        connections=connections or [],
        version=1,
        updated_at=datetime.now(UTC) - timedelta(minutes=5),
    )


def _image_node(node_id: str, **extra) -> dict:
    return {"id": node_id, "type": "image", "x": 100, "y": 50, "w": 360, "items": [], **extra}


def _workflow_node(**extra) -> dict:
    return {
        "id": "wf",
        "type": "workflow",
        "x": 10,
        "y": 20,
        "w": 340,
        "title": "分镜",
        "workflow_timeline": {
            "kind": "minimax",
            "segments": [{"id": "s1", "start": 0, "length": 5, "prompt": "a", "type": "text"}],
        },
        **extra,
    }


def _finished_task(
    task_type: str,
    *,
    context: dict,
    result: dict,
    status: str = "succeeded",
) -> StudioTask:
    task = new_task(tool_id="infinite-canvas", task_type=task_type, source_context=context)
    transition(task, "running", stage="test")
    transition(task, status, stage="completed", result=result)
    return task


def _node(canvas: StudioCanvas, node_id: str) -> dict:
    return next(node for node in canvas.nodes if node["id"] == node_id)


def _asset_ids(canvas: StudioCanvas, node_id: str) -> list[int]:
    return [item["asset_id"] for item in _node(canvas, node_id)["items"]]


async def _save(session, canvas: StudioCanvas, nodes: list[dict]) -> None:
    """模拟路由层的内容保存：换文档、version += 1、updated_at 刷新，不动 settings.projector。"""
    canvas.nodes = nodes
    canvas.version += 1
    canvas.updated_at = datetime.now(UTC)
    await session.commit()


def _parse(frame: str) -> dict:
    fields: dict = {}
    for line in frame.rstrip("\n").split("\n"):
        key, _, value = line.partition(": ")
        fields[key] = value
    if "data" in fields:
        fields["data"] = json.loads(fields["data"])
    return fields


class _Stopper:
    def __init__(self, polls: int) -> None:
        self.remaining = polls

    async def __call__(self) -> bool:
        self.remaining -= 1
        return self.remaining < 0


async def _no_sleep(_seconds: float) -> None:
    return None


class FakeQueue:
    def __init__(self) -> None:
        self.calls: list[tuple] = []

    async def enqueue_job(self, *args, **kwargs):
        self.calls.append((args, kwargs))


# ---- 条目映射与并集 ----


def test_merge_items_unions_by_asset_media_or_url() -> None:
    existing = [
        {"asset_id": 1, "kind": "image"},
        {"kind": "video", "media_asset_id": 7, "url": "/api/studio/media-assets/7/content"},
        {"kind": "file", "url": "https://x/a.bin"},
    ]
    incoming = [
        {"asset_id": 1, "kind": "image"},
        {"asset_id": 2, "kind": "image"},
        {"kind": "video", "media_asset_id": 7, "url": "/other"},
        {"kind": "file", "url": "https://x/a.bin"},
        {"kind": "file", "url": "https://x/b.bin"},
    ]
    merged = merge_items(existing, incoming)
    assert [canvas_projector.item_key(item) for item in merged] == [
        "a1", "m7", "uhttps://x/a.bin", "a2", "uhttps://x/b.bin",
    ]
    # 先到的保留原对象，后到的同键条目不覆盖
    assert merged[1]["url"] == "/api/studio/media-assets/7/content"


def test_video_and_workflow_items_follow_frontend_field_shape() -> None:
    result = {
        "items": [
            {
                "kind": "video",
                "media_asset_id": 12,
                "url": "/api/studio/media-assets/12/content",
                "poster_url": None,
                "name": "clip.mp4",
                "mime": "video/mp4",
                "duration_ms": 5000,
                "width": 1280,
                "height": 720,
                "bytes": 1,
            },
            {"kind": "video", "media_asset_id": 13},
            {"kind": "image", "id": 5, "width": 1024, "height": 1024, "url": "/x"},
            {"kind": "audio", "id": "9", "url": "/api/studio/media-assets/9/content"},
            {"kind": "text", "url": "/nope"},
        ]
    }
    assert video_result_items(result) == [
        {
            "kind": "video",
            "media_asset_id": 12,
            "url": "/api/studio/media-assets/12/content",
            "poster_url": None,
            "name": "clip.mp4",
            "mime": "video/mp4",
            "duration_ms": 5000,
            "w": 1280,
            "h": 720,
        }
    ]
    assert workflow_result_items(result) == [
        {
            "kind": "video",
            "media_asset_id": 12,
            "url": "/api/studio/media-assets/12/content",
            "poster_url": None,
            "name": "clip.mp4",
            "mime": "video/mp4",
            "duration_ms": 5000,
            "w": 1280,
            "h": 720,
        },
        {"kind": "image", "asset_id": 5, "w": 1024, "h": 1024},
        {
            "kind": "audio",
            "media_asset_id": 9,
            "url": "/api/studio/media-assets/9/content",
            "poster_url": None,
            "duration_ms": None,
        },
    ]


# ---- 图片任务落图 ----


async def test_image_task_lands_on_existing_node_and_records_projection(session) -> None:
    canvas = _canvas([_image_node("n1")])
    session.add(canvas)
    await session.commit()
    before = canvas.updated_at
    task = _finished_task(
        "image.generate",
        context={"canvas_id": canvas.id, "node_id": "n1"},
        result={"run_id": "r1", "asset_ids": [11, 12]},
    )
    session.add(task)
    await session.commit()

    projection = await project_task(session, task)

    assert projection is not None
    assert projection.canvas_id == canvas.id and projection.version == 2
    await session.refresh(canvas)
    assert canvas.version == 2
    # SQLite 读回来的是 naive datetime，比较前统一去掉时区
    assert canvas.updated_at.replace(tzinfo=None) > before.replace(tzinfo=None)
    assert _node(canvas, "n1")["items"] == [
        {"asset_id": 11, "kind": "image"},
        {"asset_id": 12, "kind": "image"},
    ]
    assert canvas.settings["projector"] == {
        "version": 2,
        "at": projection.updated_at.isoformat(),
        "landed": [{"node_id": "n1", "task_id": task.id, "flow_run_id": None, "added": 2}],
    }


async def test_image_task_rebuilds_node_from_planned_snapshot(session) -> None:
    canvas = _canvas([_image_node("src", prompt_draft="a cat")])
    session.add(canvas)
    await session.commit()
    planned = {
        "id": "branch",
        "type": "output",
        "x": 540,
        "y": 50,
        "w": 360,
        "title": "图片输出",
        "items": [],
        "pending": True,
        "cascade_status": "running",
    }
    task = _finished_task(
        "image.edit",
        context={
            "canvas_id": canvas.id,
            "node_id": "branch",
            "source_node_id": "src",
            "planned_node": planned,
            "pending_target": True,
        },
        result={"asset_ids": [21]},
    )
    session.add(task)
    await session.commit()

    assert await project_task(session, task) is not None

    await session.refresh(canvas)
    branch = _node(canvas, "branch")
    assert branch["type"] == "output" and (branch["x"], branch["y"]) == (540, 50)
    assert branch["items"] == [{"asset_id": 21, "kind": "image"}]
    # 运行态字段按 studio.RUNTIME_KEYS 剥掉（BR-143）；cascade_* 不在黑名单里，与 PUT 保存口径一致
    assert "pending" not in branch and branch["cascade_status"] == "running"
    assert canvas.connections == [{"from": "src", "to": "branch", "kind": "flow"}]


async def test_planned_snapshot_is_ignored_when_id_or_type_mismatch(session) -> None:
    canvas = _canvas([])
    session.add(canvas)
    await session.commit()
    task = _finished_task(
        "image.generate",
        context={
            "canvas_id": canvas.id,
            "node_id": "branch",
            "planned_node": {"id": "other", "type": "image", "x": 0, "y": 0},
        },
        result={"asset_ids": [1]},
    )
    session.add(task)
    await session.commit()

    assert await project_task(session, task) is None
    await session.refresh(canvas)
    assert canvas.version == 1 and canvas.nodes == []


async def test_image_task_births_node_beside_source_when_no_plan(session) -> None:
    source = _image_node(
        "src",
        prompt_draft="sunset",
        prompt_draft_refs=[3],
        run_settings={"quality": "high"},
        video_settings={"duration": 5},
    )
    del source["w"]
    canvas = _canvas([source])
    session.add(canvas)
    await session.commit()
    task = _finished_task(
        "image.generate",
        context={
            "canvas_id": canvas.id,
            "node_id": "out",
            "source_node_id": "src",
            "pending_target": True,
        },
        result={"asset_ids": [31]},
    )
    session.add(task)
    await session.commit()

    assert await project_task(session, task) is not None

    await session.refresh(canvas)
    born = _node(canvas, "out")
    assert born["type"] == "output"
    assert born["x"] == 100 + IMAGE_NODE_W + BRANCH_GAP and born["y"] == 50
    # 源节点没存 w：位置按 IMAGE_NODE_W 算，自身宽度按空节点默认补
    assert born["w"] == EMPTY_NODE_W
    assert born["title"] == "图片输出"
    assert born["prompt_draft"] == "sunset" and born["prompt_draft_refs"] == [3]
    assert born["run_settings"] == {"quality": "high"}
    assert "video_settings" not in born
    assert born["items"] == [{"asset_id": 31, "kind": "image"}]
    assert canvas.connections == [{"from": "src", "to": "out", "kind": "flow"}]


async def test_image_task_without_source_or_plan_lands_nowhere(session) -> None:
    canvas = _canvas([_image_node("src")])
    session.add(canvas)
    await session.commit()
    task = _finished_task(
        "image.generate",
        context={"canvas_id": canvas.id, "node_id": "ghost", "source_node_id": "missing"},
        result={"asset_ids": [1]},
    )
    session.add(task)
    await session.commit()

    assert await project_task(session, task) is None
    await session.refresh(canvas)
    assert canvas.version == 1


async def test_projection_is_idempotent_and_unions_by_asset_id(session) -> None:
    canvas = _canvas([_image_node("n1", items=[{"asset_id": 5, "kind": "image"}])])
    session.add(canvas)
    await session.commit()
    task = _finished_task(
        "image.generate",
        context={"canvas_id": canvas.id, "node_id": "n1"},
        result={"asset_ids": [5, 6]},
        status="partial",
    )
    session.add(task)
    await session.commit()

    first = await project_task(session, task)
    assert first is not None and first.landed[0].added == 1
    await session.refresh(canvas)
    assert _asset_ids(canvas, "n1") == [5, 6]
    assert canvas.version == 2
    record = dict(canvas.settings["projector"])

    # 同一任务再投影：不追加、不 bump、settings.projector 原样
    assert await project_task(session, task) is None
    await session.refresh(canvas)
    assert _asset_ids(canvas, "n1") == [5, 6]
    assert canvas.version == 2
    assert canvas.settings["projector"] == record


async def test_non_canvas_or_unfinished_tasks_are_skipped(session) -> None:
    canvas = _canvas([_image_node("n1")])
    session.add(canvas)
    await session.commit()
    chat = _finished_task(
        "chat.general",
        context={"canvas_id": canvas.id, "node_id": "n1"},
        result={"text": "hi"},
    )
    running = new_task(
        tool_id="infinite-canvas",
        task_type="image.generate",
        source_context={"canvas_id": canvas.id, "node_id": "n1"},
    )
    transition(running, "running")
    modal = _finished_task(
        "midjourney.generate",
        context={"canvas_id": canvas.id, "node_id": "n1"},
        result={"asset_ids": [], "modal_required": True},
    )
    session.add_all([chat, running, modal])
    await session.commit()

    for task in (chat, running, modal):
        assert await project_task(session, task) is None
    await session.refresh(canvas)
    assert canvas.version == 1 and _node(canvas, "n1")["items"] == []


async def test_existing_node_of_wrong_type_is_left_alone(session) -> None:
    canvas = _canvas([{"id": "p1", "type": "prompt", "x": 0, "y": 0, "text": "x"}])
    session.add(canvas)
    await session.commit()
    task = _finished_task(
        "image.generate",
        context={"canvas_id": canvas.id, "node_id": "p1"},
        result={"asset_ids": [1]},
    )
    session.add(task)
    await session.commit()

    assert await project_task(session, task) is None


# ---- 视频与工作流 ----


async def test_video_task_merges_by_media_asset_id(session) -> None:
    existing = {"kind": "video", "media_asset_id": 7, "url": "/api/studio/media-assets/7/content"}
    canvas = _canvas([{"id": "v1", "type": "video", "x": 0, "y": 0, "w": 360, "items": [existing]}])
    session.add(canvas)
    await session.commit()
    task = _finished_task(
        "video.generate",
        context={"canvas_id": canvas.id, "node_id": "v1"},
        result={
            "items": [
                {"kind": "video", "media_asset_id": 7, "url": "/api/studio/media-assets/7/content"},
                {
                    "kind": "video",
                    "media_asset_id": 8,
                    "url": "/api/studio/media-assets/8/content",
                    "poster_url": "/api/studio/media-assets/8/poster",
                    "duration_ms": 4000,
                },
            ]
        },
    )
    session.add(task)
    await session.commit()

    projection = await project_task(session, task)
    assert projection is not None and projection.landed[0].added == 1
    await session.refresh(canvas)
    items = _node(canvas, "v1")["items"]
    assert [item["media_asset_id"] for item in items] == [7, 8]
    assert items[1]["poster_url"] == "/api/studio/media-assets/8/poster"
    assert items[1]["duration_ms"] == 4000


async def test_workflow_task_spawns_output_nodes_per_kind_once(session) -> None:
    workflow = {
        "id": "wf",
        "type": "workflow",
        "x": 10,
        "y": 20,
        "w": 340,
        "title": "分镜",
        "workflow_timeline": {
            "kind": "minimax",
            "segments": [{"id": "s1", "start": 0, "length": 5, "prompt": "a", "type": "text"}],
        },
    }
    canvas = _canvas([workflow])
    session.add(canvas)
    await session.commit()
    video = {"kind": "video", "media_asset_id": 3, "url": "/api/studio/media-assets/3/content"}
    task = _finished_task(
        "workflow.minimax",
        context={"canvas_id": canvas.id, "node_id": "wf", "workflow_segment_id": "s1"},
        result={
            "items": [
                {"kind": "image", "asset_id": 41, "width": 1024, "height": 1024},
                {"kind": "image", "asset_id": 42, "width": 1024, "height": 1024},
                video,
            ]
        },
    )
    session.add(task)
    await session.commit()

    projection = await project_task(session, task)
    assert projection is not None and projection.landed[0].added == 3

    await session.refresh(canvas)
    node = _node(canvas, "wf")
    assert node["completed_task_ids"] == [task.id]
    assert node["workflow_timeline"]["segments"][0]["result"] == {
        **video, "poster_url": None, "duration_ms": None,
    }
    image_out = _node(canvas, workflow_output_node_id(task.id, "image"))
    video_out = _node(canvas, workflow_output_node_id(task.id, "video"))
    assert image_out["type"] == "output" and image_out["title"] == "分镜 · 图片"
    assert (image_out["x"], image_out["y"]) == (10 + 340 + BRANCH_GAP, 20)
    assert [item["asset_id"] for item in image_out["items"]] == [41, 42]
    assert (video_out["x"], video_out["y"]) == (10 + 340 + BRANCH_GAP + 26, 20 + 210)
    assert video_out["title"] == "分镜 · 视频"
    assert canvas.connections == [
        {"from": "wf", "to": image_out["id"], "kind": "flow"},
        {"from": "wf", "to": video_out["id"], "kind": "flow"},
    ]
    assert canvas.version == 2

    # 产物节点已按定值 id 落过：再投影不会再生一组 output 节点
    assert await project_task(session, task) is None
    await session.refresh(canvas)
    assert len(canvas.nodes) == 3 and canvas.version == 2


async def test_workflow_output_lands_when_frontend_wrote_completed_first(session) -> None:
    """前端对带 canvas_id 的任务只写 completed_task_ids，产物节点仍得由 projector 建出来。"""
    canvas = _canvas([_workflow_node()])
    session.add(canvas)
    await session.commit()
    task = _finished_task(
        "workflow.minimax",
        context={"canvas_id": canvas.id, "node_id": "wf", "workflow_segment_id": "s1"},
        result={"items": [{"kind": "image", "asset_id": 41, "width": 1024, "height": 1024}]},
    )
    session.add(task)
    await session.commit()
    landed_item = {"kind": "image", "asset_id": 41, "w": 1024, "h": 1024}
    # 浏览器 450ms 防抖保存抢在投影前面落库：completed_task_ids 与 timeline 都写了，产物节点没建
    await _save(
        session,
        canvas,
        [
            _workflow_node(
                completed_task_ids=[task.id],
                workflow_timeline={
                    "kind": "minimax",
                    "segments": [
                        {
                            "id": "s1", "start": 0, "length": 5, "prompt": "a", "type": "text",
                            "result": landed_item,
                        }
                    ],
                },
            )
        ],
    )

    projection = await project_task(session, task)

    assert projection is not None and projection.landed[0].added == 1
    await session.refresh(canvas)
    image_out = _node(canvas, workflow_output_node_id(task.id, "image"))
    assert image_out["type"] == "output" and image_out["items"] == [landed_item]
    assert (image_out["x"], image_out["y"]) == (10 + 340 + BRANCH_GAP, 20)
    assert canvas.connections == [{"from": "wf", "to": image_out["id"], "kind": "flow"}]
    # completed_task_ids 缺则补：已含 task.id 就不重复追加
    assert _node(canvas, "wf")["completed_task_ids"] == [task.id]
    assert canvas.version == 3

    # 连跑第二次：节点已在，不重复建、不 bump version
    assert await project_task(session, task) is None
    await session.refresh(canvas)
    assert len(canvas.nodes) == 2 and canvas.version == 3


async def test_workflow_skips_kind_already_held_by_a_random_id_node(session) -> None:
    canvas = _canvas([_workflow_node()])
    session.add(canvas)
    await session.commit()
    video = {"kind": "video", "media_asset_id": 3, "url": "/api/studio/media-assets/3/content"}
    task = _finished_task(
        "workflow.minimax",
        context={"canvas_id": canvas.id, "node_id": "wf", "workflow_segment_id": "s1"},
        result={
            "items": [{"kind": "image", "asset_id": 41, "width": 1024, "height": 1024}, video],
        },
    )
    session.add(task)
    await session.commit()
    # 前端建的产物节点是随机 id，只能按 asset_id / media_asset_id 认出来
    await _save(
        session,
        canvas,
        [
            _workflow_node(completed_task_ids=[task.id]),
            {
                "id": "rnd-1",
                "type": "output",
                "x": 430,
                "y": 20,
                "w": 316,
                "items": [{"kind": "image", "asset_id": 41, "w": 1024, "h": 1024}],
            },
        ],
    )

    projection = await project_task(session, task)

    # 图片那组画布上已有，只补视频
    assert projection is not None and projection.landed[0].added == 1
    await session.refresh(canvas)
    assert not any(node["id"] == workflow_output_node_id(task.id, "image") for node in canvas.nodes)
    video_out = _node(canvas, workflow_output_node_id(task.id, "video"))
    assert video_out["items"] == [{**video, "poster_url": None, "duration_ms": None}]
    # 跳过的图片组照样占位，视频节点落在第二格
    assert (video_out["x"], video_out["y"]) == (10 + 340 + BRANCH_GAP + 26, 20 + 210)
    assert canvas.connections == [{"from": "wf", "to": video_out["id"], "kind": "flow"}]

    assert await project_task(session, task) is None
    await session.refresh(canvas)
    assert len(canvas.nodes) == 3


async def test_workflow_lands_nothing_new_when_every_kind_is_covered(session) -> None:
    """产物全在画布上了：只补 completed_task_ids 与 timeline，added 记 0。"""
    video = {"kind": "video", "media_asset_id": 3, "url": "/api/studio/media-assets/3/content"}
    canvas = _canvas(
        [
            _workflow_node(),
            {
                "id": "rnd-1",
                "type": "output",
                "x": 430,
                "y": 20,
                "w": 316,
                "items": [{"kind": "image", "asset_id": 41, "w": 1024, "h": 1024}, video],
            },
        ]
    )
    session.add(canvas)
    await session.commit()
    task = _finished_task(
        "workflow.minimax",
        context={"canvas_id": canvas.id, "node_id": "wf", "workflow_segment_id": "s1"},
        result={
            "items": [{"kind": "image", "asset_id": 41, "width": 1024, "height": 1024}, video],
        },
    )
    session.add(task)
    await session.commit()

    projection = await project_task(session, task)

    assert projection is not None and projection.landed[0].added == 0
    await session.refresh(canvas)
    assert len(canvas.nodes) == 2 and canvas.connections == []
    node = _node(canvas, "wf")
    assert node["completed_task_ids"] == [task.id]
    assert node["workflow_timeline"]["segments"][0]["result"] == {
        **video, "poster_url": None, "duration_ms": None,
    }

    assert await project_task(session, task) is None
    await session.refresh(canvas)
    assert canvas.version == 2


# ---- 级联 ----


def _cascade_run(
    canvas_id: int, *, checkpoint: dict, node_map: dict, contexts: dict
) -> StudioFlowRun:
    return StudioFlowRun(
        id="run-cascade",
        flow_id=None,
        parent_run_id=None,
        flow_version=1,
        definition_snapshot={
            "nodes": [
                {
                    "id": node_id,
                    "tool_id": "infinite-canvas",
                    "operation": "image.generate",
                    "input": {},
                    "source_context": contexts.get(node_id, {}),
                }
                for node_id in checkpoint
            ],
            "edges": [],
        },
        inputs={},
        source_context={"kind": "canvas_cascade", "canvas_id": canvas_id, "node_map": node_map},
        checkpoint={"version": 1, "nodes": checkpoint},
        status="running",
    )


async def test_cascade_projects_each_checkpoint_node_to_its_target(session) -> None:
    canvas = _canvas([_image_node("src"), _image_node("t1")])
    session.add(canvas)
    await session.commit()
    shared = {"asset_ids": [91]}
    run = _cascade_run(
        canvas.id,
        checkpoint={
            "a": {"status": "succeeded", "task_id": "task-x", "result": shared},
            "b": {"status": "partial", "task_id": "task-x", "result": shared},
            "c": {"status": "running", "task_id": "task-y", "result": {"asset_ids": [92]}},
            "d": {"status": "succeeded", "task_id": "task-z", "result": {"asset_ids": [93]}},
        },
        node_map={
            "a": {"canvas_node_id": "src", "target_node_id": "t1", "round": 1, "label": "a"},
            "b": {"canvas_node_id": "src", "target_node_id": "t2", "round": 2, "label": "b"},
            "c": {"canvas_node_id": "src", "target_node_id": "t1", "round": 3, "label": "c"},
            # d 的落点不在画布里，也没有可重建的骨架
            "d": {"canvas_node_id": "src", "target_node_id": "ghost", "round": 4, "label": "d"},
        },
        contexts={
            "b": {
                "canvas_id": canvas.id,
                "node_id": "t2",
                "source_node_id": "src",
                "planned_node": {"id": "t2", "type": "output", "x": 900, "y": 50, "items": []},
                "pending_target": True,
            }
        },
    )
    session.add(run)
    await session.commit()

    projection = await project_flow_run(session, run)

    assert projection is not None and projection.version == 2
    assert [entry.view() for entry in projection.landed] == [
        {"node_id": "t1", "task_id": "task-x", "flow_run_id": run.id, "added": 1},
        {"node_id": "t2", "task_id": "task-x", "flow_run_id": run.id, "added": 1},
    ]
    await session.refresh(canvas)
    assert _asset_ids(canvas, "t1") == [91]
    assert _asset_ids(canvas, "t2") == [91]
    assert _node(canvas, "t2")["w"] == EMPTY_NODE_W
    assert canvas.connections == [{"from": "src", "to": "t2", "kind": "flow"}]
    assert not any(node["id"] == "ghost" for node in canvas.nodes)

    # 只看指定节点 + 已落过的不再动
    assert await project_flow_run(session, run, node_ids=["a"]) is None
    await session.refresh(canvas)
    assert canvas.version == 2


async def test_cascade_run_without_canvas_context_is_ignored(session) -> None:
    run = new_inline_flow_run(
        {
            "nodes": [
                {"id": "n", "tool_id": "infinite-canvas", "operation": "image.generate",
                 "input": {"prompt": "x"}},
            ],
            "edges": [],
        },
        inputs={},
    )
    run.checkpoint = {
        "version": 1,
        "nodes": {"n": {"status": "succeeded", "task_id": "t", "result": {"asset_ids": [1]}}},
    }
    session.add(run)
    await session.commit()
    assert await project_flow_run(session, run) is None


async def test_flow_advance_reports_newly_succeeded_nodes(session) -> None:
    run = new_inline_flow_run(
        {
            "nodes": [
                {"id": "draft", "tool_id": "infinite-canvas", "operation": "image.generate",
                 "input": {"prompt": "山"}},
            ],
            "edges": [],
        },
        inputs={},
    )
    session.add(run)
    await session.commit()

    first = await advance_flow_run(session, FakeQueue(), run.id)
    assert first.completed_node_ids == ()
    task = await session.get(StudioTask, first.started_task_ids[0])
    assert task is not None
    transition(task, "running", stage="test")
    transition(task, "succeeded", stage="completed", result={"asset_ids": [7]})
    await session.commit()

    second = await advance_flow_run(session, FakeQueue(), run.id)
    assert second.run.status == "succeeded"
    assert second.completed_node_ids == ("draft",)
    # 终态 run 再 tick：没有新完成的节点
    third = await advance_flow_run(session, FakeQueue(), run.id)
    assert third.completed_node_ids == ()


# ---- worker 接线 ----


async def test_worker_shell_projects_finished_task(session, session_factory, monkeypatch) -> None:
    monkeypatch.setattr("worker.tasks.SessionFactory", session_factory)
    canvas = _canvas([_image_node("n1")])
    session.add(canvas)
    await session.commit()
    task = new_task(
        tool_id="infinite-canvas",
        task_type="image.generate",
        source_context={"canvas_id": canvas.id, "node_id": "n1"},
    )
    session.add(task)
    await session.commit()

    @studio_task_job()
    async def body(ctx: dict, task_id: str) -> dict:
        async with session_factory() as inner:
            row = await inner.get(StudioTask, task_id)
            transition(row, "running", stage="test")
            transition(row, "succeeded", stage="completed", result={"asset_ids": [77]})
            await inner.commit()
        return {"ok": True}

    assert await body({}, task.id) == {"ok": True}

    await session.refresh(canvas)
    assert _asset_ids(canvas, "n1") == [77]
    assert canvas.version == 2
    assert canvas.settings["projector"]["landed"][0]["task_id"] == task.id


async def test_worker_shell_keeps_task_terminal_when_projector_fails(
    session, session_factory, monkeypatch
) -> None:
    monkeypatch.setattr("worker.tasks.SessionFactory", session_factory)

    async def broken(_session, _task):
        raise RuntimeError("canvas locked forever")

    monkeypatch.setattr("worker.tasks.project_task", broken)
    canvas = _canvas([_image_node("n1")])
    session.add(canvas)
    await session.commit()
    task = new_task(
        tool_id="infinite-canvas",
        task_type="image.generate",
        source_context={"canvas_id": canvas.id, "node_id": "n1"},
    )
    session.add(task)
    await session.commit()

    @studio_task_job()
    async def body(ctx: dict, task_id: str) -> dict:
        async with session_factory() as inner:
            row = await inner.get(StudioTask, task_id)
            transition(row, "running", stage="test")
            transition(row, "succeeded", stage="completed", result={"asset_ids": [1]})
            await inner.commit()
        return {"ok": True, "task_id": task_id}

    assert await body({}, task.id) == {"ok": True, "task_id": task.id}

    await session.refresh(task)
    await session.refresh(canvas)
    assert task.status == "succeeded" and task.result == {"asset_ids": [1]}
    assert canvas.version == 1 and _node(canvas, "n1")["items"] == []


async def test_flow_tick_projects_cascade_outputs(session, session_factory, monkeypatch) -> None:
    monkeypatch.setattr("worker.tasks.SessionFactory", session_factory)
    canvas = _canvas([_image_node("src")])
    session.add(canvas)
    await session.commit()
    run = new_inline_flow_run(
        {
            "nodes": [
                {
                    "id": "draft",
                    "tool_id": "infinite-canvas",
                    "operation": "image.generate",
                    "input": {"prompt": "山"},
                    "source_context": {
                        "canvas_id": canvas.id,
                        "node_id": "t1",
                        "source_node_id": "src",
                        "pending_target": True,
                    },
                }
            ],
            "edges": [],
        },
        inputs={},
        source_context={
            "kind": "canvas_cascade",
            "canvas_id": canvas.id,
            "node_map": {
                "draft": {"canvas_node_id": "src", "target_node_id": "t1", "round": 1, "label": "x"}
            },
        },
    )
    session.add(run)
    await session.commit()
    queue = FakeQueue()

    first = await run_studio_flow({"redis": queue}, run.id)
    assert first["status"] == "running" and len(first["started_task_ids"]) == 1
    await session.refresh(canvas)
    assert canvas.version == 1, "节点还没完成，画布不该动"

    task = await session.get(StudioTask, first["started_task_ids"][0])
    assert task is not None
    transition(task, "running", stage="test")
    transition(task, "succeeded", stage="completed", result={"asset_ids": [55]})
    await session.commit()

    second = await run_studio_flow({"redis": queue}, run.id)
    assert second["status"] == "succeeded"
    await session.refresh(canvas)
    assert canvas.version == 2
    target = _node(canvas, "t1")
    assert target["type"] == "output" and target["items"] == [{"asset_id": 55, "kind": "image"}]
    assert target["x"] == 100 + 360 + BRANCH_GAP
    assert canvas.settings["projector"]["landed"] == [
        {"node_id": "t1", "task_id": task.id, "flow_run_id": run.id, "added": 1}
    ]


# ---- SSE canvas 帧 ----


def test_canvas_event_view_distinguishes_projector_from_save() -> None:
    stamp = datetime(2026, 8, 22, 10, 0, tzinfo=UTC)
    landed = [{"node_id": "n1", "task_id": "t", "flow_run_id": None, "added": 1}]
    projected = StudioCanvas(
        id=3, version=4, updated_at=stamp,
        settings={"projector": {"version": 4, "at": stamp.isoformat(), "landed": landed}},
    )
    assert canvas_event_view(projected) == {
        "canvas_id": 3,
        "version": 4,
        "updated_at": stamp.isoformat(),
        "origin": "projector",
        "landed": landed,
    }
    # 浏览器保存把 version 推到 5，settings.projector 仍记着 4：这一版是 save
    saved = StudioCanvas(
        id=3, version=5, updated_at=stamp,
        settings={"projector": {"version": 4, "at": stamp.isoformat(), "landed": landed}},
    )
    assert canvas_event_view(saved)["origin"] == "save"
    assert canvas_event_view(saved)["landed"] == []
    assert canvas_event_view(StudioCanvas(id=9, version=1, updated_at=None))["origin"] == "save"


async def test_list_canvases_updated_since_respects_window(session) -> None:
    old = _canvas([])
    session.add(old)
    await session.commit()
    now = datetime.now(UTC)
    assert await list_canvases_updated_since(session, since=now - timedelta(minutes=10)) == [old]
    assert await list_canvases_updated_since(session, since=now - timedelta(minutes=1)) == []


async def test_stream_emits_canvas_frames_with_origin_and_dedupes_versions(
    session_factory,
) -> None:
    async with session_factory() as session:
        canvas = _canvas([_image_node("n1")])
        session.add(canvas)
        await session.commit()
        canvas_id = canvas.id

    sleeps = 0

    async def sleep(_seconds: float) -> None:
        nonlocal sleeps
        sleeps += 1
        async with session_factory() as session:
            row = await session.get(StudioCanvas, canvas_id)
            if sleeps == 1:
                await _save(session, row, [_image_node("n1"), _image_node("n2")])
            elif sleeps == 2:
                task = _finished_task(
                    "image.generate",
                    context={"canvas_id": canvas_id, "node_id": "n2"},
                    result={"asset_ids": [8]},
                )
                session.add(task)
                await session.commit()
                assert await project_task(session, task) is not None

    raw = [
        frame
        async for frame in iter_sse_frames(
            session_factory, should_stop=_Stopper(4), sleep=sleep
        )
    ]
    frames = [_parse(frame) for frame in raw if frame != KEEP_ALIVE_FRAME]
    canvas_frames = [f for f in frames if f.get("event") == "canvas"]
    assert all("id" not in f for f in canvas_frames), "canvas 帧不带 id 行"
    assert [(f["data"]["version"], f["data"]["origin"]) for f in canvas_frames] == [
        (2, "save"),
        (3, "projector"),
    ]
    assert all(f["data"]["canvas_id"] == canvas_id for f in canvas_frames)
    assert canvas_frames[0]["data"]["landed"] == []
    assert canvas_frames[1]["data"]["landed"] == [
        {"node_id": "n2", "task_id": canvas_frames[1]["data"]["landed"][0]["task_id"],
         "flow_run_id": None, "added": 1}
    ]
    assert canvas_frames[1]["data"]["updated_at"]
    # 第四轮回看窗口里同一版本又被查到：不重复推，只有 keep-alive
    assert raw[-1] == KEEP_ALIVE_FRAME
    # projector 写的那一帧同时带出了任务事件帧，任务帧照常带 id
    assert any(f.get("event") == "task" for f in frames)


async def test_stream_canvas_filter_only_emits_that_canvas(session_factory) -> None:
    async with session_factory() as session:
        mine = _canvas([])
        other = _canvas([])
        session.add_all([mine, other])
        await session.commit()
        await _save(session, mine, [])
        await _save(session, other, [])
        mine_id = mine.id

    raw = [
        frame
        async for frame in iter_sse_frames(
            session_factory, canvas_id=mine_id, should_stop=_Stopper(1), sleep=_no_sleep
        )
    ]
    canvas_frames = [_parse(frame) for frame in raw if frame.startswith("event: canvas")]
    assert [f["data"]["canvas_id"] for f in canvas_frames] == [mine_id]
    assert task_event_stream.POLL_INTERVAL_SECONDS > 0
