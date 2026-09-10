"""扩展（CR-007 模块 22）：内置模块、本地目录扩展、MCP 服务器、例程，同一张表。

一个扩展 = 一份 manifest（内置的写在代码里，本地的放 ``data/extensions/<id>/manifest.yaml``）
+ 一行本地状态（开关、已授权限）。manifest 声明它**贡献了什么**（九类贡献点，见
``CONTRIBUTION_POINTS``）与**要什么权限**（四类，见 ``PERMISSIONS``）；扩展页照这张表列。

三种来源：
- 本地目录：声明式，改了 manifest 点「重新扫描」就生效；带 worker 代码的要重启（本期没有代码包）。
- MCP 服务器：manifest 里写 ``mcp:``（stdio 命令或 http 地址），启用后它的工具立刻进助理
  （PydanticAI 的 ``MCPToolset``，工具名带扩展 id 前缀免撞名）。
- 例程：manifest 里写 ``routines:``，同步进 ``routine`` 表，由 worker 滴答触发
  （见 ``domain/routines``）。
"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal

import yaml
from pydantic import BaseModel, Field, ValidationError, field_validator
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from domain.models import ExtensionState
from domain.routines import BUILTIN as BUILTIN_ROUTINES
from domain.routines import RoutineSpec, ScheduleError, cron_of

logger = logging.getLogger(__name__)

EXT_DIR = Path(__file__).resolve().parents[2] / "data" / "extensions"
_ID_RE = re.compile(r"^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$")

PERMISSIONS: dict[str, str] = {
    "network": "网络",
    "credentials": "凭据",
    "screen_input": "屏幕与输入",
    "files": "文件",
}
Permission = Literal["network", "credentials", "screen_input", "files"]

CONTRIBUTION_POINTS: tuple[tuple[str, str], ...] = (
    ("pages", "导航页"),
    ("commands", "⌘K 命令"),
    ("tools", "助理工具"),
    ("nodes", "画布节点"),
    ("settings", "设置项"),
    ("tasks", "后台任务"),
    ("triggers", "例程触发器"),
    ("tables", "数据表"),
    ("credential_types", "凭据类型"),
)


class PageContribution(BaseModel):
    label: str
    to: str | None = None
    url: str | None = None


class CommandContribution(BaseModel):
    label: str
    to: str | None = None
    url: str | None = None
    keywords: str = ""


class McpConfig(BaseModel):
    transport: Literal["stdio", "http"] = "stdio"
    command: str | None = None
    args: list[str] = Field(default_factory=list)
    env: dict[str, str] = Field(default_factory=dict)
    url: str | None = None
    headers: dict[str, str] = Field(default_factory=dict)

    @field_validator("url")
    @classmethod
    def _url_shape(cls, value: str | None) -> str | None:
        if value is not None and not value.startswith(("http://", "https://")):
            raise ValueError("url 要以 http:// 或 https:// 开头")
        return value

    def check(self) -> None:
        if self.transport == "stdio" and not self.command:
            raise ValueError("stdio 传输要写 command")
        if self.transport == "http" and not self.url:
            raise ValueError("http 传输要写 url")


class RoutineContribution(BaseModel):
    key: str
    label: str
    schedule: str
    kind: Literal["prompt"] = "prompt"
    prompt: str
    speak: bool = False
    detail: str | None = None

    @field_validator("schedule")
    @classmethod
    def _schedule_ok(cls, value: str) -> str:
        try:
            cron_of(value)
        except ScheduleError as exc:
            raise ValueError(str(exc)) from exc
        return value


class Contributions(BaseModel):
    pages: list[PageContribution] = Field(default_factory=list)
    commands: list[CommandContribution] = Field(default_factory=list)
    tools: list[str] = Field(default_factory=list)
    nodes: int = 0
    settings: int = 0
    tasks: int = 0
    triggers: int = 0
    tables: int = 0
    credential_types: list[str] = Field(default_factory=list)

    def counts(self) -> dict[str, int]:
        return {
            "pages": len(self.pages),
            "commands": len(self.commands),
            "tools": len(self.tools),
            "nodes": self.nodes,
            "settings": self.settings,
            "tasks": self.tasks,
            "triggers": self.triggers,
            "tables": self.tables,
            "credential_types": len(self.credential_types),
        }


class ExtensionManifest(BaseModel):
    id: str
    name: str
    kind: Literal["builtin", "local", "mcp", "routine"] = "local"
    version: str = "0.1.0"
    description: str = ""
    contributions: Contributions = Field(default_factory=Contributions)
    permissions: list[Permission] = Field(default_factory=list)
    mcp: McpConfig | None = None
    routines: list[RoutineContribution] = Field(default_factory=list)
    default_enabled: bool = True

    @field_validator("id")
    @classmethod
    def _id_ok(cls, value: str) -> str:
        if not _ID_RE.fullmatch(value):
            raise ValueError("id 只能是小写字母、数字、. _ -，且首尾是字母或数字")
        return value

    def effective_kind(self) -> str:
        if self.kind != "local":
            return self.kind
        if self.mcp is not None:
            return "mcp"
        if self.routines and not self.contributions.pages and not self.contributions.commands:
            return "routine"
        return "local"


@dataclass
class ExtensionInfo:
    manifest: ExtensionManifest
    source: str  # builtin | 文件路径
    enabled: bool
    granted: list[str]
    error: str | None = None

    @property
    def status(self) -> str:
        if self.error:
            return "invalid"
        if not self.enabled:
            return "disabled"
        if self.missing_permissions:
            return "needs_permission"
        return "ready"

    @property
    def missing_permissions(self) -> list[str]:
        if self.source == "builtin":
            return []
        return [p for p in self.manifest.permissions if p not in self.granted]

    def view(self) -> dict:
        m = self.manifest
        return {
            "id": m.id,
            "name": m.name,
            "kind": m.effective_kind(),
            "version": m.version,
            "description": m.description,
            "source": self.source,
            "status": self.status,
            "error": self.error,
            "enabled": self.enabled,
            "permissions": list(m.permissions),
            "granted": list(self.granted),
            "missing_permissions": self.missing_permissions,
            "contributions": m.contributions.counts(),
            "pages": [p.model_dump() for p in m.contributions.pages],
            "commands": [c.model_dump() for c in m.contributions.commands],
            "tools": list(m.contributions.tools),
            "routines": [r.key for r in m.routines],
            "mcp": (
                {"transport": m.mcp.transport, "target": m.mcp.command or m.mcp.url}
                if m.mcp
                else None
            ),
        }


# ---- 内置清单 ----


def builtin_manifests() -> list[ExtensionManifest]:
    """内置模块按同一份 manifest 登记（CR-007 模块 22 备注）。工具数从真实目录取，别手抄。"""
    from domain import assistant

    def m(**kw: Any) -> ExtensionManifest:
        return ExtensionManifest(kind="builtin", version="1.0.0", **kw)

    assistant_tools = [name for name, _g, _d in assistant.TOOL_CATALOG]
    return [
        m(
            id="reading",
            name="阅读",
            description="书库精读、点译、词卡",
            contributions=Contributions(
                pages=[PageContribution(label="阅读", to="/read")],
                commands=[CommandContribution(label="导入书或文章…", to="/read")],
                tools=[t for t in assistant_tools if t in ("find_reading", "open_reading")],
                tasks=3,
                tables=6,
            ),
        ),
        m(
            id="video",
            name="视频",
            description="字幕学习、转写与翻译管线",
            contributions=Contributions(
                pages=[PageContribution(label="视频", to="/video")],
                commands=[CommandContribution(label="导入视频链接…", to="/video")],
                nodes=1,
                tasks=13,
                tables=5,
            ),
        ),
        m(
            id="learning",
            name="词汇 · 语法 · 对话",
            description="背单词、语法专栏、场景陪练",
            contributions=Contributions(
                pages=[
                    PageContribution(label="词汇", to="/vocab"),
                    PageContribution(label="语法", to="/grammar"),
                    PageContribution(label="对话", to="/talk"),
                ],
                commands=[CommandContribution(label="开始复习到期词", to="/vocab?v=review")],
                tools=[t for t in assistant_tools if t in ("review_status", "start_review")],
                tables=9,
            ),
        ),
        m(
            id="studio",
            name="工坊",
            description="画布、生图、工作流",
            contributions=Contributions(
                pages=[PageContribution(label="工坊", to="/studio")],
                commands=[CommandContribution(label="新建画布", to="/studio/canvas")],
                nodes=14,
                tasks=5,
                tables=8,
            ),
        ),
        m(
            id="mail",
            name="邮件与 Google 账号",
            description="多账号 Gmail、日历、收入阅读",
            contributions=Contributions(
                pages=[PageContribution(label="邮件", to="/mail")],
                tools=[
                    t
                    for t in assistant_tools
                    if t
                    in (
                        "inbox_summary",
                        "search_mail",
                        "read_mail",
                        "draft_reply",
                        "calendar_today",
                    )
                ],
                tables=2,
                credential_types=["google_oauth_client", "google_account"],
            ),
            permissions=["network", "credentials"],
        ),
        m(
            id="vault",
            name="凭据保险箱",
            description="密码、令牌、cookies；读出与填充记台账",
            contributions=Contributions(
                pages=[PageContribution(label="账号与凭据", to="/accounts")],
                settings=1,
                tables=2,
                credential_types=["password", "bearer", "cookies"],
            ),
            permissions=["credentials"],
        ),
        m(
            id="assistant",
            name="自动例程",
            description="工作台事实工具与定时例程",
            contributions=Contributions(
                tools=assistant_tools,
                triggers=len(BUILTIN_ROUTINES),
                tables=1,
            ),
        ),
    ]


# ---- 本地目录 ----


def load_manifest(path: Path) -> ExtensionManifest:
    raw = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    if not isinstance(raw, dict):
        raise ValueError("manifest 顶层要是一个映射")
    manifest = ExtensionManifest.model_validate(raw)
    if manifest.mcp is not None:
        manifest.mcp.check()
    if manifest.kind == "builtin":
        raise ValueError("本地扩展不能声明 kind: builtin")
    return manifest


def scan_local(root: Path | None = None) -> list[tuple[Path, ExtensionManifest | None, str | None]]:
    """每个子目录一个 manifest.yaml；坏的也列出来（带原因），别让一个坏文件藏起整个目录。"""
    root = root or EXT_DIR
    found: list[tuple[Path, ExtensionManifest | None, str | None]] = []
    if not root.exists():
        return found
    for path in sorted(root.glob("*/manifest.yaml")):
        try:
            found.append((path, load_manifest(path), None))
        except (ValidationError, ValueError, yaml.YAMLError) as exc:
            found.append((path, None, f"{type(exc).__name__}: {exc}"[:400]))
    return found


# ---- 目录（清单 + 状态） ----


async def catalog(session: AsyncSession, root: Path | None = None) -> list[ExtensionInfo]:
    states = {s.id: s for s in (await session.execute(select(ExtensionState))).scalars()}
    infos: list[ExtensionInfo] = []
    for manifest in builtin_manifests():
        state = states.get(manifest.id)
        infos.append(
            ExtensionInfo(
                manifest=manifest,
                source="builtin",
                enabled=state.enabled if state else True,
                granted=list(manifest.permissions),
            )
        )
    for path, manifest, error in scan_local(root):
        if manifest is None:
            broken = ExtensionManifest(id=_slug(path.parent.name), name=path.parent.name)
            infos.append(
                ExtensionInfo(
                    manifest=broken, source=str(path), enabled=False, granted=[], error=error
                )
            )
            continue
        state = states.get(manifest.id)
        infos.append(
            ExtensionInfo(
                manifest=manifest,
                source=str(path),
                enabled=state.enabled if state else manifest.default_enabled,
                granted=list(state.granted or []) if state else [],
            )
        )
    return infos


def _slug(name: str) -> str:
    slug = re.sub(r"[^a-z0-9._-]", "-", name.lower()).strip("-") or "broken"
    return slug[:64]


async def set_state(
    session: AsyncSession,
    ext_id: str,
    *,
    enabled: bool | None = None,
    granted: list[str] | None = None,
) -> ExtensionState:
    state = await session.get(ExtensionState, ext_id)
    if state is None:
        state = ExtensionState(id=ext_id, enabled=True, granted=[])
        session.add(state)
    if enabled is not None:
        state.enabled = enabled
    if granted is not None:
        unknown = [g for g in granted if g not in PERMISSIONS]
        if unknown:
            raise ValueError(f"不认识的权限：{unknown}")
        state.granted = list(dict.fromkeys(granted))
    await session.flush()
    return state


def routine_specs(infos: list[ExtensionInfo]) -> list[RoutineSpec]:
    """内置例程 + 就绪扩展声明的例程，交给 routines.sync。"""
    specs: list[RoutineSpec] = list(BUILTIN_ROUTINES)
    for info in infos:
        if info.source == "builtin" or info.status != "ready":
            continue
        for r in info.manifest.routines:
            specs.append(
                RoutineSpec(
                    key=r.key,
                    label=r.label,
                    schedule=r.schedule,
                    kind=r.kind,
                    prompt=r.prompt,
                    detail=r.detail,
                    speak=r.speak,
                    source=f"ext:{info.manifest.id}",
                )
            )
    return specs


# ---- MCP ----


def mcp_client_spec(cfg: McpConfig) -> Any:
    """manifest 的 mcp 段 → fastmcp 能建传输的东西（http 给 url，stdio 给 StdioTransport）。"""
    if cfg.transport == "http":
        return cfg.url
    from fastmcp.client.transports import StdioTransport

    return StdioTransport(command=cfg.command or "", args=list(cfg.args), env=cfg.env or None)


def mcp_toolset(info: ExtensionInfo) -> Any:
    from pydantic_ai.mcp import MCPToolset

    cfg = info.manifest.mcp
    assert cfg is not None
    headers = cfg.headers or None
    if cfg.transport == "http":
        return MCPToolset(mcp_client_spec(cfg), id=info.manifest.id, headers=headers)
    return MCPToolset(mcp_client_spec(cfg), id=info.manifest.id)


async def mcp_toolsets(session: AsyncSession) -> list[Any]:
    """就绪且带 mcp 段的扩展 → 助理可挂的工具集（惰性连接，跑代理时才起进程 / 建连接）。"""
    out: list[Any] = []
    for info in await catalog(session):
        if info.status == "ready" and info.manifest.mcp is not None:
            try:
                out.append(mcp_toolset(info))
            except Exception as exc:  # 缺依赖或配置形状不对：这个扩展跳过，别拖垮整轮
                logger.warning("mcp toolset for %s skipped: %s", info.manifest.id, exc)
    return out


async def probe_mcp(info: ExtensionInfo, timeout: float = 20.0) -> dict:
    """连一次、列工具：扩展页「测试」按钮。"""
    import asyncio

    toolset = mcp_toolset(info)
    try:
        async with asyncio.timeout(timeout):
            async with toolset:
                tools = await toolset.list_tools()
        return {"ok": True, "tools": [t.name for t in tools]}
    except Exception as exc:
        return {"ok": False, "error": f"{type(exc).__name__}: {exc}"[:400]}


__all__ = [
    "CONTRIBUTION_POINTS",
    "EXT_DIR",
    "PERMISSIONS",
    "Contributions",
    "ExtensionInfo",
    "ExtensionManifest",
    "McpConfig",
    "RoutineContribution",
    "builtin_manifests",
    "catalog",
    "load_manifest",
    "mcp_client_spec",
    "mcp_toolset",
    "mcp_toolsets",
    "probe_mcp",
    "routine_specs",
    "scan_local",
    "set_state",
]
