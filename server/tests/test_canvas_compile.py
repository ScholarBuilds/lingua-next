"""画布编译器的服务端实现（模块 17 F3）。

这些用例是 `web/src/features/studio/canvas-cascade-compiler.test.ts` 的逐条翻译：
同一份画布文档进去，两端必须编出等价的 DAG。TS 版留作运行前的本地预演，真正
提交的定义以服务端为准——两边分叉的话，用户看到的预演和实际跑的不是一回事。

纯计算，不联网也不碰库；工作流详情、凭据、部署适配器都由 `CompileLookups` 喂进来。
"""

from __future__ import annotations

import json

import pytest

from domain.canvas_compile import (
    CanvasCompileError,
    CanvasDoc,
    Chain,
    CompileLookups,
    LoopRound,
    RunCtx,
    cascade_chain,
    compile_cascade,
    compile_set_plan,
    loop_schedule,
)

CANVAS_ID = 77


def doc_of(nodes: list[dict], connections: list[dict] | None = None) -> CanvasDoc:
    return CanvasDoc(nodes=nodes, connections=connections or [])


def context(order: list[str], total: int = 1, loop_id: str | None = None) -> RunCtx:
    """与 TS 测试的 `context()` 同口径：没有变量词，轮次编排走默认步长。"""
    rounds, _start, end, _batch = loop_schedule({"count": total})
    return RunCtx(
        canvas_id=CANVAS_ID,
        order=order,
        total=total,
        vars=[],
        schedule=rounds,
        end_index=end,
        loop_id=loop_id,
    )


def set_plan(intent: str) -> dict:
    return {
        "goal": "一组三联画",
        "intent": intent,
        "variables": [],
        "steps": [
            {"id": "cover", "title": "封面", "prompt": "画封面", "dependsOn": []},
            {"id": "detail", "title": "细节", "prompt": "画细节", "dependsOn": ["cover"]},
            {"id": "ending", "title": "收束", "prompt": "画结尾", "dependsOn": ["detail"]},
        ],
        "rationale": "验证服务端成套执行拓扑",
    }


MINIMAX_DETAIL = {
    "id": 15,
    "key": "runninghub:2084608321469898754",
    "title": "Minimax-多参视频生成",
    "provider": "runninghub",
    "kind": "workflow",
    "source": "user",
    "source_id": "2084608321469898754",
    "enabled": True,
    "ui_schema": {
        "fields": [
            {
                "id": "138::value",
                "nodeId": "138",
                "fieldName": "value",
                "label": "Prompt",
                "enabled": True,
            },
            {
                "id": "132::value",
                "nodeId": "132",
                "fieldName": "value",
                "label": "Duration",
                "enabled": True,
            },
            {
                "id": "20::image",
                "nodeId": "20",
                "fieldName": "image",
                "fieldType": "IMAGE",
                "enabled": True,
            },
        ]
    },
}

RUNNINGHUB_CREDENTIALS = [
    {"id": 5, "name": "RunningHub test", "kind": "workflow", "provider_type": "runninghub"}
]


class TestCascadeCompiler:
    def test_projects_minimax_runninghub_media_onto_real_field_keys(self) -> None:
        """MiniMax 的时间线只写语义键，上送的必须是工作流自己的字段 id。

        漏了这层映射，RunningHub 收到一堆 `f_*` 会当未知参数丢掉，画面参数全默认。
        """
        nodes = [
            {
                "id": "source",
                "type": "image",
                "x": 0,
                "y": 0,
                "items": [{"kind": "image", "asset_id": 31}],
            },
            {
                "id": "workflow",
                "type": "workflow",
                "x": 500,
                "y": 0,
                "title": "Minimax-多参视频生成",
                "workflow_id": 15,
                "workflow_provider": "runninghub",
                "workflow_kind": "workflow",
                "workflow_credential_id": 5,
                "workflow_timeline": {
                    "kind": "minimax",
                    "selected_id": "clip-1",
                    "segments": [
                        {
                            "id": "clip-1",
                            "start": 0,
                            "length": 6,
                            "prompt": "clip-specific prompt",
                            "type": "text",
                            "references": [],
                        }
                    ],
                },
            },
        ]
        doc = doc_of(nodes, [{"from": "source", "to": "workflow", "kind": "input"}])
        order = ["source", "workflow"]
        compiled = compile_cascade(
            doc,
            Chain(order, ["source-workflow"]),
            context(order),
            "serial",
            lookups=CompileLookups(
                workflow_details={15: MINIMAX_DETAIL},
                workflow_credentials=RUNNINGHUB_CREDENTIALS,
            ),
        )
        run_node = next(
            node for node in compiled.definition["nodes"] if node["operation"] == "workflow.run"
        )
        fields = run_node["input"]["fields"]

        assert fields["138::value"] == "clip-specific prompt"
        assert fields["132::value"] == 6
        assert fields["20::image"]["$artifacts"] == [{"$node": "r1_n0"}]
        assert not any(key.startswith("f_") for key in fields)
        assert run_node["input"]["credential_id"] == 5

    def test_picks_a_same_provider_credential_when_the_bound_one_is_gone(self) -> None:
        """凭据在服务端挑：节点上绑的那把停用了就顺位取同供应商的。"""
        nodes = [
            {
                "id": "workflow",
                "type": "workflow",
                "x": 0,
                "y": 0,
                "title": "Minimax-多参视频生成",
                "workflow_id": 15,
                "workflow_credential_id": 5,
            }
        ]
        compiled = compile_cascade(
            doc_of(nodes),
            Chain(["workflow"], []),
            context(["workflow"]),
            "serial",
            lookups=CompileLookups(
                workflow_details={15: MINIMAX_DETAIL},
                # 5 号已停用，路由层不会把它放进来
                workflow_credentials=[{"id": 9, "provider_type": "runninghub"}],
            ),
        )
        assert compiled.definition["nodes"][0]["input"]["credential_id"] == 9

    def test_rejects_a_workflow_node_without_any_usable_credential(self) -> None:
        nodes = [
            {
                "id": "workflow",
                "type": "workflow",
                "x": 0,
                "y": 0,
                "title": "Minimax-多参视频生成",
                "workflow_id": 15,
            },
        ]
        with pytest.raises(CanvasCompileError, match="runninghub"):
            compile_cascade(
                doc_of(nodes),
                Chain(["workflow"], []),
                context(["workflow"]),
                "serial",
                lookups=CompileLookups(workflow_details={15: MINIMAX_DETAIL}),
            )

    def test_freezes_llm_output_refs_and_image_auto_routing_into_one_dag(self) -> None:
        """上游 LLM 的产出留成 `$node` 引用，运行期才取值。

        编译期就把 `llm_output` 取出来的话，冻结的是上一次的旧文案。
        """
        nodes = [
            {"id": "prompt", "type": "prompt", "x": 0, "y": 0, "text": "portrait"},
            {"id": "writer", "type": "llm", "x": 200, "y": 0, "llm_input": ""},
            {"id": "image", "type": "image", "x": 400, "y": 0, "items": []},
        ]
        connections = [
            {"from": "prompt", "to": "writer", "kind": "input"},
            {"from": "writer", "to": "image", "kind": "input"},
        ]
        doc = doc_of(nodes, connections)
        chain = cascade_chain(doc, "image")
        compiled = compile_cascade(doc, chain, context(chain.order), "serial")

        assert [node["operation"] for node in compiled.definition["nodes"]] == [
            "chat.general",
            "image.auto",
        ]
        assert compiled.definition["edges"] == [{"from": "r1_n1", "to": "r1_n2"}]
        image_input = compiled.definition["nodes"][1]["input"]
        assert '"$node": "r1_n1"' in json.dumps(image_input["prompt"], ensure_ascii=False)
        assert '"$node": "r1_n1"' in json.dumps(image_input["ref_asset_ids"], ensure_ascii=False)
        assert compiled.source_context["max_parallel_tasks"] == 1
        assert compiled.source_context["round_nodes"] == {"1": ["r1_n1", "r1_n2"]}

    def test_freezes_upstream_video_media_ids_into_llm_runs(self) -> None:
        """上游是视频时要投影 media_asset_id，不是 asset_id。"""
        nodes = [
            {
                "id": "video-source",
                "type": "output",
                "x": 0,
                "y": 0,
                "items": [{"kind": "video", "media_asset_id": 77}],
            },
            {"id": "writer", "type": "llm", "x": 220, "y": 0, "llm_input": "概括镜头变化"},
        ]
        connections = [{"from": "video-source", "to": "writer", "kind": "input"}]
        doc = doc_of(nodes, connections)
        chain = cascade_chain(doc, "writer")
        compiled = compile_cascade(doc, chain, context(chain.order), "serial")

        assert len(compiled.definition["nodes"]) == 1
        assert compiled.definition["nodes"][0]["operation"] == "chat.general"
        projection = compiled.definition["nodes"][0]["input"]["video_media_asset_ids"]
        assert projection["field"] == "media_asset_id"
        assert projection["kinds"] == ["video"]
        assert projection["limit"] == 3
        assert projection["fallback"] == [{"kind": "video", "media_asset_id": 77}]

    def test_keeps_modelscope_copies_parallel_inside_each_loop_round(self) -> None:
        """一轮出几张就是几个并行节点，轮与轮之间不连边。"""
        nodes = [
            {"id": "prompt", "type": "prompt", "x": 0, "y": 0, "text": "frame 《计数》"},
            {"id": "loop", "type": "loop", "x": 160, "y": 0, "count": 2, "mode": "parallel"},
            {
                "id": "modelscope",
                "type": "modelscope",
                "x": 320,
                "y": 0,
                "items": [],
                "ms_count": 2,
                "ms_deployment_id": 9,
            },
        ]
        connections = [
            {"from": "prompt", "to": "loop", "kind": "input"},
            {"from": "loop", "to": "modelscope", "kind": "input"},
        ]
        doc = doc_of(nodes, connections)
        chain = cascade_chain(doc, "loop")
        compiled = compile_cascade(doc, chain, context(chain.order, 2, "loop"), "parallel", 2)

        assert len(compiled.definition["nodes"]) == 4
        assert all(node["operation"] == "image.generate" for node in compiled.definition["nodes"])
        assert compiled.definition["edges"] == []
        assert compiled.source_context["max_parallel_tasks"] == 4
        assert compiled.source_context["round_nodes"] == {
            "1": ["r1_n0", "r1_n0_c1"],
            "2": ["r2_n0", "r2_n0_c1"],
        }
        assert compiled.definition["nodes"][0]["input"]["prompt"] == "frame 1"
        assert compiled.definition["nodes"][2]["input"]["prompt"] == "frame 2"

    def test_rejects_a_modelscope_node_without_a_deployment(self) -> None:
        nodes = [{"id": "ms", "type": "modelscope", "x": 0, "y": 0, "title": "魔搭"}]
        with pytest.raises(CanvasCompileError, match="ModelScope"):
            compile_cascade(doc_of(nodes), Chain(["ms"], []), context(["ms"]), "serial")

    def test_rejects_a_chain_without_any_executable_node(self) -> None:
        nodes = [{"id": "prompt", "type": "prompt", "x": 0, "y": 0, "text": "只有词"}]
        with pytest.raises(CanvasCompileError, match="没有可提交"):
            compile_cascade(doc_of(nodes), Chain(["prompt"], []), context(["prompt"]), "serial")

    def test_serial_rounds_chain_head_to_previous_tail(self) -> None:
        """串行两轮之间必须连边，否则并发池会把两轮一起发出去。"""
        nodes = [{"id": "image", "type": "image", "x": 0, "y": 0, "items": []}]
        compiled = compile_cascade(
            doc_of(nodes), Chain(["image"], []), context(["image"], 2), "serial"
        )
        assert compiled.definition["edges"] == [{"from": "r1_n0", "to": "r2_n0"}]

    def test_retry_compiles_only_the_failed_round_and_keeps_its_number(self) -> None:
        """从失败轮续跑：轮号保持原值，槽位与《计数》才对得上。"""
        nodes = [
            {
                "id": "image",
                "type": "image",
                "x": 0,
                "y": 0,
                "items": [],
                "prompt_draft": "第 《计数》 张",
            }
        ]
        compiled = compile_cascade(
            doc_of(nodes), Chain(["image"], []), context(["image"], 3), "serial", rounds=[2]
        )
        assert [node["id"] for node in compiled.definition["nodes"]] == ["r2_n0"]
        assert compiled.definition["nodes"][0]["input"]["prompt"] == "第 2 张"
        assert compiled.source_context["round_nodes"] == {"2": ["r2_n0"]}


class TestTargetSlots:
    def test_round_one_lands_on_the_node_itself_when_it_is_still_empty(self) -> None:
        nodes = [{"id": "image", "type": "image", "x": 0, "y": 0, "items": []}]
        compiled = compile_cascade(
            doc_of(nodes), Chain(["image"], []), context(["image"]), "serial"
        )
        landing = compiled.definition["nodes"][0]["source_context"]
        assert landing["node_id"] == "image"
        assert "source_node_id" not in landing
        assert "planned_node" not in landing

    def test_later_rounds_reuse_the_persisted_slot(self) -> None:
        """槽位靠 slot_of + slot_round 认领，跨会话复用同一批节点。"""
        nodes = [
            {"id": "image", "type": "image", "x": 0, "y": 0, "items": []},
            {
                "id": "slot-2",
                "type": "output",
                "x": 0,
                "y": 340,
                "items": [],
                "slot_of": "image",
                "slot_round": 2,
            },
        ]
        compiled = compile_cascade(
            doc_of(nodes), Chain(["image"], []), context(["image"], 2), "serial"
        )
        second = compiled.definition["nodes"][1]["source_context"]
        assert second["node_id"] == "slot-2"
        assert second["source_node_id"] == "image"
        assert "planned_node" not in second

    def test_pending_slots_carry_a_planned_node_for_the_worker(self) -> None:
        """前端刚建、还没落库的槽位要带上蓝本，Worker 才能补建。"""
        nodes = [
            {"id": "image", "type": "image", "x": 0, "y": 0, "items": []},
            {
                "id": "slot-2",
                "type": "output",
                "x": 0,
                "y": 340,
                "items": [],
                "slot_of": "image",
                "slot_round": 2,
            },
        ]
        compiled = compile_cascade(
            doc_of(nodes),
            Chain(["image"], []),
            context(["image"], 2),
            "serial",
            targets={"image": {"2": "slot-2"}},
            pending=["slot-2"],
        )
        second = compiled.definition["nodes"][1]["source_context"]
        assert second["node_id"] == "slot-2"
        assert second["pending_target"] is True
        assert second["planned_node"]["id"] == "slot-2"


class TestSetPlanCompiler:
    def test_compiles_a_consistent_plan_into_a_persisted_artifact_chain(self) -> None:
        """一致性靠「上一步产物排在初始参考之前」，不是靠 fallback。"""
        nodes = [
            {
                "id": "source",
                "type": "image",
                "x": 0,
                "y": 0,
                "items": [{"kind": "image", "asset_id": 31}],
                "run_settings": {"deployment_id": 9, "size": "1024x1536", "quality": "high"},
            },
            {"id": "slot-1", "type": "image", "x": 0, "y": 500, "title": "封面", "items": []},
            {"id": "slot-2", "type": "image", "x": 550, "y": 500, "title": "细节", "items": []},
            {"id": "slot-3", "type": "image", "x": 1100, "y": 500, "title": "收束", "items": []},
        ]
        compiled = compile_set_plan(
            doc_of(nodes),
            CANVAS_ID,
            "source",
            set_plan("consistent"),
            ["slot-1", "slot-2", "slot-3"],
        )

        assert [node["operation"] for node in compiled.definition["nodes"]] == [
            "image.auto",
            "image.auto",
            "image.auto",
        ]
        assert compiled.definition["edges"] == [
            {"from": "set_1", "to": "set_2"},
            {"from": "set_2", "to": "set_3"},
        ]
        assert compiled.definition["nodes"][0]["input"]["ref_asset_ids"]["$artifacts"] == [
            {"kind": "image", "asset_id": 31}
        ]
        assert compiled.definition["nodes"][1]["input"]["ref_asset_ids"]["$artifacts"] == [
            {"$node": "set_1"},
            {"kind": "image", "asset_id": 31},
        ]
        assert compiled.source_context["kind"] == "canvas_set"
        assert compiled.source_context["mode"] == "serial"
        assert compiled.source_context["total"] == 3
        assert compiled.source_context["max_parallel_tasks"] == 1
        assert compiled.source_context["node_map"] == {
            "set_1": {
                "canvas_node_id": "slot-1",
                "target_node_id": "slot-1",
                "round": 1,
                "label": "封面",
            },
            "set_2": {
                "canvas_node_id": "slot-2",
                "target_node_id": "slot-2",
                "round": 2,
                "label": "细节",
            },
            "set_3": {
                "canvas_node_id": "slot-3",
                "target_node_id": "slot-3",
                "round": 3,
                "label": "收束",
            },
        }
        assert compiled.definition["nodes"][0]["input"]["size"] == "1024x1536"
        assert compiled.definition["nodes"][0]["input"]["deployment_id"] == 9

    def test_compiles_a_varied_plan_as_independent_tasks(self) -> None:
        nodes = [
            {
                "id": "source",
                "type": "image",
                "x": 0,
                "y": 0,
                "items": [{"kind": "image", "asset_id": 31}],
            },
            {"id": "slot-1", "type": "image", "x": 0, "y": 500, "items": []},
            {"id": "slot-2", "type": "image", "x": 550, "y": 500, "items": []},
            {"id": "slot-3", "type": "image", "x": 1100, "y": 500, "items": []},
        ]
        compiled = compile_set_plan(
            doc_of(nodes),
            CANVAS_ID,
            "source",
            set_plan("varied"),
            ["slot-1", "slot-2", "slot-3"],
        )

        assert compiled.definition["edges"] == []
        assert [
            node["input"]["ref_asset_ids"]["$artifacts"] for node in compiled.definition["nodes"]
        ] == [
            [{"kind": "image", "asset_id": 31}],
            [{"kind": "image", "asset_id": 31}],
            [{"kind": "image", "asset_id": 31}],
        ]
        assert compiled.source_context["mode"] == "parallel"
        assert compiled.source_context["max_parallel_tasks"] == 3

    def test_all_set_plan_steps_share_one_execution_group(self) -> None:
        nodes = [
            {"id": "source", "type": "image", "x": 0, "y": 0, "items": []},
            {"id": "slot-1", "type": "image", "x": 0, "y": 500, "items": []},
            {"id": "slot-2", "type": "image", "x": 550, "y": 500, "items": []},
            {"id": "slot-3", "type": "image", "x": 1100, "y": 500, "items": []},
        ]
        compiled = compile_set_plan(
            doc_of(nodes),
            CANVAS_ID,
            "source",
            set_plan("consistent"),
            ["slot-1", "slot-2", "slot-3"],
        )
        groups = {
            node["source_context"]["execution_group_id"] for node in compiled.definition["nodes"]
        }
        assert len(groups) == 1
        assert all(
            node["source_context"]["pending_target"] is True
            for node in compiled.definition["nodes"]
        )

    def test_rejects_a_plan_whose_slots_do_not_match(self) -> None:
        nodes = [{"id": "source", "type": "image", "x": 0, "y": 0, "items": []}]
        with pytest.raises(CanvasCompileError, match="输出槽"):
            compile_set_plan(
                doc_of(nodes), CANVAS_ID, "source", set_plan("consistent"), ["slot-1"]
            )

    def test_rejects_a_missing_source_node(self) -> None:
        with pytest.raises(CanvasCompileError, match="源节点"):
            compile_set_plan(
                doc_of([]), CANVAS_ID, "source", set_plan("consistent"), ["a", "b", "c"]
            )


class TestLoopSchedule:
    def test_default_schedule_matches_the_frontend(self) -> None:
        """两端的轮次编排必须同算式，否则预演写 3 轮实际跑 5 轮。"""
        rounds, start, end, batch = loop_schedule({"count": 3})
        assert rounds == [
            LoopRound(index=1, ordinal=0, slice=None),
            LoopRound(index=2, ordinal=1, slice=None),
            LoopRound(index=3, ordinal=2, slice=None),
        ]
        assert (start, end, batch) == (1, 3, 1)

    def test_per_image_feeding_steps_by_batch_not_by_one(self) -> None:
        rounds, start, end, batch = loop_schedule(
            {"count": 3, "image_input": True, "image_batch_size": 2}
        )
        assert [item.slice for item in rounds] == [(1, 2), (3, 2), (5, 2)]
        assert (start, end, batch) == (1, 5, 2)


class TestCompileRoute:
    """HTTP 出口：请求体形状与前端 `runCascade` / `runSetPlan` 的调用一一对应。"""

    async def test_compiles_a_cascade_from_the_posted_snapshot(self, client) -> None:
        canvas = (await client.post("/studio/canvases", json={"title": "编译"})).json()
        nodes = [
            {"id": "prompt", "type": "prompt", "x": 0, "y": 0, "text": "portrait"},
            {"id": "image", "type": "image", "x": 300, "y": 0, "items": []},
        ]
        response = await client.post(
            f"/studio/canvases/{canvas['id']}/compile",
            json={
                "mode": "cascade",
                "nodes": nodes,
                "connections": [{"from": "prompt", "to": "image", "kind": "input"}],
                "order": ["prompt", "image"],
                "edge_keys": ["prompt-image"],
                "loop_mode": "serial",
                "total": 1,
                "start_id": "image",
            },
        )
        assert response.status_code == 200
        body = response.json()
        assert [node["operation"] for node in body["definition"]["nodes"]] == ["image.auto"]
        assert body["definition"]["nodes"][0]["input"]["prompt"] == "portrait"
        assert body["source_context"]["kind"] == "canvas_cascade"
        assert body["source_context"]["canvas_id"] == canvas["id"]
        assert body["source_context"]["start_id"] == "image"

    async def test_falls_back_to_the_stored_canvas_when_no_snapshot_is_posted(
        self, client
    ) -> None:
        """定时触发与服务端重跑没有浏览器，画布只能从库里读。"""
        canvas = (await client.post("/studio/canvases", json={"title": "定时"})).json()
        await client.put(
            f"/studio/canvases/{canvas['id']}",
            json={
                "nodes": [{"id": "image", "type": "image", "x": 0, "y": 0, "items": []}],
                "connections": [],
                "base_version": canvas["version"],
            },
        )
        response = await client.post(
            f"/studio/canvases/{canvas['id']}/compile",
            json={"mode": "cascade", "order": ["image"], "total": 1},
        )
        assert response.status_code == 200
        assert len(response.json()["definition"]["nodes"]) == 1

    async def test_reports_a_compile_error_as_400(self, client) -> None:
        canvas = (await client.post("/studio/canvases", json={"title": "空链"})).json()
        response = await client.post(
            f"/studio/canvases/{canvas['id']}/compile",
            json={
                "mode": "cascade",
                "nodes": [{"id": "prompt", "type": "prompt", "x": 0, "y": 0, "text": "词"}],
                "order": ["prompt"],
                "total": 1,
            },
        )
        assert response.status_code == 400
        assert "没有可提交" in response.json()["detail"]

    async def test_compiles_a_set_plan_over_http(self, client) -> None:
        canvas = (await client.post("/studio/canvases", json={"title": "成套"})).json()
        nodes = [
            {"id": "source", "type": "image", "x": 0, "y": 0, "items": []},
            {"id": "slot-1", "type": "image", "x": 0, "y": 500, "items": []},
            {"id": "slot-2", "type": "image", "x": 400, "y": 500, "items": []},
            {"id": "slot-3", "type": "image", "x": 800, "y": 500, "items": []},
        ]
        response = await client.post(
            f"/studio/canvases/{canvas['id']}/compile",
            json={
                "mode": "set",
                "nodes": nodes,
                "connections": [],
                "start_id": "source",
                "plan": set_plan("consistent"),
                "slots": ["slot-1", "slot-2", "slot-3"],
            },
        )
        assert response.status_code == 200
        body = response.json()
        assert body["definition"]["edges"] == [
            {"from": "set_1", "to": "set_2"},
            {"from": "set_2", "to": "set_3"},
        ]
        assert body["source_context"]["kind"] == "canvas_set"

    async def test_missing_canvas_is_404(self, client) -> None:
        response = await client.post(
            "/studio/canvases/999999/compile", json={"mode": "cascade", "order": []}
        )
        assert response.status_code == 404
