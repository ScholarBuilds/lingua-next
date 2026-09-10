"""CI 门禁配置与 image.auto 分流的守卫用例。

门禁依赖三件事：pytest-xdist 并行、pytest-timeout 兜底、mypy 只检内核文件。
它们全写在配置里，没有用例守着很容易被顺手改掉。
"""

from __future__ import annotations

import json
import tomllib
from pathlib import Path
from typing import Any

import pytest
import yaml

from domain import tool_execution, tool_plugins
from domain.tool_execution import (
    ImageAutoInput,
    ImageEditInput,
    ImageGenerateInput,
    ToolExecutionError,
)

REPO_ROOT = Path(__file__).resolve().parents[2]
SERVER_ROOT = REPO_ROOT / "server"
PARALLEL_PYTEST = "uv run pytest -q -n auto --timeout=120"
KERNEL_FILES = (
    "plugin_runtime",
    "model_runtime",
    "tool_execution",
    "tool_plugins",
    "studio_flows",
    "workflow_execution",
)


def _ci_steps(job: str) -> list[str]:
    workflow = yaml.safe_load((REPO_ROOT / ".github/workflows/ci.yml").read_text("utf-8"))
    return [step["run"] for step in workflow["jobs"][job]["steps"] if "run" in step]


# ---- 门禁配置 ----------------------------------------------------------------


def test_pytest_timeout_and_xdist_are_wired(request: pytest.FixtureRequest) -> None:
    import pytest_timeout  # noqa: F401
    import xdist  # noqa: F401

    assert float(request.config.getini("timeout")) == 120
    config = tomllib.loads((SERVER_ROOT / "pyproject.toml").read_text("utf-8"))
    assert config["tool"]["pytest"]["ini_options"]["timeout"] == 120
    # 本地默认串行：-n 不进 addopts
    assert "-n" not in config["tool"]["pytest"]["ini_options"].get("addopts", "")


def test_mypy_gate_only_counts_named_files() -> None:
    config = tomllib.loads((SERVER_ROOT / "pyproject.toml").read_text("utf-8"))
    assert config["tool"]["mypy"]["follow_imports"] == "silent"


def test_server_ci_runs_kernel_mypy_before_parallel_pytest() -> None:
    steps = _ci_steps("server")
    assert PARALLEL_PYTEST in steps
    mypy_steps = [step for step in steps if step.startswith("uv run mypy ")]
    assert len(mypy_steps) == 1
    for name in KERNEL_FILES:
        assert f"domain/{name}.py" in mypy_steps[0]
    assert steps.index(mypy_steps[0]) < steps.index(PARALLEL_PYTEST)


#: 前端每一道静态门禁在 `check:ci` 里的命令片段，按必须出现的先后顺序排。
#: 逐条按顺序断言而不是比对整条命令串——比整串的话，**加一道新门禁就会让这条用例失败**，
#: 而它本来要守的是「这些检查都跑、且都排在 vite build 前面」。
#: 加门禁时把片段追加进来，同时记得在 ci.yml 的 web job 里也加一步。
WEB_CI_GATES = (
    "tsc --noEmit",
    "vitest run",
    "node scripts/check-css.mjs",
    "node scripts/check-scroll.mjs",
    "vite build",
)


def test_web_ci_runs_vitest_and_css_check_after_tsc() -> None:
    steps = _ci_steps("web")
    tsc = steps.index("pnpm exec tsc --noEmit")
    assert steps.index("pnpm test") > tsc
    assert steps.index("pnpm check:css") > tsc
    # 滚动链路守卫要真的在 CI 里跑：只写进 package.json 的话本地不敲就永远不执行
    assert steps.index("pnpm check:scroll") > tsc
    scripts = json.loads((REPO_ROOT / "web/package.json").read_text("utf-8"))["scripts"]
    ci = scripts["check:ci"]
    at = -1
    for gate in WEB_CI_GATES:
        found = ci.find(gate, at + 1)
        assert found > at, f"check:ci 少了 {gate!r} 或顺序不对：{ci}"
        at = found


# ---- 内置插件目录：specs 标注后仍完整注册 -------------------------------------


def test_builtin_plugins_register_from_typed_specs() -> None:
    plugin = tool_plugins.require_tool_operation("infinite-canvas", "image.auto")
    assert plugin is tool_plugins.get_tool_plugin("infinite-canvas")
    # ST-01 … ST-20 全部内置工具都在目录里
    assert len(tool_plugins.list_tool_plugins()) >= 20


# ---- image.auto 分流：common 改成 TypedDict 后透传的关键字参数不变 ---------------

COMMON: dict[str, Any] = {
    "tool_id": "infinite-canvas",
    "parent_task_id": "task-parent",
    "batch_id": "batch-1",
    "source_route": "/studio/canvas",
    "source_context": {"node_id": "n1"},
}


@pytest.fixture
def captured(monkeypatch: pytest.MonkeyPatch) -> dict[str, dict[str, Any]]:
    calls: dict[str, dict[str, Any]] = {}

    async def fake_edit(session: Any, **kwargs: Any) -> str:
        calls["edit"] = {"session": session, **kwargs}
        return "edit"

    async def fake_generate(session: Any, **kwargs: Any) -> str:
        calls["generate"] = {"session": session, **kwargs}
        return "generate"

    monkeypatch.setattr(tool_execution, "_prepare_image_edit", fake_edit)
    monkeypatch.setattr(tool_execution, "_prepare_image_generate", fake_generate)
    return calls


async def test_image_auto_with_refs_forwards_common_to_edit(captured) -> None:
    body = ImageAutoInput(
        prompt="换个背景",
        ref_asset_ids=[3, 5],
        size="1024x1024",
        quality="high",
        n=2,
        app_key="consistent_edit",
    )
    session = object()
    result = await tool_execution._prepare_image_auto(session, body=body, **COMMON)

    assert result == "edit"
    assert "generate" not in captured
    call = captured["edit"]
    assert call["session"] is session
    for key, value in COMMON.items():
        assert call[key] == value
    edit_body = call["body"]
    assert isinstance(edit_body, ImageEditInput)
    assert edit_body.ref_asset_ids == [3, 5]
    assert edit_body.size is None  # 参考编辑跟随原图尺寸，不带生成分支的画幅
    assert (edit_body.quality, edit_body.n, edit_body.app_key) == ("high", 2, "consistent_edit")


async def test_image_auto_without_refs_forwards_common_to_generate(captured) -> None:
    body = ImageAutoInput(
        prompt="一只猫",
        size="1536x1024",
        tier="2k",
        style_key="anime",
        options={"seed": 7},
    )
    session = object()
    result = await tool_execution._prepare_image_auto(session, body=body, **COMMON)

    assert result == "generate"
    assert "edit" not in captured
    call = captured["generate"]
    assert call["session"] is session
    for key, value in COMMON.items():
        assert call[key] == value
    gen_body = call["body"]
    assert isinstance(gen_body, ImageGenerateInput)
    assert (gen_body.size, gen_body.tier, gen_body.style_key) == ("1536x1024", "2k", "anime")
    assert gen_body.options == {"seed": 7}


async def test_image_auto_rejects_duplicate_refs(captured) -> None:
    body = ImageAutoInput(prompt="x", ref_asset_ids=[1, 1])
    with pytest.raises(ToolExecutionError, match="不能重复"):
        await tool_execution._prepare_image_auto(object(), body=body, **COMMON)
    assert captured == {}
