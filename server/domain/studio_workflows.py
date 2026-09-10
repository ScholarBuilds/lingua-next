"""工作流目录：内置 Infinite-Canvas 资产与用户导入的统一事实源。

除目录 CRUD 外还管两件事：

- **版本链**：定义每改一次留一份快照（走 `domain/studio_revisions`），能看历史、能回滚。
- **导出 / 导入**：导出一份自包含 JSON，同一个导入口能原样吃回去。导出前统一脱敏
  ——凭据字段和本机绝对路径一律抹掉并在 `redacted` 里列出抹了哪些，
  而不是悄悄导出去。工作流是拿来发给别人的东西，这条不能靠自觉。
"""

from __future__ import annotations

import hashlib
import json
import re
import uuid
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from domain import studio_revisions
from domain.models import StudioWorkflow

RESOURCE_ROOT = Path(__file__).resolve().parent.parent / "resources" / "studio_workflows"
COMFY_ROOT = RESOURCE_ROOT / "comfyui"
RUNNINGHUB_ROOT = RESOURCE_ROOT / "runninghub"
PROVIDERS = frozenset({"comfyui", "runninghub"})
KINDS = frozenset({"image", "edit", "upscale", "video", "app", "workflow", "model"})
_SECRET_KEYS = frozenset(
    {
        "api_key",
        "apikey",
        "access_key",
        "accesskey",
        "secret",
        "secret_key",
        "password",
        "authorization",
        "bearer_token",
    }
)

EXPORT_FORMAT = "lingua-studio-workflow"
EXPORT_VERSION = 1

REDACTED_SECRET = "<已移除：疑似凭据>"
REDACTED_PATH = "<已移除：本机绝对路径>"

# 一望即知是本机路径的开头：Windows 盘符、UNC、`~/`、file://
_LOCAL_PREFIX_RE = re.compile(r"^(?:[A-Za-z]:[\\/]|\\\\[^\\]|~[/\\]|file://)")

# POSIX 绝对路径。要求至少一个完整目录段（`/Users/`、`/home/`），
# 否则 `/` 开头的任意字符串都会被当成路径
_POSIX_PATH_RE = re.compile(r"^/(?:[\w.\-]+/)+")

# 超过这个长度的字符串不当路径看：那个量级的只可能是内嵌的 base64 或整段脚本，
# 而 base64 恰好可能以 `/` 开头（`/9j/…` 是 JPEG 的固定开头），不设上限会把图切坏
_PATH_MAX_LEN = 512

# 嵌在长字符串里的本机路径。整串是一条路径的情况上面两条已经管了，这里管的是
# `--ckpt /Users/your-user/models/x.safetensors` 这种夹在命令行片段或备注里的写法——
# 它一样把用户名和目录结构带出去，只是不在字符串开头。
#
# 只认「一望即知属于某台机器上某个人」的根，不认任意 `/a/b/`：后者在长字符串里
# 满地都是（HTTP 路径、节点备注），逐个抹掉只会把内容切碎。
# 盘符前要求不是字母，否则 `http://` 里的 `p:/` 会被当成盘符，一抹就把所有 URL 毁了。
_EMBEDDED_PATH_RE = re.compile(
    r"(?:(?<![A-Za-z])[A-Za-z]:[\\/]"
    r"|\\\\[^\s\\]+[\\/]"
    r"|file://"
    r"|(?<![\w.\-])~[/\\]"
    r"|(?<![\w.\-])/(?:Users|home|root|Volumes|mnt|media|private)/)"
    r"[^\s\"'<>|;,]*"
)

# 导出侧的凭据键判据比导入侧宽。导入侧（`_find_secret`）是硬门禁，认错一个键
# 就让一份正常工作流进不来；导出只是把值换成占位并逐条列进 `redacted`，
# 用户看得见自己少了什么，所以宁可多抹一个。
_EXPORT_SECRET_KEYS = _SECRET_KEYS | frozenset(
    {
        "token",
        "apisecret",
        "private_key",
        "privatekey",
        "passwd",
        "credential",
        "credentials",
    }
)

# 带前缀的写法：`x_api_key`、`auth_token`、`webhook_secret`。
# 只认完整的后缀段，所以 ComfyUI 真实存在的 `tokenizer`、`token_normalization`
# 不会被误伤——那两个抹掉会直接把节点弄坏。
_EXPORT_SECRET_SUFFIXES = (
    "_api_key",
    "_apikey",
    "_secret",
    "_token",
    "_password",
    "_passwd",
    "_credential",
)


def is_export_secret_key(normalized: str) -> bool:
    """这个键名是不是该在导出物里抹掉。入参是归一化过的键（小写、连字符换下划线）。"""
    return normalized in _EXPORT_SECRET_KEYS or normalized.endswith(_EXPORT_SECRET_SUFFIXES)


_COMFY_META = {
    "2511": ("2511 风格迁移", "edit"),
    "Flux2-Klein": ("Flux2 Klein 多参考生成", "edit"),
    "LTXDirectorv2-API": ("LTX Director v2", "video"),
    "MiniMax_H3": ("MiniMax H3", "video"),
    "Z-Image-Enhance": ("Z-Image 细节增强", "edit"),
    "Z-Image": ("Z-Image 生图", "image"),
    "upscale": ("SeedVR2 高清放大", "upscale"),
}


class StudioWorkflowError(ValueError):
    def __init__(self, message: str, status: int = 400) -> None:
        super().__init__(message)
        self.status = status


def _read_json(path: Path) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise StudioWorkflowError(f"工作流资源读取失败：{path.name}：{exc}", 500) from exc


def _hash(payload: dict, ui_schema: dict | None) -> str:
    packed = json.dumps(
        {"payload": payload, "ui_schema": ui_schema},
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode()
    return hashlib.sha256(packed).hexdigest()


def _find_secret(value: Any, path: str = "") -> str | None:
    if isinstance(value, dict):
        for key, child in value.items():
            normalized = str(key).strip().lower().replace("-", "_")
            child_path = f"{path}.{key}" if path else str(key)
            if normalized in _SECRET_KEYS and child not in (None, "", False):
                return child_path
            found = _find_secret(child, child_path)
            if found:
                return found
    elif isinstance(value, list):
        for index, child in enumerate(value):
            found = _find_secret(child, f"{path}[{index}]")
            if found:
                return found
    return None


def validate_definition(payload: dict, ui_schema: dict | None = None) -> None:
    if not payload:
        raise StudioWorkflowError("工作流 JSON 不能为空")
    secret_path = _find_secret({"payload": payload, "ui_schema": ui_schema})
    if secret_path:
        raise StudioWorkflowError(
            f"工作流不能夹带密钥（{secret_path}），请放到供应商凭据"
        )


def validate_comfy_definition(payload: dict, ui_schema: dict | None = None) -> None:
    """校验 ComfyUI API 节点图及用户暴露的输入映射。"""
    validate_definition(payload, ui_schema)
    nodes = {
        str(node_id): node
        for node_id, node in payload.items()
        if isinstance(node, dict) and isinstance(node.get("class_type"), str)
    }
    if not nodes:
        raise StudioWorkflowError("不是有效的 ComfyUI API 工作流（缺少 class_type 节点）")
    fields = (ui_schema or {}).get("fields") or []
    if not isinstance(fields, list):
        raise StudioWorkflowError("工作流 fields 必须是数组")
    seen: set[str] = set()
    for index, raw in enumerate(fields):
        if not isinstance(raw, dict):
            raise StudioWorkflowError(f"工作流参数 {index + 1} 不是对象")
        field_id = str(raw.get("id") or "").strip()
        if not field_id:
            raise StudioWorkflowError(f"工作流参数 {index + 1} 缺少 id")
        if field_id in seen:
            raise StudioWorkflowError(f"工作流参数 id 重复：{field_id}")
        seen.add(field_id)
        if str(raw.get("type") or "").lower() == "minimax_refs":
            continue
        node_id = str(raw.get("node") or raw.get("nodeId") or "").strip()
        input_name = str(raw.get("input") or raw.get("fieldName") or "").strip()
        node = nodes.get(node_id)
        if node is None:
            raise StudioWorkflowError(f"参数 {field_id} 指向不存在的节点：{node_id}")
        inputs = node.get("inputs")
        if not isinstance(inputs, dict) or input_name not in inputs:
            raise StudioWorkflowError(
                f"参数 {field_id} 指向不存在的输入：{node_id}.{input_name}"
            )


def _node_count(payload: dict) -> int:
    return sum(
        1
        for value in payload.values()
        if isinstance(value, dict) and isinstance(value.get("class_type"), str)
    )


def _field_count(ui_schema: dict | None) -> int:
    fields = (ui_schema or {}).get("fields", [])
    return len(fields) if isinstance(fields, list) else 0


def workflow_view(row: StudioWorkflow, *, detail: bool = False) -> dict:
    result = {
        "id": row.id,
        "key": row.key,
        "title": row.title,
        "provider": row.provider,
        "kind": row.kind,
        "source": row.source,
        "source_id": row.source_id,
        "enabled": row.enabled,
        "node_count": _node_count(row.payload or {}),
        "field_count": _field_count(row.ui_schema),
        "has_thumbnail": bool(row.thumbnail_key),
        "content_hash": row.content_hash,
        "version": row.version or 1,
        "created_at": row.created_at.isoformat() if row.created_at else None,
        "updated_at": row.updated_at.isoformat() if row.updated_at else None,
    }
    if detail:
        result["payload"] = row.payload
        result["ui_schema"] = row.ui_schema
    return result


def _snapshot(row: StudioWorkflow) -> dict:
    """进版本链的那一份：定义本身 + 输入映射 + 名字。启停状态不进——
    停用一下不该多出一版，回滚正文也不该顺手把它重新启用。"""
    return {
        "title": row.title,
        "provider": row.provider,
        "kind": row.kind,
        "payload": row.payload or {},
        "ui_schema": row.ui_schema,
        "content_hash": row.content_hash,
    }


# ---- 导出脱敏 ----


def _looks_local_path(value: str) -> bool:
    if len(value) > _PATH_MAX_LEN:
        return False
    if _LOCAL_PREFIX_RE.match(value):
        return True
    # 带查询串的是 URL 不是路径。ComfyUI 的 rgthree 比较节点会把
    # `/api/view?filename=…` 这样的预览地址存进图里，抹掉它只会把节点的界面状态
    # 弄坏，而它既不是凭据也暴露不了本机目录结构
    if "?" in value or "&" in value:
        return False
    return _POSIX_PATH_RE.match(value) is not None


def scrub_export(value: Any, path: str = "") -> tuple[Any, list[str]]:
    """把凭据字段与本机绝对路径抹掉，返回脱敏后的值和被抹掉的字段路径。

    两条一起做，因为导出物的两个失败模式是同构的：一个泄密钥，一个泄本机目录结构
    （`/Users/<用户名>/...` 连人名一起带出去，换台机器还根本打不开）。
    抹掉而不是拒绝导出：工作流的其余部分照样有用，把整次导出否掉只会逼用户
    去手改 JSON；被抹的位置逐条列在 `redacted` 里，用户看得见自己少了什么。
    """
    redacted: list[str] = []
    if isinstance(value, dict):
        out: dict[str, Any] = {}
        for key, child in value.items():
            child_path = f"{path}.{key}" if path else str(key)
            normalized = str(key).strip().lower().replace("-", "_")
            if is_export_secret_key(normalized) and child not in (None, "", False):
                out[key] = REDACTED_SECRET
                redacted.append(child_path)
                continue
            cleaned, hits = scrub_export(child, child_path)
            out[key] = cleaned
            redacted.extend(hits)
        return out, redacted
    if isinstance(value, list):
        items: list[Any] = []
        for index, child in enumerate(value):
            cleaned, hits = scrub_export(child, f"{path}[{index}]")
            items.append(cleaned)
            redacted.extend(hits)
        return items, redacted
    if isinstance(value, str):
        if _looks_local_path(value):
            return REDACTED_PATH, [path or "<root>"]
        # 整串不是路径，还要看它有没有把一条路径夹在中间
        cleaned_text, found = _EMBEDDED_PATH_RE.subn(REDACTED_PATH, value)
        if found:
            return cleaned_text, [path or "<root>"]
    return value, redacted


def build_export(row: StudioWorkflow) -> dict:
    """自包含的导出物：拿着这一份 JSON 就能在另一台机器上原样导回来。

    `content_hash` 按**脱敏后**的定义重算，让导出物自洽：真被抹掉了东西的话，
    它和库里那条的哈希本来就不该一样，照抄原值反而会让人误以为两边内容相同。
    """
    payload, payload_hits = scrub_export(row.payload or {}, "payload")
    ui_schema, schema_hits = scrub_export(row.ui_schema, "ui_schema")
    redacted = payload_hits + schema_hits
    return {
        "format": EXPORT_FORMAT,
        "format_version": EXPORT_VERSION,
        "exported_at": datetime.now(UTC).isoformat(),
        "redacted": redacted,
        "workflow": {
            "title": row.title,
            "provider": row.provider,
            "kind": row.kind,
            "version": row.version or 1,
            "content_hash": _hash(payload, ui_schema),
            "payload": payload,
            "ui_schema": ui_schema,
        },
    }


def export_filename(row: StudioWorkflow) -> str:
    """导出文件名。只挡路径分隔符与控制字符——响应头走 `filename*=UTF-8''`，
    中文名字能原样带出去，没必要为了保险把标题削成 ASCII（削完中文标题全都变成
    `workflow-12`，用户导出三条就分不清哪个是哪个）。"""
    stem = re.sub(r"[\\/\x00-\x1f]+", "-", row.title or "").strip(" .-")
    if not stem:
        stem = f"workflow-{row.id}"
    return f"{stem[:64]}-v{row.version or 1}.json"


def parse_export(data: Any) -> dict | None:
    """认出导出物并拆开；不是导出物就返回 None，让调用方按裸节点图处理。"""
    if not isinstance(data, dict) or data.get("format") != EXPORT_FORMAT:
        return None
    version = data.get("format_version")
    if version != EXPORT_VERSION:
        raise StudioWorkflowError(
            f"这份导出物是第 {version} 版格式，当前只认第 {EXPORT_VERSION} 版"
        )
    workflow = data.get("workflow")
    if not isinstance(workflow, dict):
        raise StudioWorkflowError("导出物缺少 workflow 段，不是完整的导出文件")
    payload = workflow.get("payload")
    if not isinstance(payload, dict) or not payload:
        raise StudioWorkflowError("导出物里的工作流定义是空的")
    ui_schema = workflow.get("ui_schema")
    return {
        "title": str(workflow.get("title") or "").strip(),
        "provider": str(workflow.get("provider") or "").strip(),
        "kind": str(workflow.get("kind") or "").strip(),
        "payload": payload,
        "ui_schema": ui_schema if isinstance(ui_schema, dict) else None,
    }


def _bundled_definitions() -> list[dict]:
    definitions: list[dict] = []
    for path in sorted(COMFY_ROOT.glob("*.json")):
        if path.name.endswith(".config.json"):
            continue
        stem = path.stem
        title, kind = _COMFY_META.get(stem, (stem, "workflow"))
        config_path = COMFY_ROOT / f"{stem}.config.json"
        ui_schema = _read_json(config_path) if config_path.exists() else None
        payload = _read_json(path)
        definitions.append(
            {
                "key": f"comfyui:{stem}",
                "title": title,
                "provider": "comfyui",
                "kind": kind,
                "source_id": stem,
                "payload": payload,
                "ui_schema": ui_schema,
                "thumbnail_key": None,
            }
        )

    provider_rows = _read_json(RUNNINGHUB_ROOT / "api_providers.json")
    provider = provider_rows[0] if isinstance(provider_rows, list) and provider_rows else {}
    for collection, kind in (("rh_apps", "app"), ("rh_workflows", "workflow")):
        for item in provider.get(collection, []):
            source_id = str(item.get("id") or item.get("appId") or "").strip()
            if not source_id:
                continue
            thumbnail_name = f"workflow-{source_id}.jpg"
            thumbnail_path = RUNNINGHUB_ROOT / "thumbnails" / thumbnail_name
            fields = item.get("fields") if isinstance(item.get("fields"), list) else []
            definitions.append(
                {
                    "key": f"runninghub:{source_id}",
                    "title": str(item.get("title") or source_id),
                    "provider": "runninghub",
                    "kind": kind,
                    "source_id": source_id,
                    "payload": {
                        "id": source_id,
                        "app_id": str(item.get("appId") or source_id),
                        "note": str(item.get("note") or ""),
                        "type": collection,
                    },
                    "ui_schema": {"fields": fields},
                    "thumbnail_key": (
                        f"runninghub/thumbnails/{thumbnail_name}"
                        if thumbnail_path.exists()
                        else None
                    ),
                }
            )
    return definitions


async def ensure_bundled(session: AsyncSession) -> dict:
    created = 0
    updated = 0
    for item in _bundled_definitions():
        validate_definition(item["payload"], item["ui_schema"])
        content_hash = _hash(item["payload"], item["ui_schema"])
        row = (
            await session.execute(
                select(StudioWorkflow).where(StudioWorkflow.key == item["key"])
            )
        ).scalar_one_or_none()
        if row is None:
            fresh = StudioWorkflow(
                **item,
                source="bundled",
                content_hash=content_hash,
                enabled=True,
                version=1,
            )
            session.add(fresh)
            await session.flush()
            await studio_revisions.record(
                session,
                studio_revisions.ENTITY_WORKFLOW,
                fresh.id,
                snapshot=_snapshot(fresh),
                note="随版本内置",
                version=1,
            )
            created += 1
            continue
        if row.source != "bundled" or row.content_hash == content_hash:
            continue
        for key, value in item.items():
            setattr(row, key, value)
        row.content_hash = content_hash
        # 内置定义随发版换了内容也留一版：用户看得出「今天这条工作流跑出来
        # 和上周不一样」是因为内置定义升级了，而不是自己改坏了
        row.version = await studio_revisions.next_version(
            session, studio_revisions.ENTITY_WORKFLOW, row.id
        )
        await studio_revisions.record(
            session,
            studio_revisions.ENTITY_WORKFLOW,
            row.id,
            snapshot=_snapshot(row),
            note="内置定义随版本更新",
            version=row.version,
        )
        updated += 1
    if created or updated:
        await session.commit()
    return {"created": created, "updated": updated}


async def list_workflows(
    session: AsyncSession,
    *,
    provider: str | None = None,
    kind: str | None = None,
    enabled: bool | None = None,
) -> list[dict]:
    await ensure_bundled(session)
    stmt = select(StudioWorkflow)
    if provider:
        stmt = stmt.where(StudioWorkflow.provider == provider)
    if kind:
        stmt = stmt.where(StudioWorkflow.kind == kind)
    if enabled is not None:
        stmt = stmt.where(StudioWorkflow.enabled.is_(enabled))
    rows = (
        await session.execute(
            stmt.order_by(StudioWorkflow.source.asc(), StudioWorkflow.title.asc())
        )
    ).scalars()
    return [workflow_view(row) for row in rows]


async def get_workflow(session: AsyncSession, workflow_id: int) -> StudioWorkflow:
    await ensure_bundled(session)
    row = await session.get(StudioWorkflow, workflow_id)
    if row is None:
        raise StudioWorkflowError("工作流不存在", 404)
    return row


async def import_workflow(
    session: AsyncSession,
    *,
    title: str,
    provider: str,
    kind: str,
    payload: dict,
    ui_schema: dict | None,
) -> StudioWorkflow:
    bundle = parse_export(payload)
    if bundle is not None:
        # 导出物走同一个导入口：供应商、类型、输入映射一律以导出物为准，
        # 表单上选错的那两个下拉框不该把一份完整的工作流改坏。
        # 名字仍允许调用方覆盖——重名的两条工作流在列表里分不出来
        provider = bundle["provider"] or provider
        kind = bundle["kind"] or kind
        payload = bundle["payload"]
        ui_schema = bundle["ui_schema"]
        title = title.strip() or bundle["title"]
    cleaned_title = title.strip()
    if not cleaned_title:
        raise StudioWorkflowError("工作流名称不能为空")
    if provider not in PROVIDERS:
        raise StudioWorkflowError(f"不支持的工作流供应商：{provider}")
    if kind not in KINDS:
        raise StudioWorkflowError(f"不支持的工作流类型：{kind}")
    if provider == "comfyui":
        validate_comfy_definition(payload, ui_schema)
    else:
        validate_definition(payload, ui_schema)
    row = StudioWorkflow(
        key=f"user:{uuid.uuid4().hex}",
        title=cleaned_title,
        provider=provider,
        kind=kind,
        source="user",
        payload=payload,
        ui_schema=ui_schema,
        content_hash=_hash(payload, ui_schema),
        enabled=True,
        version=1,
    )
    session.add(row)
    await session.flush()
    await studio_revisions.record(
        session,
        studio_revisions.ENTITY_WORKFLOW,
        row.id,
        snapshot=_snapshot(row),
        note="导入",
        version=1,
    )
    await session.commit()
    await session.refresh(row)
    return row


async def update_workflow(
    session: AsyncSession,
    row: StudioWorkflow,
    *,
    enabled: bool | None = None,
    title: str | None = None,
    ui_schema: dict | None = None,
    update_definition: bool = False,
    note: str | None = None,
) -> StudioWorkflow:
    """更新目录项；内置定义只允许启停，避免下次种子同步覆盖用户编辑。"""
    if update_definition and row.source != "user":
        raise StudioWorkflowError("内置工作流不能改名或修改输入映射，可以停用", 409)
    before = _snapshot(row)
    if enabled is not None:
        row.enabled = enabled
    if title is not None:
        cleaned = title.strip()
        if not cleaned:
            raise StudioWorkflowError("工作流名称不能为空")
        row.title = cleaned
    if update_definition:
        if row.provider == "comfyui":
            validate_comfy_definition(row.payload or {}, ui_schema)
        else:
            validate_definition(row.payload or {}, ui_schema)
        row.ui_schema = ui_schema
        row.content_hash = _hash(row.payload or {}, ui_schema)
    if _snapshot(row) != before:
        # RunningHub 目录同步建出来的行不经过 import_workflow，链是空的。
        # 先把「改之前」补成第 1 版，否则用户第一次编辑就把原样弄丢了
        await studio_revisions.ensure_baseline(
            session,
            studio_revisions.ENTITY_WORKFLOW,
            row.id,
            snapshot=before,
            note="首次编辑前的内容",
        )
        row.version = await studio_revisions.next_version(
            session, studio_revisions.ENTITY_WORKFLOW, row.id
        )
        await studio_revisions.record(
            session,
            studio_revisions.ENTITY_WORKFLOW,
            row.id,
            snapshot=_snapshot(row),
            note=note,
            version=row.version,
        )
    await session.commit()
    await session.refresh(row)
    return row


async def delete_workflow(session: AsyncSession, row: StudioWorkflow) -> None:
    """删目录项连同它的版本链。历史留着也没有实体可回滚，只会挂成孤儿行。"""
    if row.source == "bundled":
        raise StudioWorkflowError("内置工作流不能删除，可以停用", 409)
    await studio_revisions.drop_entity(session, studio_revisions.ENTITY_WORKFLOW, row.id)
    await session.delete(row)
    await session.commit()


# ---- 版本历史 ----


async def list_workflow_revisions(session: AsyncSession, workflow_id: int) -> list[dict]:
    return await studio_revisions.list_revisions(
        session, studio_revisions.ENTITY_WORKFLOW, workflow_id
    )


async def restore_workflow(
    session: AsyncSession, row: StudioWorkflow, version: int
) -> StudioWorkflow:
    """回滚到某一版。与提示词同一条口径：旧内容重新提交成新的一版，版本号只增不减。

    内置工作流照样能回滚——回滚出来的内容会在下一次种子同步时被内置定义盖回去，
    所以这里直接拒绝，免得用户以为改成功了（BR-110 不伪造）。
    """
    if row.source != "user":
        raise StudioWorkflowError("内置工作流不能回滚，下次同步会被内置定义盖回去", 409)
    revision = await studio_revisions.get_revision(
        session, studio_revisions.ENTITY_WORKFLOW, row.id, version
    )
    snapshot = revision.snapshot or {}
    payload = snapshot.get("payload")
    if not isinstance(payload, dict) or not payload:
        raise StudioWorkflowError(f"第 {version} 版的定义是空的，没法回滚", 409)
    ui_schema = snapshot.get("ui_schema")
    ui_schema = ui_schema if isinstance(ui_schema, dict) else None
    title = str(snapshot.get("title") or row.title).strip()
    if row.provider == "comfyui":
        validate_comfy_definition(payload, ui_schema)
    else:
        validate_definition(payload, ui_schema)
    row.title = title or row.title
    row.payload = payload
    row.ui_schema = ui_schema
    row.content_hash = _hash(payload, ui_schema)
    row.version = await studio_revisions.next_version(
        session, studio_revisions.ENTITY_WORKFLOW, row.id
    )
    await studio_revisions.record(
        session,
        studio_revisions.ENTITY_WORKFLOW,
        row.id,
        snapshot=_snapshot(row),
        note=f"回滚到第 {version} 版",
        version=row.version,
    )
    await session.commit()
    await session.refresh(row)
    return row


async def pin_workflow_revision(
    session: AsyncSession, workflow_id: int, version: int, pinned: bool
) -> dict:
    return await studio_revisions.set_pinned(
        session, studio_revisions.ENTITY_WORKFLOW, workflow_id, version, pinned
    )


def thumbnail_path(row: StudioWorkflow) -> Path | None:
    if not row.thumbnail_key:
        return None
    path = (RESOURCE_ROOT / row.thumbnail_key).resolve()
    if RESOURCE_ROOT.resolve() not in path.parents or not path.is_file():
        return None
    return path
