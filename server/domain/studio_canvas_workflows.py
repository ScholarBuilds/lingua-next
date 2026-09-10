"""可移植的画布子图导入导出。

JSON 包只保存资产指纹；ZIP 包额外携带原始字节。导入时先按 sha256 复用本机
资产，缺失且包内有字节时才重建，避免把另一台机器上的数据库 id 当成同一张图。
"""

from __future__ import annotations

import copy
import hashlib
import json
import mimetypes
import re
import zipfile
from contextlib import suppress
from io import BytesIO
from pathlib import PurePosixPath
from typing import Any
from uuid import uuid4

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from domain import image_assets, studio, studio_media_assets, studio_workflows
from domain.models import ImageAsset, StudioMediaAsset, StudioWorkflow
from domain.storage import get_storage

FORMAT = "lingua-canvas-workflow"
VERSION = 1
INFINITE_EXPORT_FORMAT = "infinite-canvas-workflow"
CANVAS_FORMAT = "lingua-canvas"
CANVAS_VERSION = 1
MAX_IMPORT_BYTES = 512 * 1024 * 1024
MAX_ARCHIVE_FILES = 1000
MAX_OUTPUT_DOWNLOADS = 100
INFINITE_CANVAS_FORMATS = {
    "infinite-canvas-workflow",
    "infinite-smart-canvas-workflow",
}


class CanvasWorkflowError(ValueError):
    pass


def _safe_filename(value: str, fallback: str) -> str:
    name = PurePosixPath((value or "").replace("\\", "/")).name
    name = re.sub(r"[^\w.()\[\] -]+", "_", name, flags=re.UNICODE).strip(" .")
    return name[:160] or fallback


def _extension(mime: str, name: str = "") -> str:
    suffix = PurePosixPath(name).suffix.lower()
    if suffix and len(suffix) <= 12:
        return suffix
    return mimetypes.guess_extension(mime) or ".bin"


def _collect_ids(nodes: list[dict]) -> tuple[set[int], set[int]]:
    image_ids: set[int] = set()
    media_ids: set[int] = set()
    for node in nodes:
        for field in ("items", "attachments", "manual_references"):
            for item in node.get(field) or []:
                if not isinstance(item, dict):
                    continue
                if isinstance(item.get("asset_id"), int):
                    image_ids.add(item["asset_id"])
                if isinstance(item.get("media_asset_id"), int):
                    media_ids.add(item["media_asset_id"])
        for ref in node.get("prompt_draft_refs") or []:
            if isinstance(ref, dict) and isinstance(ref.get("asset_id"), int):
                image_ids.add(ref["asset_id"])
        timeline = node.get("workflow_timeline")
        if isinstance(timeline, dict):
            for segment in timeline.get("segments") or []:
                if not isinstance(segment, dict):
                    continue
                if isinstance(segment.get("asset_id"), int):
                    image_ids.add(segment["asset_id"])
                timeline_items = [
                    *(segment.get("references") or []),
                    *([segment["result"]] if isinstance(segment.get("result"), dict) else []),
                ]
                for item in timeline_items:
                    if not isinstance(item, dict):
                        continue
                    if isinstance(item.get("asset_id"), int):
                        image_ids.add(item["asset_id"])
                    if isinstance(item.get("media_asset_id"), int):
                        media_ids.add(item["media_asset_id"])
            for segment in timeline.get("audio_segments") or []:
                if isinstance(segment, dict) and isinstance(segment.get("media_asset_id"), int):
                    media_ids.add(segment["media_asset_id"])
        values = node.get("workflow_values")
        if isinstance(values, dict):
            for value in values.values():
                if isinstance(value, str) and value.startswith("asset:"):
                    with suppress(ValueError):
                        image_ids.add(int(value.removeprefix("asset:")))
    return image_ids, media_ids


async def _load_assets(
    session: AsyncSession,
    image_ids: set[int],
    media_ids: set[int],
) -> tuple[dict[int, ImageAsset], dict[int, StudioMediaAsset]]:
    images: dict[int, ImageAsset] = {}
    media: dict[int, StudioMediaAsset] = {}
    if image_ids:
        rows = (
            await session.execute(select(ImageAsset).where(ImageAsset.id.in_(image_ids)))
        ).scalars()
        images = {row.id: row for row in rows}
    if media_ids:
        rows = (
            await session.execute(
                select(StudioMediaAsset).where(StudioMediaAsset.id.in_(media_ids))
            )
        ).scalars()
        media = {row.id: row for row in rows}
    return images, media


async def build_output_image_archive(
    session: AsyncSession,
    *,
    asset_ids: list[int],
) -> bytes:
    """把 Output 节点里的图片原图打成一个纯资源 ZIP。

    这条端点只接受已入库的 asset id，不接受 URL：否则「批量下载」
    就会变成一个能访问任意内网地址的 SSRF 入口。
    """

    ordered = list(dict.fromkeys(asset_ids))
    if not ordered:
        raise CanvasWorkflowError("输出节点里没有可下载的已入库图片")
    if len(ordered) > MAX_OUTPUT_DOWNLOADS:
        raise CanvasWorkflowError(
            f"一次最多下载 {MAX_OUTPUT_DOWNLOADS} 张图片"
        )
    if any(
        not isinstance(asset_id, int)
        or isinstance(asset_id, bool)
        or asset_id <= 0
        for asset_id in ordered
    ):
        raise CanvasWorkflowError("asset_ids 必须是正整数")

    images, _ = await _load_assets(session, set(ordered), set())
    missing = [asset_id for asset_id in ordered if asset_id not in images]
    if missing:
        shown = "、".join(map(str, missing[:8]))
        suffix = "…" if len(missing) > 8 else ""
        raise CanvasWorkflowError(f"图片资产不存在：{shown}{suffix}")

    archive = BytesIO()
    storage = get_storage()
    with zipfile.ZipFile(archive, "w", zipfile.ZIP_DEFLATED) as bundle:
        for index, asset_id in enumerate(ordered, 1):
            row = images[asset_id]
            suffix = _extension(row.mime)
            filename = f"image-{index:02d}-{row.id}{suffix}"
            bundle.writestr(filename, await storage.read(row.storage_key))
    return archive.getvalue()


def _resource_for_image(row: ImageAsset) -> dict[str, Any]:
    ref = f"image:{row.sha256}"
    return {
        "ref": ref,
        "kind": "image",
        "sha256": row.sha256,
        "mime": row.mime,
        "name": f"image-{row.id}{_extension(row.mime)}",
        "bytes": row.bytes,
        "width": row.width,
        "height": row.height,
        "prompt": row.prompt or "",
        "target_key": row.target_key or "workflow-import",
    }


def _resource_for_media(row: StudioMediaAsset) -> dict[str, Any]:
    ref = f"media:{row.sha256}"
    return {
        "ref": ref,
        "kind": row.kind,
        "sha256": row.sha256,
        "mime": row.mime,
        "name": row.name,
        "bytes": row.bytes,
        "width": row.width,
        "height": row.height,
        "duration_ms": row.duration_ms,
    }


def _portable_nodes(
    nodes: list[dict],
    images: dict[int, ImageAsset],
    media: dict[int, StudioMediaAsset],
) -> list[dict]:
    out = copy.deepcopy(nodes)
    for node in out:
        for field in ("items", "attachments", "manual_references"):
            portable_items: list[dict] = []
            for raw in node.get(field) or []:
                if not isinstance(raw, dict):
                    continue
                item = dict(raw)
                image_id = item.pop("asset_id", None)
                media_id = item.pop("media_asset_id", None)
                image = images.get(image_id) if isinstance(image_id, int) else None
                media_row = media.get(media_id) if isinstance(media_id, int) else None
                if image is not None:
                    item["resource_ref"] = f"image:{image.sha256}"
                    item.pop("url", None)
                    item.pop("missing", None)
                elif isinstance(image_id, int):
                    item["missing"] = True
                if media_row is not None:
                    item["resource_ref"] = f"media:{media_row.sha256}"
                    item.pop("url", None)
                    item.pop("poster_url", None)
                    item.pop("missing", None)
                elif isinstance(media_id, int):
                    item["missing"] = True
                portable_items.append(item)
            if field in node:
                node[field] = portable_items

        portable_refs: list[dict] = []
        for raw in node.get("prompt_draft_refs") or []:
            if not isinstance(raw, dict):
                continue
            ref = dict(raw)
            image_id = ref.pop("asset_id", None)
            image = images.get(image_id) if isinstance(image_id, int) else None
            if image is not None:
                ref["resource_ref"] = f"image:{image.sha256}"
                portable_refs.append(ref)
        if "prompt_draft_refs" in node:
            node["prompt_draft_refs"] = portable_refs

        timeline = node.get("workflow_timeline")
        if isinstance(timeline, dict):
            next_timeline = copy.deepcopy(timeline)
            for segment in next_timeline.get("segments") or []:
                if not isinstance(segment, dict):
                    continue
                image_id = segment.pop("asset_id", None)
                image = images.get(image_id) if isinstance(image_id, int) else None
                if image is not None:
                    segment["resource_ref"] = f"image:{image.sha256}"
                    segment.pop("imageB64", None)
                    segment.pop("imageFile", None)
                elif isinstance(image_id, int):
                    segment["missing"] = True
                if isinstance(segment.get("references"), list):
                    segment["references"] = [
                        _portable_canvas_item(item, images, media)
                        for item in segment["references"]
                        if isinstance(item, dict)
                    ]
                if isinstance(segment.get("result"), dict):
                    segment["result"] = _portable_canvas_item(segment["result"], images, media)
            for segment in next_timeline.get("audio_segments") or []:
                if not isinstance(segment, dict):
                    continue
                media_id = segment.pop("media_asset_id", None)
                media_row = media.get(media_id) if isinstance(media_id, int) else None
                if media_row is not None:
                    segment["resource_ref"] = f"media:{media_row.sha256}"
                    segment.pop("audioFile", None)
                    segment.pop("audioB64", None)
                elif isinstance(media_id, int):
                    segment["missing"] = True
            node["workflow_timeline"] = next_timeline

        values = node.get("workflow_values")
        if isinstance(values, dict):
            next_values = dict(values)
            for key, value in values.items():
                if not isinstance(value, str) or not value.startswith("asset:"):
                    continue
                try:
                    image = images.get(int(value.removeprefix("asset:")))
                except ValueError:
                    image = None
                next_values[key] = f"resource:image:{image.sha256}" if image is not None else ""
            node["workflow_values"] = next_values
    return out


def _portable_canvas_item(
    raw: dict[str, Any],
    images: dict[int, ImageAsset],
    media: dict[int, StudioMediaAsset],
) -> dict[str, Any]:
    item = dict(raw)
    image_id = item.pop("asset_id", None)
    media_id = item.pop("media_asset_id", None)
    image = images.get(image_id) if isinstance(image_id, int) else None
    media_row = media.get(media_id) if isinstance(media_id, int) else None
    if image is not None:
        item["resource_ref"] = f"image:{image.sha256}"
        item["kind"] = "image"
        item.pop("url", None)
        item.pop("missing", None)
    elif isinstance(image_id, int):
        item["missing"] = True
    if media_row is not None:
        item["resource_ref"] = f"media:{media_row.sha256}"
        item["kind"] = media_row.kind
        item.pop("url", None)
        item.pop("poster_url", None)
        item.pop("missing", None)
    elif isinstance(media_id, int):
        item["missing"] = True
    return item


def _infinite_resource_urls(resources: list[dict[str, Any]]) -> dict[str, str]:
    return {
        str(item["ref"]): (
            f"/output/lingua-{item['sha256'][:20]}"
            f"{_extension(str(item.get('mime') or ''), str(item.get('name') or ''))}"
        )
        for item in resources
        if item.get("ref") and item.get("sha256")
    }


def _infinite_item(raw: dict[str, Any], urls: dict[str, str]) -> dict[str, Any] | None:
    ref = str(raw.get("resource_ref") or "")
    url = urls.get(ref) or str(raw.get("url") or "").strip()
    if not url:
        return None
    kind = str(raw.get("kind") or "image")
    out: dict[str, Any] = {
        "url": url,
        "name": _safe_filename(str(raw.get("name") or ""), PurePosixPath(url).name),
        "kind": kind,
    }
    if isinstance(raw.get("w"), (int, float)):
        out["natural_w"] = raw["w"]
    if isinstance(raw.get("h"), (int, float)):
        out["natural_h"] = raw["h"]
    return out


def _infinite_values(value: Any, urls: dict[str, str]) -> Any:
    if isinstance(value, list):
        return [_infinite_values(item, urls) for item in value]
    if isinstance(value, dict):
        if value.get("resource_ref"):
            restored = _infinite_item(value, urls)
            return restored if restored is not None else _redact_legacy(value)
        return {key: _infinite_values(item, urls) for key, item in value.items()}
    if isinstance(value, str) and value.startswith("resource:"):
        return urls.get(value.removeprefix("resource:"), "")
    return value


def _infinite_timeline(
    timeline: dict[str, Any],
    urls: dict[str, str],
) -> tuple[str, dict[str, Any]]:
    kind = str(timeline.get("kind") or "")
    if kind == "minimax":
        segments: list[dict[str, Any]] = []
        for raw in timeline.get("segments") or []:
            if not isinstance(raw, dict):
                continue
            segment = {
                "id": str(raw.get("id") or uuid4().hex),
                "start": raw.get("start", 0),
                "duration": raw.get("length", 8),
                "prompt": str(raw.get("prompt") or ""),
                "aspectRatio": str(raw.get("aspect_ratio") or "16:9 (Widescreen)"),
                "megapixels": raw.get("megapixels", 0.4),
                "seed": raw.get("seed", 0),
                "trimIn": raw.get("trim_in", 0),
                "trimOut": raw.get("trim_out", raw.get("length", 8)),
                "refs": [
                    item
                    for item in (
                        _infinite_item(value, urls)
                        for value in raw.get("references") or []
                        if isinstance(value, dict)
                    )
                    if item is not None
                ],
            }
            if isinstance(raw.get("result"), dict):
                result = _infinite_item(raw["result"], urls)
                if result is not None:
                    segment["result"] = result
            segments.append(segment)
        return "minimax", {
            "segments": segments,
            "selectedSegmentId": str(timeline.get("selected_id") or ""),
        }

    segments = []
    for raw in timeline.get("segments") or []:
        if not isinstance(raw, dict):
            continue
        segment = {
            "id": str(raw.get("id") or uuid4().hex),
            "start": raw.get("start", 0),
            "length": raw.get("length", 1),
            "prompt": str(raw.get("prompt") or ""),
            "type": str(raw.get("type") or "text"),
            "guideStrength": raw.get("guideStrength", 1),
        }
        direct = _infinite_item(raw, urls)
        if direct is not None:
            segment["imageB64"] = direct["url"]
            segment["imageFile"] = direct["name"]
        segments.append(segment)
    audio_segments = []
    for raw in timeline.get("audio_segments") or []:
        if not isinstance(raw, dict):
            continue
        item = _infinite_item(raw, urls)
        audio = {
            "id": str(raw.get("id") or uuid4().hex),
            "start": raw.get("start", 0),
            "length": raw.get("length", 1),
            "trimStart": raw.get("trim_start", 0),
            "audioDurationFrames": raw.get("audio_duration_frames", raw.get("length", 1)),
            "fileName": str(raw.get("name") or ""),
        }
        if item is not None:
            audio["audioUrl"] = item["url"]
            audio["fileName"] = item["name"]
        audio_segments.append(audio)
    return "ltxDirector", {
        "ltxTimelineData": json.dumps(
            {"segments": segments, "audioSegments": audio_segments},
            ensure_ascii=False,
        ),
        "ltxSelectedSegId": str(timeline.get("selected_id") or ""),
        "frameRate": timeline.get("frame_rate", 24),
        "durationFrames": timeline.get("duration_frames", 120),
    }


def _infinite_source_type(node: dict[str, Any]) -> str:
    source = str(node.get("source_type") or "").strip()
    aliases = {
        "api": "generator",
        "modelscope": "msgen",
        "smart-image": "image",
        "smart-prompt": "prompt",
        "smart-loop": "loop",
        "smart-group": "group",
        "smart-minimax": "minimax",
        "ltx": "ltxDirector",
        "ltxdirector": "ltxDirector",
        "ltx-director": "ltxDirector",
        "runninghub": "rh",
    }
    supported = {
        "image", "prompt", "loop", "group", "promptGroup", "output", "llm",
        "generator", "midjourney", "msgen", "video", "minimax", "rh", "comfy",
        "ltxDirector",
    }
    candidate = aliases.get(source.lower(), source)
    if candidate in supported:
        return candidate
    target = str(node.get("type") or "prompt")
    if target == "modelscope":
        return "msgen"
    if target == "workflow":
        title = str(node.get("title") or "").lower()
        if node.get("workflow_provider") == "runninghub":
            return "rh"
        if "minimax" in title:
            return "minimax"
        if "ltx" in title:
            return "ltxDirector"
        return "comfy"
    if target in {"audio", "file"}:
        return "image"
    return target if target in supported else "prompt"


def _infinite_node(
    node: dict[str, Any],
    urls: dict[str, str],
) -> list[dict[str, Any]]:
    source_payload = node.get("source_payload")
    out = copy.deepcopy(source_payload) if isinstance(source_payload, dict) else {}
    source_type = _infinite_source_type(node)
    common: dict[str, Any] = {
        "id": str(node.get("id") or uuid4().hex),
        "type": source_type,
        "x": float(node.get("x") or 0),
        "y": float(node.get("y") or 0),
        "title": str(node.get("title") or source_type),
    }
    for key in ("w", "h"):
        if isinstance(node.get(key), (int, float)):
            common[key] = node[key]
    out.update(common)
    items = [
        item
        for item in (
            _infinite_item(raw, urls)
            for raw in node.get("items") or []
            if isinstance(raw, dict)
        )
        if item is not None
    ]
    manual_references = [
        item
        for item in (
            _infinite_item(raw, urls)
            for raw in node.get("manual_references") or []
            if isinstance(raw, dict)
        )
        if item is not None
    ]
    if manual_references:
        out["manualInputRefs"] = manual_references

    target_type = str(node.get("type") or "")
    # Infinite-Canvas 的输入媒体是一节点一资源；Lingua 的多资源输入在反向导出时
    # 变为一个 group + 多个 image 子节点，原有连线仍接在 group 上。
    if target_type in {"image", "video", "audio", "file"} and source_type == "image":
        if len(items) > 1:
            child_ids = [f"{common['id']}-asset-{index}" for index in range(1, len(items) + 1)]
            group = {**out, "type": "group", "items": child_ids}
            children = [
                {
                    "id": child_id,
                    "type": "image",
                    "x": common["x"] + 28 + (index - 1) * 24,
                    "y": common["y"] + 64 + (index - 1) * 24,
                    "title": item["name"],
                    "url": item["url"],
                    "name": item["name"],
                    "mediaKind": item["kind"],
                }
                for index, (child_id, item) in enumerate(zip(child_ids, items, strict=True), 1)
            ]
            return [_redact_legacy(group), *[_redact_legacy(child) for child in children]]
        if items:
            out.update(
                {
                    "url": items[0]["url"],
                    "name": items[0]["name"],
                    "mediaKind": items[0]["kind"],
                }
            )
        if node.get("prompt_draft"):
            out["promptDraftText"] = str(node["prompt_draft"])
        if isinstance(node.get("run_settings"), dict):
            out["runSettings"] = _infinite_values(node["run_settings"], urls)
    elif source_type == "prompt":
        out["text"] = str(node.get("text") or node.get("prompt_draft") or "")
    elif source_type == "loop":
        out.update(
            {
                "count": int(node.get("count") or 1),
                "mode": str(node.get("mode") or "serial"),
                "loopStart": int(node.get("loop_start") or 1),
                "parallelLimit": int(node.get("parallel_limit") or 6),
                "imageInput": bool(node.get("image_input")),
                "imageBatchSize": int(node.get("image_batch_size") or 1),
                "variablePrompt": "\n".join(node.get("variable_prompts") or []),
            }
        )
    elif source_type == "group":
        out["items"] = [str(value) for value in node.get("member_ids") or []]
    elif source_type == "output":
        out["images"] = items
    elif source_type == "llm":
        out.update(
            {
                "mode": str(node.get("llm_mode") or "node"),
                "showSystem": bool(node.get("llm_system_enabled")),
                "systemPrompt": str(node.get("llm_system_prompt") or ""),
                "inputText": str(node.get("llm_input") or ""),
                "outputText": str(node.get("llm_output") or ""),
                "messages": copy.deepcopy(node.get("llm_messages") or []),
                "temperature": node.get("llm_temperature", 0.7),
                "llmInputHeight": int(node.get("llm_input_height") or 110),
                "llmOutputHeight": int(node.get("llm_output_height") or 150),
            }
        )
    elif source_type == "msgen":
        out.update(
            {
                "prompt": str(node.get("prompt_draft") or ""),
                "msgenModel": "custom",
                "msCustomModel": str(node.get("ms_model_hint") or ""),
                "msResolution": "custom",
                "msCustomSize": str(node.get("ms_size") or "1024x1024"),
                "count": int(node.get("ms_count") or 1),
                "msNegativePrompt": str(node.get("ms_negative_prompt") or ""),
                "msSeed": node.get("ms_seed"),
                "msSteps": node.get("ms_steps"),
                "msGuidance": node.get("ms_guidance"),
                "msLoraEnabled": bool(node.get("ms_lora_enabled")),
                "msLoraId": str(node.get("ms_lora_id") or ""),
                "msLoraStrength": node.get("ms_lora_strength", 0.8),
                "generatedOutputs": items,
            }
        )
    elif source_type == "midjourney":
        out.update(
            {
                "prompt": str(node.get("prompt_draft") or ""),
                "apiProvider": str(node.get("mj_provider_hint") or ""),
                "mode": str(node.get("mj_mode") or "imagine"),
                "size": str(node.get("mj_size") or "1:1"),
                "version": str(node.get("mj_version") or "6.1"),
                "speed": str(node.get("mj_speed") or "relax"),
                "lastTaskId": str(node.get("mj_last_task_id") or ""),
                "lastAction": str(node.get("mj_last_action") or ""),
                "lastTaskStatus": str(node.get("mj_last_task_status") or ""),
                "lastImageCount": int(node.get("mj_last_image_count") or 0),
                "lastPrompt": str(node.get("mj_last_prompt") or ""),
                "mjModalTaskId": str(node.get("mj_modal_task_id") or ""),
                "mjModalPrompt": str(node.get("mj_modal_prompt") or ""),
                "generatedOutputs": items,
            }
        )
    elif source_type == "video":
        settings = (
            node.get("video_settings")
            if isinstance(node.get("video_settings"), dict)
            else {}
        )
        out.update(
            {
                "prompt": str(node.get("prompt_draft") or ""),
                "settings": _infinite_values(settings, urls),
                "generatedOutputs": items,
            }
        )
    elif source_type in {"generator", "comfy", "rh", "minimax", "ltxDirector"}:
        out["workflowValues"] = _infinite_values(node.get("workflow_values") or {}, urls)
        out["generatedOutputs"] = items
        if source_type == "rh":
            source_kind = str(node.get("runninghub_source_kind") or "workflow")
            source_id = str(node.get("runninghub_source_id") or "")
            values = _infinite_values(node.get("workflow_values") or {}, urls)
            out.update(
                {
                    "rhPayment": "wallet" if node.get("workflow_use_wallet") else "key",
                    "instanceType": "plus" if node.get("workflow_instance_type") == "plus" else "",
                    "rhRandomActive": copy.deepcopy(node.get("workflow_random_fields") or {}),
                    "rhConfigKey": f"{source_kind}:{source_id}" if source_id else "",
                    "rhMode": source_kind,
                    "rhParams": {
                        key: {"value": value} for key, value in values.items()
                    },
                }
            )
            source_id_key = {
                "app": "webappId",
                "workflow": "workflowId",
                "model": "rhModel",
            }.get(source_kind, "workflowId")
            out[source_id_key] = source_id
        timeline = node.get("workflow_timeline")
        if isinstance(timeline, dict):
            timeline_type, timeline_fields = _infinite_timeline(timeline, urls)
            out["type"] = timeline_type
            out.update(timeline_fields)
    return [_redact_legacy(out)]


def _infinite_document(
    nodes: list[dict[str, Any]],
    connections: list[dict[str, Any]],
    resources: list[dict[str, Any]],
    *,
    include_resources: bool,
) -> dict[str, Any]:
    urls = _infinite_resource_urls(resources)
    legacy_nodes = [
        converted
        for node in nodes
        for converted in _infinite_node(node, urls)
    ]
    legacy_resources = []
    if include_resources:
        for item in resources:
            ref = str(item.get("ref") or "")
            url = urls.get(ref)
            if not url:
                continue
            legacy_resources.append(
                {
                    "url": url,
                    "archive": item.get("archive"),
                    "name": item.get("name"),
                    "size": item.get("bytes"),
                    "sha256": item.get("sha256"),
                    "mime": item.get("mime"),
                    "kind": item.get("kind"),
                }
            )
    return {
        "format": INFINITE_EXPORT_FORMAT,
        "version": 1,
        "nodes": legacy_nodes,
        "connections": copy.deepcopy(connections),
        "resources": legacy_resources,
    }


async def build_export(
    session: AsyncSession,
    *,
    nodes: list,
    connections: list,
    include_resources: bool,
    allow_empty: bool = False,
    target_format: str = FORMAT,
) -> tuple[dict[str, Any], bytes | None]:
    try:
        clean_nodes, clean_connections, _ = studio.normalize_canvas_payload(
            nodes, connections, None
        )
    except studio.StudioError as exc:
        raise CanvasWorkflowError(str(exc)) from exc
    if not clean_nodes and not allow_empty:
        raise CanvasWorkflowError("没有可导出的节点")

    image_ids, media_ids = _collect_ids(clean_nodes)
    images, media = await _load_assets(session, image_ids, media_ids)
    resources = [
        *map(_resource_for_image, images.values()),
        *map(_resource_for_media, media.values()),
    ]
    resources.sort(key=lambda item: item["ref"])
    portable_nodes = _redact_legacy(_portable_nodes(clean_nodes, images, media))
    document: dict[str, Any] = {
        "format": FORMAT,
        "version": VERSION,
        "nodes": portable_nodes,
        "connections": clean_connections,
        "resources": resources,
    }
    if target_format == INFINITE_EXPORT_FORMAT:
        document = _infinite_document(
            portable_nodes,
            clean_connections,
            resources,
            include_resources=include_resources,
        )
    elif target_format != FORMAT:
        raise CanvasWorkflowError(f"不支持的导出格式：{target_format}")
    if not include_resources:
        return document, None

    rows_by_ref: dict[str, ImageAsset | StudioMediaAsset] = {
        **{f"image:{row.sha256}": row for row in images.values()},
        **{f"media:{row.sha256}": row for row in media.values()},
    }
    archive = BytesIO()
    storage = get_storage()
    with zipfile.ZipFile(archive, "w", zipfile.ZIP_DEFLATED) as bundle:
        for resource in resources:
            row = rows_by_ref[resource["ref"]]
            data = await storage.read(row.storage_key)
            suffix = _extension(resource["mime"], resource["name"])
            archive_path = f"resources/{resource['kind']}-{resource['sha256'][:20]}{suffix}"
            resource["archive"] = archive_path
            bundle.writestr(archive_path, data)
        if target_format == INFINITE_EXPORT_FORMAT:
            document = _infinite_document(
                portable_nodes,
                clean_connections,
                resources,
                include_resources=True,
            )
        bundle.writestr(
            "workflow.json",
            json.dumps(document, ensure_ascii=False, indent=2).encode("utf-8"),
        )
    return document, archive.getvalue()


async def build_canvas_export(
    session: AsyncSession,
    *,
    canvas: Any,
    include_resources: bool,
) -> tuple[dict[str, Any], bytes | None]:
    """导出完整画布快照；ZIP 同时保留 portable workflow，兼容两类导入入口。"""

    workflow, archive = await build_export(
        session,
        nodes=canvas.nodes or [],
        connections=canvas.connections or [],
        include_resources=include_resources,
        allow_empty=True,
    )
    canvas_document = _redact_legacy(
        {
            "format": CANVAS_FORMAT,
            "format_version": CANVAS_VERSION,
            "id": canvas.id,
            "title": canvas.title,
            "icon": canvas.icon,
            "kind": canvas.kind,
            "owner": canvas.owner,
            "color": canvas.color,
            "pinned": canvas.pinned,
            "project": canvas.project,
            "board_x": canvas.board_x,
            "board_y": canvas.board_y,
            "nodes": workflow["nodes"],
            "connections": workflow["connections"],
            "viewport": canvas.viewport,
            "settings": canvas.settings or {},
            "version": canvas.version,
            "created_at": canvas.created_at.isoformat() if canvas.created_at else "",
            "updated_at": canvas.updated_at.isoformat() if canvas.updated_at else "",
            "resources": workflow["resources"],
        }
    )
    if archive is None:
        return canvas_document, None

    bundle_bytes = BytesIO(archive)
    with zipfile.ZipFile(bundle_bytes, "a", zipfile.ZIP_DEFLATED) as bundle:
        bundle.writestr(
            "canvas.json",
            json.dumps(canvas_document, ensure_ascii=False, indent=2).encode("utf-8"),
        )
        bundle.writestr(
            "resources-manifest.json",
            json.dumps(
                {
                    "canvas_id": canvas.id,
                    "resources": [
                        {
                            "ref": item.get("ref"),
                            "file": item.get("archive"),
                            "sha256": item.get("sha256"),
                            "bytes": item.get("bytes"),
                        }
                        for item in workflow["resources"]
                    ],
                },
                ensure_ascii=False,
                indent=2,
            ).encode("utf-8"),
        )
    return canvas_document, bundle_bytes.getvalue()


def _parse_document(raw: bytes, filename: str) -> tuple[dict[str, Any], dict[str, bytes]]:
    if not raw:
        raise CanvasWorkflowError("文件为空")
    if len(raw) > MAX_IMPORT_BYTES:
        raise CanvasWorkflowError("工作流包不能超过 512 MB")
    resources: dict[str, bytes] = {}
    try:
        if filename.lower().endswith(".zip") or raw.startswith(b"PK"):
            with zipfile.ZipFile(BytesIO(raw)) as bundle:
                names = bundle.namelist()
                if len(names) > MAX_ARCHIVE_FILES:
                    raise CanvasWorkflowError("工作流包内文件过多")
                workflow_name = next(
                    (name for name in names if PurePosixPath(name).name == "workflow.json"),
                    None,
                )
                if workflow_name is None:
                    raise CanvasWorkflowError("压缩包中没有 workflow.json")
                document = json.loads(bundle.read(workflow_name).decode("utf-8-sig"))
                for item in document.get("resources") or []:
                    if not isinstance(item, dict):
                        continue
                    archive_path = str(item.get("archive") or "")
                    if archive_path in names and not bundle.getinfo(archive_path).is_dir():
                        resources[archive_path] = bundle.read(archive_path)
        else:
            document = json.loads(raw.decode("utf-8-sig"))
    except CanvasWorkflowError:
        raise
    except (json.JSONDecodeError, UnicodeDecodeError, zipfile.BadZipFile, KeyError) as exc:
        raise CanvasWorkflowError(f"无法解析工作流文件：{exc}") from exc
    if isinstance(document, list):
        document = {"nodes": document, "connections": [], "resources": []}
    if isinstance(document, dict) and isinstance(document.get("workflow"), dict):
        document = document["workflow"]
    if not isinstance(document, dict) or not isinstance(document.get("nodes"), list):
        raise CanvasWorkflowError("工作流 JSON 缺少 nodes")
    if not isinstance(document.get("connections"), list):
        document["connections"] = []
    if not isinstance(document.get("resources"), list):
        document["resources"] = []
    return document, resources


def _legacy_kind(value: Any, url: str = "") -> str:
    raw = str(value or "").strip().lower()
    if raw in {"image", "video", "audio", "file"}:
        return raw
    mime = mimetypes.guess_type(url)[0] or ""
    if mime.startswith("image/"):
        return "image"
    if mime.startswith("video/"):
        return "video"
    if mime.startswith("audio/"):
        return "audio"
    return "file"


def _legacy_url(value: Any) -> str:
    if isinstance(value, str):
        return value.strip()
    if not isinstance(value, dict):
        return ""
    for key in (
        "url",
        "path",
        "src",
        "output",
        "output_url",
        "outputUrl",
        "video_url",
        "videoUrl",
        "audio_url",
        "audioUrl",
    ):
        candidate = value.get(key)
        if isinstance(candidate, str) and candidate.strip():
            return candidate.strip()
    return ""


def _legacy_item(
    value: Any,
    *,
    resource_refs: dict[str, str],
    fallback_kind: str = "image",
) -> dict[str, Any] | None:
    url = _legacy_url(value)
    if not url:
        return None
    raw = value if isinstance(value, dict) else {}
    kind = _legacy_kind(
        raw.get("kind") or raw.get("mediaKind") or raw.get("media_kind") or fallback_kind,
        url,
    )
    name = _safe_filename(
        str(raw.get("name") or raw.get("filename") or PurePosixPath(url).name),
        f"legacy-{kind}",
    )
    item: dict[str, Any] = {"kind": kind, "name": name}
    ref = resource_refs.get(url)
    if ref:
        item["resource_ref"] = ref
    elif url.startswith(("http://", "https://")):
        item["url"] = url
    else:
        digest = hashlib.sha256(url.encode()).hexdigest()
        item["resource_ref"] = f"legacy-url:{digest}"
    for source, target in (
        ("natural_w", "w"),
        ("natural_h", "h"),
        ("width", "w"),
        ("height", "h"),
        ("duration_ms", "duration_ms"),
    ):
        if isinstance(raw.get(source), (int, float)):
            item[target] = raw[source]
    return item


def _legacy_media_values(node: dict[str, Any]) -> list[Any]:
    values: list[Any] = []
    if _legacy_url(node):
        values.append(node)
    for key in ("images", "generatedOutputs", "materials", "results"):
        raw = node.get(key)
        if isinstance(raw, list):
            values.extend(raw)
    segments = node.get("segments")
    if isinstance(segments, list):
        for segment in segments:
            if not isinstance(segment, dict):
                continue
            for key in ("result", "results", "refItems"):
                raw = segment.get(key)
                if isinstance(raw, list):
                    values.extend(raw)
                elif raw is not None:
                    values.append(raw)
    return values


def _redact_legacy(value: Any) -> Any:
    if isinstance(value, list):
        return [_redact_legacy(item) for item in value]
    if not isinstance(value, dict):
        return value
    result: dict[str, Any] = {}
    for key, item in value.items():
        normalized = str(key).lower().replace("-", "_")
        if normalized in {
            "api_key",
            "apikey",
            "token",
            "secret",
            "server_secret",
            "authorization",
            "password",
        }:
            result[key] = "[REDACTED]"
        elif normalized not in studio.RUNTIME_KEYS:
            result[key] = _redact_legacy(item)
    return result


_LEGACY_MODELSCOPE_MODELS = {
    "zimage": "Tongyi-MAI/Z-Image-Turbo",
    "qwen_edit": "Qwen/Qwen-Image-Edit-2511",
    "klein_edit": "black-forest-labs/FLUX.2-klein-9B",
}

_LEGACY_MODELSCOPE_SIZES = {
    "square": {"1k": "1024x1024", "2k": "2048x2048", "4k": "3840x3840"},
    "portrait": {"1k": "1024x1536", "2k": "1360x2048", "4k": "2352x3520"},
    "portrait43": {"1k": "1008x1344", "2k": "1536x2048", "4k": "2448x3264"},
    "landscape43": {"1k": "1344x1008", "2k": "2048x1536", "4k": "3264x2448"},
    "landscape": {"1k": "1536x1024", "2k": "2048x1360", "4k": "3520x2352"},
    "story": {"1k": "720x1280", "2k": "1152x2048", "4k": "2160x3840"},
    "wide": {"1k": "1280x720", "2k": "2048x1152", "4k": "3840x2160"},
    "ultrawide": {"1k": "1280x544", "2k": "2048x880", "4k": "3840x1648"},
    "ultratall": {"1k": "544x1280", "2k": "880x2048", "4k": "1648x3840"},
}


def _legacy_modelscope_size(raw: dict[str, Any]) -> str:
    resolution = str(raw.get("msResolution") or "1k").lower()
    if resolution == "custom":
        custom = str(raw.get("msCustomSize") or "").strip()
        if custom:
            return custom
        width = int(raw.get("msCustomWidth") or raw.get("msWidth") or 1024)
        height = int(raw.get("msCustomHeight") or raw.get("msHeight") or 1024)
        return f"{width}x{height}"
    ratio = str(raw.get("msRatio") or "square").lower()
    return _LEGACY_MODELSCOPE_SIZES.get(ratio, _LEGACY_MODELSCOPE_SIZES["square"]).get(
        resolution,
        "1024x1024",
    )


def _legacy_modelscope_model(raw: dict[str, Any]) -> str:
    key = str(raw.get("msgenModel") or "zimage").lower()
    if key == "custom":
        return str(raw.get("msCustomModel") or "Tongyi-MAI/Z-Image-Turbo").strip()
    return _LEGACY_MODELSCOPE_MODELS.get(key, "Tongyi-MAI/Z-Image-Turbo")


def _legacy_number(value: Any, fallback: float, minimum: float = 0) -> float:
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        parsed = fallback
    return max(minimum, parsed)


def _legacy_minimax_references(
    segment: dict[str, Any],
    *,
    resource_refs: dict[str, str],
) -> list[dict[str, Any]]:
    raw_refs: list[tuple[Any, str]] = []
    refs = segment.get("refs")
    if isinstance(refs, list):
        raw_refs.extend((item, "image") for item in refs)
    elif isinstance(refs, dict):
        for kind in ("image", "video", "audio"):
            values = refs.get(kind)
            if isinstance(values, list):
                raw_refs.extend((item, kind) for item in values)
    if isinstance(segment.get("refItems"), list):
        raw_refs.extend((item, "image") for item in segment["refItems"])

    limits = {"image": 9, "video": 3, "audio": 3}
    counts = {kind: 0 for kind in limits}
    seen: set[tuple[str, str]] = set()
    references: list[dict[str, Any]] = []
    for raw, fallback_kind in raw_refs:
        item = _legacy_item(
            raw,
            resource_refs=resource_refs,
            fallback_kind=fallback_kind,
        )
        if item is None:
            continue
        kind = str(item.get("kind") or fallback_kind)
        if kind not in limits or counts[kind] >= limits[kind]:
            continue
        marker = (kind, str(item.get("resource_ref") or item.get("url") or ""))
        if not marker[1] or marker in seen:
            continue
        seen.add(marker)
        counts[kind] += 1
        references.append(item)
    return references


def _legacy_minimax_timeline(
    raw: dict[str, Any],
    *,
    resource_refs: dict[str, str],
) -> dict[str, Any] | None:
    raw_segments = raw.get("segments")
    if not isinstance(raw_segments, list) or not raw_segments:
        return None
    segments: list[dict[str, Any]] = []
    for index, source in enumerate(raw_segments):
        if not isinstance(source, dict):
            continue
        length = _legacy_number(
            source.get("duration"),
            _legacy_number(raw.get("duration"), 8, 0.5),
            0.5,
        )
        segment: dict[str, Any] = {
            "id": str(source.get("id") or f"segment-{index + 1}"),
            "start": _legacy_number(source.get("start"), 0),
            "length": length,
            "prompt": str(source.get("prompt") or ""),
            "type": "text",
            "aspect_ratio": str(
                source.get("aspectRatio") or raw.get("aspectRatio") or "16:9 (Widescreen)"
            ),
            "megapixels": _legacy_number(
                source.get("megapixels"),
                _legacy_number(raw.get("megapixels"), 0.4, 0.1),
                0.1,
            ),
            "seed": int(_legacy_number(source.get("seed"), 0)),
            "trim_in": min(
                length - 0.1,
                _legacy_number(source.get("trimIn"), 0),
            ),
            "trim_out": min(
                length,
                _legacy_number(source.get("trimOut"), length, 0.1),
            ),
        }
        segment["trim_out"] = max(segment["trim_in"] + 0.1, segment["trim_out"])
        references = _legacy_minimax_references(source, resource_refs=resource_refs)
        if references:
            segment["references"] = references
        result_source = source.get("result")
        if result_source is None and isinstance(source.get("results"), list):
            result_source = next((item for item in source["results"] if _legacy_url(item)), None)
        result = _legacy_item(
            result_source,
            resource_refs=resource_refs,
            fallback_kind="video",
        )
        if result is not None:
            segment["result"] = result
        segments.append(segment)
    if not segments:
        return None
    selected = str(raw.get("selectedSegmentId") or "")
    if not any(segment["id"] == selected for segment in segments):
        selected = segments[0]["id"]
    return {"kind": "minimax", "segments": segments, "selected_id": selected}


def _legacy_ltx_media_item(
    source: dict[str, Any],
    *,
    resource_refs: dict[str, str],
    kind: str,
) -> dict[str, Any] | None:
    if kind == "image":
        legacy_ref = source.get("imageRef")
        candidates = [
            source.get("imageB64"),
            source.get("imageFile"),
            legacy_ref.get("url") if isinstance(legacy_ref, dict) else None,
            legacy_ref.get("comfy_name") if isinstance(legacy_ref, dict) else None,
        ]
        name = source.get("imageFile")
    else:
        candidates = [source.get("audioUrl"), source.get("audioFile"), source.get("audioB64")]
        name = source.get("fileName") or source.get("audioFile")
    url = next((str(value).strip() for value in candidates if str(value or "").strip()), "")
    if not url:
        return None
    return _legacy_item(
        {"url": url, "name": name or PurePosixPath(url).name, "kind": kind},
        resource_refs=resource_refs,
        fallback_kind=kind,
    )


def _legacy_ltx_timeline(
    raw: dict[str, Any],
    *,
    resource_refs: dict[str, str],
) -> dict[str, Any]:
    timeline_source: dict[str, Any] = {}
    timeline_raw = raw.get("ltxTimelineData")
    if isinstance(timeline_raw, str) and timeline_raw.strip():
        with suppress(json.JSONDecodeError, TypeError):
            parsed = json.loads(timeline_raw)
            if isinstance(parsed, dict):
                timeline_source = parsed
    elif isinstance(timeline_raw, dict):
        timeline_source = timeline_raw

    raw_segments = timeline_source.get("segments")
    if not isinstance(raw_segments, list) or not raw_segments:
        raw_segments = raw.get("ltxSegments")
    segments: list[dict[str, Any]] = []
    cursor = 0.0
    for index, source in enumerate(raw_segments if isinstance(raw_segments, list) else []):
        if not isinstance(source, dict):
            continue
        length = _legacy_number(source.get("length"), 1, 1)
        start = _legacy_number(source.get("start"), cursor)
        is_image = str(source.get("type") or "text").lower() == "image"
        segment: dict[str, Any] = {
            "id": str(source.get("id") or f"segment-{index + 1}"),
            "start": start,
            "length": length,
            "prompt": str(source.get("prompt") or ""),
            "type": "image" if is_image else "text",
        }
        if is_image:
            segment["guideStrength"] = _legacy_number(
                source.get("guideStrength", source.get("strength")),
                1,
            )
            item = _legacy_ltx_media_item(
                source,
                resource_refs=resource_refs,
                kind="image",
            )
            if item is not None:
                if item.get("resource_ref"):
                    segment["resource_ref"] = item["resource_ref"]
                elif item.get("url"):
                    segment["imageB64"] = item["url"]
                segment["name"] = item.get("name")
        segments.append(segment)
        cursor = max(cursor, start + length)

    audio_segments: list[dict[str, Any]] = []
    raw_audio = timeline_source.get("audioSegments")
    for index, source in enumerate(raw_audio if isinstance(raw_audio, list) else []):
        if not isinstance(source, dict):
            continue
        item = _legacy_ltx_media_item(
            source,
            resource_refs=resource_refs,
            kind="audio",
        )
        audio: dict[str, Any] = {
            "id": str(source.get("id") or f"audio-{index + 1}"),
            "start": _legacy_number(source.get("start"), 0),
            "length": _legacy_number(source.get("length"), 1, 1),
            "trim_start": _legacy_number(source.get("trimStart"), 0),
            "audio_duration_frames": _legacy_number(
                source.get("audioDurationFrames"),
                _legacy_number(source.get("length"), 1, 1),
                1,
            ),
            "name": str(source.get("fileName") or ""),
        }
        if item is not None:
            if item.get("resource_ref"):
                audio["resource_ref"] = item["resource_ref"]
            elif item.get("url"):
                audio["url"] = item["url"]
            audio["name"] = str(item.get("name") or audio["name"])
        audio_segments.append(audio)

    selected = str(raw.get("ltxSelectedSegId") or "")
    if not any(segment["id"] == selected for segment in segments):
        selected = segments[0]["id"] if segments else ""
    frame_rate = _legacy_number(raw.get("frameRate"), 24, 1)
    duration_frames = int(_legacy_number(raw.get("durationFrames"), 120, 1))
    return {
        "kind": "ltx",
        "segments": segments,
        "selected_id": selected,
        "frame_rate": frame_rate,
        "duration_frames": duration_frames,
        "audio_segments": audio_segments,
    }


def _legacy_ltx_values(raw: dict[str, Any]) -> dict[str, Any]:
    frame_rate = _legacy_number(raw.get("frameRate"), 24, 1)
    duration_frames = int(_legacy_number(raw.get("durationFrames"), 120, 1))
    duration_seconds = _legacy_number(
        raw.get("durationSeconds"),
        duration_frames / frame_rate,
        0.1,
    )
    return {
        "f_global_prompt": str(raw.get("globalPrompt") or ""),
        "f_duration_frames": duration_frames,
        "f_duration_seconds": round(duration_seconds, 3),
        "f_frame_rate": frame_rate,
        "f_custom_width": int(_legacy_number(raw.get("customWidth"), 0)),
        "f_custom_height": int(_legacy_number(raw.get("customHeight"), 0)),
        "f_use_custom_audio": bool(raw.get("useCustomAudio")),
        "f_noise_seed": int(_legacy_number(raw.get("noiseSeed"), 12)),
        "f_4t0z0g8": str(raw.get("resizeMethod") or "maintain aspect ratio"),
        "f_display_mode": str(raw.get("displayMode") or "seconds"),
        "f_epsilon": _legacy_number(raw.get("epsilon"), 0.001),
        "f_divisible_by": int(_legacy_number(raw.get("divisibleBy"), 32, 1)),
        "f_img_compression": _legacy_number(raw.get("imgCompression"), 18),
        "f_timeline_ui": str(raw.get("timelineUi") or ""),
    }


def _legacy_runninghub_ref(raw: dict[str, Any]) -> tuple[str, str]:
    config_key = str(raw.get("rhConfigKey") or "").strip()
    match = re.fullmatch(r"(app|workflow|model):(.+)", config_key, re.I)
    if match:
        return match.group(1).lower(), match.group(2).strip()
    kind = str(raw.get("rhMode") or "app").strip().lower()
    if kind not in {"app", "workflow", "model"}:
        kind = "app"
    if kind == "workflow":
        source_id = raw.get("workflowId")
    elif kind == "model":
        source_id = raw.get("rhModel") or raw.get("model")
    else:
        source_id = raw.get("webappId") or raw.get("appId")
    return kind, str(source_id or "").strip()


def _legacy_runninghub_values(raw: dict[str, Any]) -> dict[str, Any]:
    params = raw.get("rhParams")
    if not isinstance(params, dict):
        return {}
    values: dict[str, Any] = {}
    for key, param in params.items():
        if isinstance(param, dict):
            if "value" in param:
                values[str(key)] = _redact_legacy(param["value"])
        elif param is not None:
            values[str(key)] = _redact_legacy(param)
    return values


def _legacy_node(
    raw: dict[str, Any],
    *,
    resource_refs: dict[str, str],
) -> dict[str, Any]:
    source_type = str(raw.get("type") or "smart-image")
    source_type_lower = source_type.lower()
    runninghub_kind, runninghub_source_id = _legacy_runninghub_ref(raw)
    type_map = {
        "smart-image": "image",
        "smart-prompt": "prompt",
        "smart-loop": "loop",
        "smart-group": "group",
        "smart-minimax": "workflow",
        "promptgroup": "group",
        "llm": "llm",
        "api": "image",
        "msgen": "modelscope",
        "modelscope": "modelscope",
        "midjourney": "midjourney",
        "output": "output",
        "minimax": "workflow",
        "rh": "workflow",
        "runninghub": "workflow",
        "comfy": "workflow",
        "ltx": "workflow",
        "ltxdirector": "workflow",
        "ltx-director": "workflow",
    }
    target_type = type_map.get(source_type_lower, source_type_lower)
    if source_type_lower in {"rh", "runninghub"} and runninghub_kind == "model":
        target_type = "image"
    supported = {
        "image",
        "video",
        "audio",
        "file",
        "workflow",
        "prompt",
        "llm",
        "modelscope",
        "midjourney",
        "output",
        "loop",
        "group",
    }
    if target_type not in supported:
        target_type = "prompt"
    node: dict[str, Any] = {
        "id": str(raw.get("id") or uuid4().hex),
        "type": target_type,
        "x": float(raw.get("x") or 0),
        "y": float(raw.get("y") or 0),
        "title": str(raw.get("title") or source_type),
        "source_type": source_type,
        "source_payload": _redact_legacy(raw),
    }
    for key in ("w", "h"):
        if isinstance(raw.get(key), (int, float)):
            node[key] = raw[key]

    media_values = _legacy_media_values(raw)
    video_sources = {
        "video",
        "minimax",
        "smart-minimax",
        "ltx",
        "ltxdirector",
        "ltx-director",
    }
    fallback_kind = "video" if source_type.lower() in video_sources else "image"
    items: list[dict[str, Any]] = []
    seen: set[tuple[str, str]] = set()
    for value in media_values:
        item = _legacy_item(
            value,
            resource_refs=resource_refs,
            fallback_kind=fallback_kind,
        )
        if item is None:
            continue
        key = (str(item.get("resource_ref") or item.get("url") or ""), str(item.get("kind")))
        if key in seen:
            continue
        seen.add(key)
        items.append(item)
    if items:
        node["items"] = items

    manual_references: list[dict[str, Any]] = []
    for value in raw.get("manualInputRefs") or []:
        item = _legacy_item(value, resource_refs=resource_refs, fallback_kind="image")
        if item is not None and item.get("kind") == "image":
            manual_references.append(item)
    if manual_references:
        node["manual_references"] = manual_references

    if target_type == "llm":
        messages = raw.get("messages")
        node.update(
            {
                "llm_mode": "chat" if raw.get("mode") == "chat" else "node",
                "llm_system_enabled": bool(raw.get("showSystem")),
                "llm_system_prompt": str(raw.get("systemPrompt") or ""),
                "llm_input": str(raw.get("inputText") or raw.get("userInput") or ""),
                "llm_output": str(raw.get("outputText") or ""),
                "llm_messages": _redact_legacy(messages) if isinstance(messages, list) else [],
                "llm_temperature": float(raw.get("temperature") or 0.7),
                "llm_input_height": max(70, min(800, int(raw.get("llmInputHeight") or 110))),
                "llm_output_height": max(70, min(800, int(raw.get("llmOutputHeight") or 150))),
            }
        )
    elif target_type == "prompt":
        node["text"] = str(
            raw.get("text")
            or raw.get("outputText")
            or raw.get("prompt")
            or raw.get("promptDraftText")
            or ""
        )
    elif target_type == "image":
        prompt = raw.get("prompt") or raw.get("promptDraftText") or raw.get("text")
        if isinstance(prompt, str) and prompt:
            node["prompt_draft"] = prompt
        settings = raw.get("runSettings") or raw.get("settings")
        if isinstance(settings, dict):
            node["run_settings"] = _redact_legacy(settings)
        if source_type_lower in {"rh", "runninghub"} and runninghub_kind == "model":
            node["runninghub_model_hint"] = runninghub_source_id
            node["runninghub_source_kind"] = "model"
            node["runninghub_values"] = _legacy_runninghub_values(raw)
    elif target_type == "video":
        prompt = raw.get("prompt") or raw.get("promptDraftText") or raw.get("text")
        if isinstance(prompt, str) and prompt:
            node["prompt_draft"] = prompt
        legacy_settings = raw.get("settings")
        settings = dict(legacy_settings) if isinstance(legacy_settings, dict) else {}
        field_map = {
            "model": "model_hint",
            "apiProvider": "provider_hint",
            "duration": "duration",
            "aspectRatio": "aspect_ratio",
            "resolution": "resolution",
            "generateAudio": "generate_audio",
            "cameraFixed": "fixed_camera",
            "watermark": "watermark",
            "seed": "seed",
            "enhancePrompt": "enhance_prompt",
            "enableUpsample": "enable_upsample",
        }
        for source_key, target_key in field_map.items():
            if source_key in raw:
                settings[target_key] = raw[source_key]
        if raw.get("multimodal") is True:
            settings["reference_mode"] = "multimodal"
        elif raw.get("useFrameRoles") is True:
            settings["reference_mode"] = "first_last"
        else:
            settings.setdefault("reference_mode", "first_frame")
        node["video_settings"] = _redact_legacy(settings)
    elif target_type == "modelscope":
        prompt = raw.get("prompt") or raw.get("promptDraftText") or raw.get("text")
        if isinstance(prompt, str) and prompt:
            node["prompt_draft"] = prompt
        node.update(
            {
                "ms_model_hint": _legacy_modelscope_model(raw),
                "ms_size": _legacy_modelscope_size(raw),
                "ms_count": max(1, min(8, int(raw.get("count") or 1))),
                "ms_lora_enabled": bool(raw.get("msLoraEnabled")),
                "ms_lora_id": str(raw.get("msLoraId") or ""),
                "ms_lora_strength": float(raw.get("msLoraStrength") or 0.8),
            }
        )
    elif target_type == "midjourney":
        prompt = raw.get("prompt") or raw.get("promptDraftText") or raw.get("text")
        if isinstance(prompt, str) and prompt:
            node["prompt_draft"] = prompt
        mode = str(raw.get("mode") or "imagine").strip().lower()
        if mode not in {"imagine", "blend", "edit"}:
            mode = "imagine"
        speed = str(raw.get("speed") or "relax").strip().lower()
        if speed not in {"relax", "fast", "turbo"}:
            speed = "relax"
        version = str(raw.get("version") or "6.1").strip()
        if version not in {"8.2", "8.1", "7", "6.1", "5.2", "5.1"}:
            version = "6.1"
        node.update(
            {
                "mj_provider_hint": str(raw.get("apiProvider") or ""),
                "mj_mode": mode,
                "mj_size": str(raw.get("size") or "1:1"),
                "mj_version": version,
                "mj_speed": speed,
                "mj_last_task_id": str(raw.get("lastTaskId") or ""),
                "mj_last_action": str(raw.get("lastAction") or ""),
                "mj_last_task_status": str(raw.get("lastTaskStatus") or ""),
                "mj_last_image_count": max(0, int(raw.get("lastImageCount") or 0)),
                "mj_last_prompt": str(raw.get("lastPrompt") or ""),
                "mj_modal_task_id": str(raw.get("mjModalTaskId") or ""),
                "mj_modal_prompt": str(raw.get("mjModalPrompt") or ""),
            }
        )
    elif target_type == "loop":
        node.update(
            {
                "count": max(1, int(raw.get("count") or 1)),
                "mode": "parallel" if raw.get("mode") == "parallel" else "serial",
                "loop_start": int(raw.get("loopStart") or raw.get("loop_start") or 1),
                "parallel_limit": int(raw.get("parallelLimit") or raw.get("parallel_limit") or 6),
                "image_input": bool(raw.get("imageInput") or raw.get("image_input")),
                "image_batch_size": int(
                    raw.get("imageBatchSize") or raw.get("image_batch_size") or 1
                ),
                "variable_prompts": (
                    list(raw.get("variablePrompts"))
                    if isinstance(raw.get("variablePrompts"), list)
                    else [
                        line
                        for line in str(raw.get("variablePrompt") or "").splitlines()
                        if line.strip()
                    ]
                ),
            }
        )
    elif target_type == "group":
        members = raw.get("items") or raw.get("member_ids") or []
        if isinstance(members, list):
            node["member_ids"] = [str(item) for item in members]
    elif target_type == "workflow":
        node["workflow_kind"] = str(raw.get("workflow") or source_type)
        values = raw.get("workflowValues") or raw.get("values") or raw.get("params")
        if isinstance(values, dict):
            node["workflow_values"] = _redact_legacy(values)
        if source_type.lower() in {"minimax", "smart-minimax"}:
            timeline = _legacy_minimax_timeline(raw, resource_refs=resource_refs)
            if timeline is not None:
                node["workflow_timeline"] = timeline
        elif source_type_lower in {"ltx", "ltxdirector", "ltx-director"}:
            node["workflow_values"] = {
                **(node.get("workflow_values") or {}),
                **_legacy_ltx_values(raw),
            }
            node["workflow_timeline"] = _legacy_ltx_timeline(
                raw,
                resource_refs=resource_refs,
            )
        elif source_type_lower in {"rh", "runninghub"}:
            node.update(
                {
                    "workflow_kind": runninghub_kind,
                    "workflow_values": _legacy_runninghub_values(raw),
                    "workflow_use_wallet": raw.get("rhPayment") == "wallet",
                    "workflow_instance_type": (
                        "plus" if raw.get("instanceType") == "plus" else ""
                    ),
                    "runninghub_source_id": runninghub_source_id,
                    "runninghub_source_kind": runninghub_kind,
                }
            )
            random_fields = raw.get("rhRandomActive")
            if isinstance(random_fields, dict):
                node["workflow_random_fields"] = {
                    str(key): value is not False for key, value in random_fields.items()
                }
    return node


def _adapt_infinite_canvas_document(
    document: dict[str, Any],
    archive_files: dict[str, bytes],
) -> dict[str, Any]:
    source_format = str(document.get("format") or "")
    if source_format not in INFINITE_CANVAS_FORMATS:
        return document
    resource_refs: dict[str, str] = {}
    resources: list[dict[str, Any]] = []
    for raw in document.get("resources") or []:
        if not isinstance(raw, dict):
            continue
        archive_path = str(raw.get("archive") or "")
        data = archive_files.get(archive_path)
        if data is None:
            continue
        sha = hashlib.sha256(data).hexdigest()
        name = _safe_filename(str(raw.get("name") or ""), PurePosixPath(archive_path).name)
        mime = mimetypes.guess_type(name)[0] or "application/octet-stream"
        kind = _legacy_kind(mime.split("/", 1)[0], name)
        ref = f"{kind}:{sha}"
        resources.append(
            {
                "ref": ref,
                "kind": kind,
                "sha256": sha,
                "mime": mime,
                "name": name,
                "bytes": len(data),
                "archive": archive_path,
            }
        )
        for key in ("url", "archive", "name"):
            value = raw.get(key)
            if isinstance(value, str) and value:
                resource_refs[value] = ref
        resource_refs[PurePosixPath(archive_path).name] = ref
        resource_refs[f"./{archive_path}"] = ref

    nodes = [
        _legacy_node(raw, resource_refs=resource_refs)
        for raw in document.get("nodes") or []
        if isinstance(raw, dict)
    ]
    connections = [
        {
            "from": str(raw.get("from") or ""),
            "to": str(raw.get("to") or ""),
            "kind": raw.get("kind") if raw.get("kind") in studio.CONNECTION_KINDS else "flow",
        }
        for raw in document.get("connections") or []
        if isinstance(raw, dict)
    ]
    return {
        "format": FORMAT,
        "version": VERSION,
        "source_format": source_format,
        "source_version": document.get("version"),
        "nodes": nodes,
        "connections": connections,
        "resources": resources,
    }


async def _existing_by_sha(
    session: AsyncSession, resources: list[dict]
) -> tuple[dict[str, ImageAsset], dict[str, StudioMediaAsset]]:
    image_shas = [
        str(item.get("sha256"))
        for item in resources
        if item.get("kind") == "image" and item.get("sha256")
    ]
    media_shas = [
        str(item.get("sha256"))
        for item in resources
        if item.get("kind") != "image" and item.get("sha256")
    ]
    images: dict[str, ImageAsset] = {}
    media: dict[str, StudioMediaAsset] = {}
    if image_shas:
        rows = (
            await session.execute(select(ImageAsset).where(ImageAsset.sha256.in_(image_shas)))
        ).scalars()
        images = {row.sha256: row for row in rows}
    if media_shas:
        rows = (
            await session.execute(
                select(StudioMediaAsset).where(StudioMediaAsset.sha256.in_(media_shas))
            )
        ).scalars()
        media = {row.sha256: row for row in rows}
    return images, media


async def _bind_imported_workflows(
    session: AsyncSession,
    nodes: list[dict[str, Any]],
) -> None:
    title_by_source = {
        "minimax": "MiniMax H3",
        "smart-minimax": "MiniMax H3",
        "ltx": "LTX Director v2",
        "ltxdirector": "LTX Director v2",
        "ltx-director": "LTX Director v2",
    }
    wanted = {
        title_by_source[str(node.get("source_type") or "").lower()]
        for node in nodes
        if str(node.get("source_type") or "").lower() in title_by_source
    }
    runninghub_ids = {
        str(node.get("runninghub_source_id") or "")
        for node in nodes
        if str(node.get("runninghub_source_kind") or "") in {"app", "workflow", "model"}
        and str(node.get("runninghub_source_id") or "")
    }
    runninghub_ids.update(
        str(node.get("runninghub_model_hint") or "")
        for node in nodes
        if str(node.get("runninghub_model_hint") or "")
    )
    if not wanted and not runninghub_ids:
        return
    await studio_workflows.ensure_bundled(session)
    rows = (
        await session.execute(
            select(StudioWorkflow).where(
                StudioWorkflow.enabled.is_(True),
                StudioWorkflow.title.in_(wanted),
            )
        )
    ).scalars()
    by_title = {row.title: row for row in rows}
    runninghub_rows = []
    if runninghub_ids:
        runninghub_rows = list(
            (
                await session.execute(
                    select(StudioWorkflow).where(
                        StudioWorkflow.enabled.is_(True),
                        StudioWorkflow.provider == "runninghub",
                        StudioWorkflow.source_id.in_(runninghub_ids),
                    )
                )
            ).scalars()
        )
    by_runninghub_ref = {(str(row.source_id), row.kind): row for row in runninghub_rows}
    for node in nodes:
        title = title_by_source.get(str(node.get("source_type") or "").lower())
        workflow = by_title.get(title or "")
        if workflow is None:
            workflow = by_runninghub_ref.get(
                (
                    str(
                        node.get("runninghub_source_id")
                        or node.get("runninghub_model_hint")
                        or ""
                    ),
                    str(
                        node.get("runninghub_source_kind")
                        or ("model" if node.get("runninghub_model_hint") else "")
                    ),
                )
            )
        if workflow is None:
            continue
        node.update(
            {
                "title": workflow.title,
                "workflow_id": workflow.id,
                "workflow_provider": workflow.provider,
                "workflow_kind": workflow.kind,
            }
        )
        if workflow.provider == "runninghub" and workflow.kind == "model":
            values = node.pop("runninghub_values", {})
            if not isinstance(values, dict):
                values = {}
            prompt = str(node.pop("prompt_draft", "") or "").strip()
            if prompt:
                for index, field in enumerate((workflow.ui_schema or {}).get("fields") or []):
                    if not isinstance(field, dict):
                        continue
                    identity = " ".join(
                        str(field.get(key) or "")
                        for key in ("id", "fieldName", "input", "label", "name")
                    ).lower()
                    if "prompt" not in identity and "提示" not in identity:
                        continue
                    node_id = field.get("nodeId") or field.get("node") or index
                    field_name = field.get("fieldName") or field.get("input") or index
                    field_id = str(
                        field.get("id")
                        or f"{node_id}::{field_name}"
                    )
                    values.setdefault(field_id, prompt)
                    break
            node.update(
                {
                    "type": "workflow",
                    "workflow_values": values,
                    "workflow_use_wallet": True,
                }
            )


def _restore_canvas_item(
    raw: dict[str, Any],
    mapped: dict[str, tuple[str, int]],
    missing: list[str],
) -> dict[str, Any]:
    item = dict(raw)
    ref = str(item.pop("resource_ref", "") or "")
    resolved = mapped.get(ref)
    if resolved is None:
        if ref:
            item["missing"] = True
            missing.append(ref)
        return item
    kind, asset_id = resolved
    item.pop("missing", None)
    if kind == "image":
        item["asset_id"] = asset_id
        item["kind"] = "image"
        item.pop("media_asset_id", None)
    else:
        item["media_asset_id"] = asset_id
        item["kind"] = kind
        item["url"] = f"/api/studio/media-assets/{asset_id}/content"
        item.pop("asset_id", None)
    return item


async def import_workflow(
    session: AsyncSession,
    *,
    raw: bytes,
    filename: str,
) -> dict[str, Any]:
    document, archive_files = _parse_document(raw, filename)
    document = _adapt_infinite_canvas_document(document, archive_files)
    await _bind_imported_workflows(session, document["nodes"])
    try:
        portable_nodes, portable_connections, _ = studio.normalize_canvas_payload(
            document["nodes"], document["connections"], None
        )
    except studio.StudioError as exc:
        raise CanvasWorkflowError(str(exc)) from exc
    if not portable_nodes:
        raise CanvasWorkflowError("工作流中没有可导入的节点")
    resource_meta = [item for item in document["resources"] if isinstance(item, dict)]
    existing_images, existing_media = await _existing_by_sha(session, resource_meta)
    mapped: dict[str, tuple[str, int]] = {}
    reused = 0
    rebuilt = 0

    for item in resource_meta:
        ref = str(item.get("ref") or "")
        sha = str(item.get("sha256") or "")
        kind = str(item.get("kind") or "file").lower()
        if not ref or not sha:
            continue
        row: ImageAsset | StudioMediaAsset | None
        row = existing_images.get(sha) if kind == "image" else existing_media.get(sha)
        if row is not None:
            mapped[ref] = (kind, row.id)
            reused += 1
            continue
        archive_path = str(item.get("archive") or "")
        data = archive_files.get(archive_path)
        if data is None:
            continue
        if hashlib.sha256(data).hexdigest() != sha:
            resource_name = _safe_filename(str(item.get("name") or ""), ref)
            raise CanvasWorkflowError(f"资源校验失败：{resource_name}")
        if kind == "image":
            row = await image_assets.ingest_one(
                session,
                data,
                target_key=str(item.get("target_key") or "workflow-import")[:48],
                prompt=str(item.get("prompt") or ""),
                source="local",
                op="workflow-import",
            )
        else:
            try:
                row = await studio_media_assets.ingest_one(
                    session,
                    data,
                    kind=kind,
                    name=_safe_filename(str(item.get("name") or ""), f"asset-{sha[:8]}"),
                    mime=str(item.get("mime") or "application/octet-stream"),
                    width=item.get("width") if isinstance(item.get("width"), int) else None,
                    height=item.get("height") if isinstance(item.get("height"), int) else None,
                    duration_ms=(
                        item.get("duration_ms")
                        if isinstance(item.get("duration_ms"), int)
                        else None
                    ),
                    details={"source": "workflow-import"},
                )
            except studio_media_assets.StudioMediaAssetError as exc:
                raise CanvasWorkflowError(str(exc)) from exc
        mapped[ref] = (kind, row.id)
        rebuilt += 1
    nodes = copy.deepcopy(portable_nodes)
    missing: list[str] = []
    for node in nodes:
        if not isinstance(node, dict):
            continue
        for field in ("items", "attachments", "manual_references"):
            next_items: list[dict] = []
            for raw_item in node.get(field) or []:
                if not isinstance(raw_item, dict):
                    continue
                next_items.append(_restore_canvas_item(raw_item, mapped, missing))
            if field in node:
                node[field] = next_items

        next_refs: list[dict] = []
        for raw_ref in node.get("prompt_draft_refs") or []:
            if not isinstance(raw_ref, dict):
                continue
            ref_item = dict(raw_ref)
            ref = str(ref_item.pop("resource_ref", "") or "")
            resolved = mapped.get(ref)
            if resolved is not None and resolved[0] == "image":
                ref_item["asset_id"] = resolved[1]
                next_refs.append(ref_item)
            elif ref:
                missing.append(ref)
        if "prompt_draft_refs" in node:
            node["prompt_draft_refs"] = next_refs

        timeline = node.get("workflow_timeline")
        if isinstance(timeline, dict):
            next_timeline = copy.deepcopy(timeline)
            for segment in next_timeline.get("segments") or []:
                if not isinstance(segment, dict):
                    continue
                direct_ref = str(segment.pop("resource_ref", "") or "")
                direct = mapped.get(direct_ref)
                if direct is not None and direct[0] == "image":
                    segment["asset_id"] = direct[1]
                    segment.pop("missing", None)
                elif direct_ref:
                    segment["missing"] = True
                    missing.append(direct_ref)
                if isinstance(segment.get("references"), list):
                    segment["references"] = [
                        _restore_canvas_item(item, mapped, missing)
                        for item in segment["references"]
                        if isinstance(item, dict)
                    ]
                if isinstance(segment.get("result"), dict):
                    segment["result"] = _restore_canvas_item(segment["result"], mapped, missing)
            for segment in next_timeline.get("audio_segments") or []:
                if not isinstance(segment, dict):
                    continue
                direct_ref = str(segment.pop("resource_ref", "") or "")
                direct = mapped.get(direct_ref)
                if direct is not None and direct[0] == "audio":
                    segment["media_asset_id"] = direct[1]
                    segment.pop("missing", None)
                elif direct_ref:
                    segment["missing"] = True
                    missing.append(direct_ref)
            node["workflow_timeline"] = next_timeline

        values = node.get("workflow_values")
        if isinstance(values, dict):
            next_values = dict(values)
            for key, value in values.items():
                if not isinstance(value, str) or not value.startswith("resource:"):
                    continue
                resolved = mapped.get(value.removeprefix("resource:"))
                next_values[key] = (
                    f"asset:{resolved[1]}"
                    if resolved is not None and resolved[0] == "image"
                    else ""
                )
            node["workflow_values"] = next_values

    try:
        clean_nodes, clean_connections, _ = studio.normalize_canvas_payload(
            nodes, portable_connections, None
        )
    except studio.StudioError as exc:
        raise CanvasWorkflowError(str(exc)) from exc
    if not clean_nodes:
        raise CanvasWorkflowError("工作流中没有可导入的节点")

    remap = {str(node["id"]): f"wf-{uuid4().hex[:8]}-{node['id']}" for node in clean_nodes}
    for node in clean_nodes:
        old_id = str(node["id"])
        node["id"] = remap[old_id]
        if isinstance(node.get("member_ids"), list):
            node["member_ids"] = [
                remap[str(member)] for member in node["member_ids"] if str(member) in remap
            ]
        history_for = node.get("history_for")
        if isinstance(history_for, str) and history_for in remap:
            node["history_for"] = remap[history_for]
    clean_connections = [
        {"from": remap[conn["from"]], "to": remap[conn["to"]], "kind": conn["kind"]}
        for conn in clean_connections
        if conn["from"] in remap and conn["to"] in remap
    ]
    await session.commit()
    unique_missing = sorted(set(missing))
    return {
        "nodes": clean_nodes,
        "connections": clean_connections,
        "reused": reused,
        "rebuilt": rebuilt,
        "missing": unique_missing,
    }
