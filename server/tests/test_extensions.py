"""扩展与例程（模块 22）：manifest 解析、目录合并状态、权限门、MCP 工具集形状、
例程同步与到点判定。"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest
from pydantic_ai.messages import ModelMessage, ModelResponse, TextPart
from pydantic_ai.models.function import AgentInfo, FunctionModel
from sqlalchemy import select

from domain import assistant, extensions, routines
from domain.models import Routine, RoutineRun

GOOD = """
id: demo
name: 演示
permissions: [network]
contributions:
  commands:
    - {label: 打开 X, url: https://x.test}
routines:
  - {key: demo_daily, label: 每日一句, schedule: "08:00", prompt: 说一句}
mcp:
  transport: http
  url: http://127.0.0.1:9/mcp
"""


def _write(root: Path, name: str, text: str) -> Path:
    d = root / name
    d.mkdir(parents=True)
    p = d / "manifest.yaml"
    p.write_text(text, encoding="utf-8")
    return p


@pytest.fixture
def ext_root(tmp_path, monkeypatch):
    monkeypatch.setattr(extensions, "EXT_DIR", tmp_path)
    return tmp_path


def test_manifest_parses_and_derives_kind(tmp_path):
    path = _write(tmp_path, "demo", GOOD)
    m = extensions.load_manifest(path)
    assert m.id == "demo" and m.effective_kind() == "mcp"
    assert m.contributions.counts()["commands"] == 1
    assert [r.key for r in m.routines] == ["demo_daily"]


def test_manifest_rejects_bad_shapes(tmp_path):
    bad_id = _write(tmp_path, "a", "id: Bad ID\nname: x\n")
    with pytest.raises(ValueError):
        extensions.load_manifest(bad_id)
    bad_sched = _write(
        tmp_path,
        "b",
        "id: b\nname: x\nroutines:\n  - {key: k, label: l, schedule: '25:99', prompt: p}\n",
    )
    with pytest.raises(ValueError):
        extensions.load_manifest(bad_sched)
    bad_mcp = _write(tmp_path, "c", "id: c\nname: x\nmcp: {transport: stdio}\n")
    with pytest.raises(ValueError):
        extensions.load_manifest(bad_mcp)
    found = extensions.scan_local(tmp_path)
    assert len(found) == 3 and all(m is None and err for _p, m, err in found)


async def test_catalog_merges_builtin_local_and_state(client, ext_root):
    _write(ext_root, "demo", GOOD)
    _write(ext_root, "broken", "id: [1]\n")
    r = await client.get("/extensions")
    assert r.status_code == 200
    body = r.json()
    by_id = {i["id"]: i for i in body["items"]}
    assert {"reading", "assistant", "demo", "broken"} <= set(by_id)
    assert by_id["assistant"]["source"] == "builtin" and by_id["assistant"]["status"] == "ready"
    assert by_id["assistant"]["contributions"]["tools"] == len(assistant.TOOL_CATALOG)
    assert by_id["broken"]["status"] == "invalid" and by_id["broken"]["error"]
    # 本地扩展要的权限没授就不就绪
    assert by_id["demo"]["status"] == "needs_permission"
    assert by_id["demo"]["missing_permissions"] == ["network"]
    assert [p["key"] for p in body["points"]] == [k for k, _ in extensions.CONTRIBUTION_POINTS]

    r = await client.patch("/extensions/demo", json={"granted": ["network"]})
    assert r.status_code == 200 and r.json()["status"] == "ready"
    r = await client.patch("/extensions/demo", json={"enabled": False})
    assert r.json()["status"] == "disabled"
    r = await client.patch("/extensions/demo", json={"granted": ["teleport"]})
    assert r.status_code == 400
    r = await client.patch("/extensions/reading", json={"granted": ["network"]})
    assert r.status_code == 400
    r = await client.patch("/extensions/nope", json={"enabled": True})
    assert r.status_code == 404


async def test_routines_follow_extension_readiness(client, session, ext_root):
    _write(ext_root, "demo", GOOD)
    r = await client.get("/routines")
    keys = {x["key"]: x for x in r.json()}
    # 内置早报永远在；扩展没就绪时它的例程还不该出现
    assert keys["morning_brief"]["schedule_label"] == "每天 07:30"
    assert "demo_daily" not in keys

    await client.patch("/extensions/demo", json={"granted": ["network"]})
    r = await client.get("/routines")
    keys = {x["key"]: x for x in r.json()}
    assert keys["demo_daily"]["source"] == "ext:demo" and keys["demo_daily"]["enabled"] is True

    # 时间表与开关归人管：改了之后再同步不会被声明覆盖
    r = await client.patch(
        "/routines/demo_daily", json={"schedule": "*/15 9-18 * * 1-5", "enabled": False}
    )
    assert r.status_code == 200 and r.json()["schedule_label"].startswith("cron")
    r = await client.patch("/routines/demo_daily", json={"schedule": "nonsense"})
    assert r.status_code == 400
    r = await client.get("/routines")
    keys = {x["key"]: x for x in r.json()}
    assert (
        keys["demo_daily"]["schedule"] == "*/15 9-18 * * 1-5"
        and keys["demo_daily"]["enabled"] is False
    )

    # 扩展关掉：它的例程标 disabled 而不是删掉
    await client.patch("/routines/demo_daily", json={"enabled": True})
    await client.patch("/extensions/demo", json={"enabled": False})
    r = await client.get("/routines")
    keys = {x["key"]: x for x in r.json()}
    assert keys["demo_daily"]["enabled"] is False
    rows = (await session.execute(select(Routine))).scalars().all()
    assert {x.key for x in rows} == {"morning_brief", "demo_daily"}


def test_schedule_parsing_and_due():
    assert routines.cron_of("07:30") == "30 7 * * *"
    assert routines.cron_of("*/5 * * * *") == "*/5 * * * *"
    for bad in ("7:99", "25:00", "abc", "* * *"):
        with pytest.raises(routines.ScheduleError):
            routines.cron_of(bad)
    now = datetime(2026, 9, 2, 7, 31, tzinfo=UTC).astimezone()
    row = Routine(key="k", label="l", kind="brief", schedule=now.strftime("%H:%M"), enabled=True)
    row.last_run_at = None
    assert routines.is_due(row, now) is True  # 刚过一分钟，补跑
    row.last_run_at = now
    assert routines.is_due(row, now) is False  # 这一刻已经跑过
    row.last_run_at = now - timedelta(days=1)
    assert routines.is_due(row, now) is True
    row.enabled = False
    assert routines.is_due(row, now) is False
    stale = Routine(key="s", label="l", kind="brief", schedule="00:00", enabled=True)
    stale.last_run_at = None
    assert routines.is_due(stale, now.replace(hour=12)) is False  # 从没跑过且早已错过：不补


async def test_run_due_runs_brief_and_prompt(client, session, monkeypatch):
    calls: list[str] = []

    async def fake_prompt(prompt: str) -> str:
        calls.append(prompt)
        return "今天还有 3 张到期词。"

    monkeypatch.setattr(routines, "_run_prompt", fake_prompt)
    now = datetime.now().astimezone()
    session.add_all(
        [
            Routine(
                key="morning_brief", label="早报", kind="brief", schedule=now.strftime("%H:%M")
            ),
            Routine(
                key="ask",
                label="问一句",
                kind="prompt",
                schedule=now.strftime("%H:%M"),
                prompt="到期词？",
            ),
            Routine(
                key="off",
                label="关着",
                kind="prompt",
                schedule=now.strftime("%H:%M"),
                enabled=False,
            ),
        ]
    )
    await session.commit()
    ran = await routines.run_due(now)
    assert set(ran) == {"morning_brief", "ask"} and calls == ["到期词？"]
    runs = (await session.execute(select(RoutineRun).order_by(RoutineRun.id))).scalars().all()
    assert {r.key for r in runs} == {"morning_brief", "ask"}
    assert any(r.text.startswith("早上好") for r in runs)
    # 已经跑过这一刻，再滴答一次不重复
    assert await routines.run_due(now + timedelta(seconds=30)) == []

    r = await client.get("/routines/ask/runs")
    assert r.json()[0]["text"] == "今天还有 3 张到期词。"
    r = await client.post("/routines/ask/run")
    assert r.status_code == 200 and r.json()["last_status"] == "ok"


async def test_prompt_routine_failure_is_recorded(session, monkeypatch):
    async def boom(prompt: str) -> str:
        raise RuntimeError("模型挂了")

    monkeypatch.setattr(routines, "_run_prompt", boom)
    row = Routine(key="p", label="提示", kind="prompt", schedule="09:00", prompt="x")
    session.add(row)
    await session.commit()
    run = await routines.run_routine(session, row)
    await session.commit()
    assert row.last_status == "failed" and "模型挂了" in run.text


def test_mcp_toolset_shapes(tmp_path):
    http = extensions.ExtensionInfo(
        manifest=extensions.load_manifest(_write(tmp_path, "h", GOOD)),
        source="x",
        enabled=True,
        granted=["network"],
    )
    ts = extensions.mcp_toolset(http)
    assert ts.id == "demo"
    stdio_manifest = extensions.ExtensionManifest(
        id="fs",
        name="fs",
        mcp=extensions.McpConfig(transport="stdio", command="npx", args=["-y", "x"]),
    )
    spec = extensions.mcp_client_spec(stdio_manifest.mcp)
    assert type(spec).__name__ == "StdioTransport"


async def test_assistant_agent_accepts_toolsets():
    def function(_messages: list[ModelMessage], _info: AgentInfo) -> ModelResponse:
        return ModelResponse(parts=[TextPart(content="好")])

    deps = assistant.AssistantDeps(session_factory=None)  # type: ignore[arg-type]
    reply = await assistant.run_turn(FunctionModel(function), deps, "你好", toolsets=[])
    assert reply.text == "好"


async def test_probe_reports_connection_failure(tmp_path):
    info = extensions.ExtensionInfo(
        manifest=extensions.load_manifest(_write(tmp_path, "h", GOOD)),
        source="x",
        enabled=True,
        granted=["network"],
    )
    result = await extensions.probe_mcp(info, timeout=3)
    assert result["ok"] is False and result["error"]
