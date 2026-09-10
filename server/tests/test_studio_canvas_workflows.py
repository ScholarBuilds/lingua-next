"""画布工作流包：指纹化导出、资源打包与安全导入。"""

from __future__ import annotations

import io
import json
import zipfile
from urllib.parse import unquote

from PIL import Image

from domain import image_assets
from domain import storage as storage_mod
from domain.models import StudioWorkflow
from domain.storage import LocalStorage
from domain.studio_media_assets import ingest_one as ingest_media


def _test_png() -> bytes:
    image = Image.new("RGB", (96, 96))
    pixels = image.load()
    for y in range(96):
        for x in range(96):
            pixels[x, y] = ((x * 7) % 255, (y * 11) % 255, ((x + y) * 5) % 255)
    out = io.BytesIO()
    image.save(out, format="PNG")
    return out.getvalue()


async def test_output_download_returns_original_images_in_requested_order(
    client,
    session,
    tmp_path,
) -> None:
    storage_mod.set_storage(LocalStorage(tmp_path))
    try:
        first_bytes = _test_png()
        second_bytes = first_bytes + b"different"
        first = await image_assets.ingest_one(
            session,
            first_bytes,
            target_key="test",
            prompt="first",
            source="local",
        )
        second = await image_assets.ingest_one(
            session,
            second_bytes,
            target_key="test",
            prompt="second",
            source="local",
        )
        await session.commit()

        response = await client.post(
            "/studio/canvas-workflows/outputs/download",
            json={
                "asset_ids": [second.id, first.id, second.id],
                "filename": "my/output",
            },
        )

        assert response.status_code == 200
        assert response.headers["content-type"] == "application/zip"
        # 路径部分被剥掉，不能借文件名写出下载目录。
        assert unquote(response.headers["content-disposition"]).endswith("output.zip")
        with zipfile.ZipFile(io.BytesIO(response.content)) as bundle:
            assert bundle.namelist() == [
                f"image-01-{second.id}.png",
                f"image-02-{first.id}.png",
            ]
            assert bundle.read(bundle.namelist()[0]) == second_bytes
            assert bundle.read(bundle.namelist()[1]) == first_bytes
    finally:
        storage_mod.set_storage(None)


async def test_output_download_rejects_missing_asset(client) -> None:
    response = await client.post(
        "/studio/canvas-workflows/outputs/download",
        json={"asset_ids": [999999], "filename": "missing"},
    )
    assert response.status_code == 400
    assert "999999" in response.json()["detail"]


async def test_json_export_uses_portable_refs_and_import_remaps_ids(
    client,
    session,
    tmp_path,
) -> None:
    storage_mod.set_storage(LocalStorage(tmp_path))
    try:
        image = await image_assets.ingest_one(
            session,
            _test_png(),
            target_key="test",
            prompt="portable image",
            source="local",
        )
        media = await ingest_media(
            session,
            b"portable-audio",
            kind="audio",
            name="voice.mp3",
            mime="audio/mpeg",
        )
        await session.commit()

        nodes = [
            {
                "id": "image-old",
                "type": "image",
                "x": 10,
                "y": 20,
                "items": [{"kind": "image", "asset_id": image.id}],
                "prompt_draft_refs": [{"asset_id": image.id, "label": "图1"}],
                "manual_references": [
                    {"kind": "image", "asset_id": image.id, "name": "手动参考"}
                ],
                "attachments": [
                    {"kind": "audio", "media_asset_id": media.id, "name": "语音参考"}
                ],
            },
            {
                "id": "audio-old",
                "type": "audio",
                "x": 200,
                "y": 20,
                "items": [
                    {
                        "kind": "audio",
                        "media_asset_id": media.id,
                        "url": f"/api/studio/media-assets/{media.id}/content",
                    }
                ],
            },
            {
                "id": "workflow-old",
                "type": "workflow",
                "x": 400,
                "y": 20,
                "workflow_values": {"source": f"asset:{image.id}"},
                "workflow_timeline": {
                    "kind": "minimax",
                    "selected_id": "shot-1",
                    "segments": [
                        {
                            "id": "shot-1",
                            "start": 0,
                            "length": 8,
                            "prompt": "portable segment",
                            "type": "image",
                            "asset_id": image.id,
                            "references": [
                                {"kind": "image", "asset_id": image.id},
                                {"kind": "audio", "media_asset_id": media.id},
                            ],
                            "result": {
                                "kind": "audio",
                                "media_asset_id": media.id,
                            },
                        }
                    ],
                    "audio_segments": [
                        {
                            "id": "voice-1",
                            "start": 0,
                            "length": 120,
                            "trim_start": 0,
                            "media_asset_id": media.id,
                        }
                    ],
                },
            },
        ]
        response = await client.post(
            "/studio/canvas-workflows/export",
            json={
                "nodes": nodes,
                "connections": [{"from": "image-old", "to": "workflow-old", "kind": "input"}],
                "filename": "测试工作流",
            },
        )
        assert response.status_code == 200
        assert "测试工作流.json" in unquote(response.headers["content-disposition"])
        exported = response.json()
        assert exported["format"] == "lingua-canvas-workflow"
        assert len(exported["resources"]) == 2
        assert "asset_id" not in exported["nodes"][0]["items"][0]
        assert exported["nodes"][0]["items"][0]["resource_ref"].startswith("image:")
        assert exported["nodes"][0]["manual_references"][0]["resource_ref"].startswith(
            "image:"
        )
        assert exported["nodes"][0]["attachments"][0]["resource_ref"].startswith(
            "media:"
        )
        assert "media_asset_id" not in exported["nodes"][1]["items"][0]
        assert exported["nodes"][2]["workflow_values"]["source"].startswith("resource:image:")
        portable_segment = exported["nodes"][2]["workflow_timeline"]["segments"][0]
        assert portable_segment["resource_ref"].startswith("image:")
        assert portable_segment["references"][0]["resource_ref"].startswith("image:")
        assert portable_segment["references"][1]["resource_ref"].startswith("media:")
        assert portable_segment["result"]["resource_ref"].startswith("media:")
        portable_audio = exported["nodes"][2]["workflow_timeline"]["audio_segments"][0]
        assert portable_audio["resource_ref"].startswith("media:")

        imported = await client.post(
            "/studio/canvas-workflows/import",
            files={
                "file": (
                    "workflow.json",
                    json.dumps(exported, ensure_ascii=False).encode(),
                    "application/json",
                )
            },
        )
        assert imported.status_code == 200
        result = imported.json()
        assert result["reused"] == 2
        assert result["rebuilt"] == 0
        assert result["missing"] == []
        old_ids = {"image-old", "audio-old", "workflow-old"}
        assert all(node["id"] not in old_ids for node in result["nodes"])
        image_node = next(node for node in result["nodes"] if node["type"] == "image")
        audio_node = next(node for node in result["nodes"] if node["type"] == "audio")
        workflow_node = next(node for node in result["nodes"] if node["type"] == "workflow")
        assert image_node["items"][0]["asset_id"] == image.id
        assert image_node["manual_references"][0]["asset_id"] == image.id
        assert image_node["attachments"][0]["media_asset_id"] == media.id
        assert audio_node["items"][0]["media_asset_id"] == media.id
        assert workflow_node["workflow_values"]["source"] == f"asset:{image.id}"
        imported_segment = workflow_node["workflow_timeline"]["segments"][0]
        assert imported_segment["asset_id"] == image.id
        assert imported_segment["references"][0]["asset_id"] == image.id
        assert imported_segment["references"][1]["media_asset_id"] == media.id
        assert imported_segment["result"]["media_asset_id"] == media.id
        imported_audio = workflow_node["workflow_timeline"]["audio_segments"][0]
        assert imported_audio["media_asset_id"] == media.id
        assert result["connections"][0]["from"] == image_node["id"]
        assert result["connections"][0]["to"] == workflow_node["id"]
    finally:
        storage_mod.set_storage(None)


async def test_zip_export_contains_original_resources(client, session, tmp_path) -> None:
    storage_mod.set_storage(LocalStorage(tmp_path))
    try:
        media = await ingest_media(
            session,
            b"video-in-workflow-package",
            kind="video",
            name="clip.mp4",
            mime="video/mp4",
        )
        await session.commit()
        response = await client.post(
            "/studio/canvas-workflows/export",
            json={
                "nodes": [
                    {
                        "id": "video-node",
                        "type": "video",
                        "x": 0,
                        "y": 0,
                        "items": [{"kind": "video", "media_asset_id": media.id}],
                    }
                ],
                "connections": [],
                "include_resources": True,
                "filename": "portable",
            },
        )
        assert response.status_code == 200
        assert response.headers["content-type"] == "application/zip"
        with zipfile.ZipFile(io.BytesIO(response.content)) as bundle:
            assert "workflow.json" in bundle.namelist()
            workflow = json.loads(bundle.read("workflow.json"))
            archive_path = workflow["resources"][0]["archive"]
            assert bundle.read(archive_path) == b"video-in-workflow-package"
    finally:
        storage_mod.set_storage(None)


async def test_infinite_canvas_compatible_export_roundtrips_nodes_and_resources(
    client,
    session,
    tmp_path,
) -> None:
    storage_mod.set_storage(LocalStorage(tmp_path))
    try:
        image = await image_assets.ingest_one(
            session,
            _test_png(),
            target_key="test",
            prompt="reverse export",
            source="local",
        )
        await session.commit()
        response = await client.post(
            "/studio/canvas-workflows/export",
            json={
                "nodes": [
                    {
                        "id": "input-1",
                        "type": "image",
                        "x": 10,
                        "y": 20,
                        "items": [{"kind": "image", "asset_id": image.id}],
                        "manual_references": [
                            {"kind": "image", "asset_id": image.id, "name": "参考图"}
                        ],
                        "run_settings": {"api_key": "must-not-export"},
                    },
                    {
                        "id": "output-1",
                        "type": "output",
                        "x": 360,
                        "y": 20,
                        "items": [{"kind": "image", "asset_id": image.id}],
                    },
                ],
                "connections": [{"from": "input-1", "to": "output-1", "kind": "flow"}],
                "include_resources": True,
                "target_format": "infinite-canvas-workflow",
                "filename": "reverse-compatible",
            },
        )
        assert response.status_code == 200, response.text
        with zipfile.ZipFile(io.BytesIO(response.content)) as bundle:
            workflow = json.loads(bundle.read("workflow.json"))
            assert workflow["format"] == "infinite-canvas-workflow"
            assert [node["type"] for node in workflow["nodes"]] == ["image", "output"]
            resource = workflow["resources"][0]
            assert workflow["nodes"][0]["url"] == resource["url"]
            assert workflow["nodes"][0]["manualInputRefs"][0]["url"] == resource["url"]
            assert workflow["nodes"][0]["runSettings"]["api_key"] == "[REDACTED]"
            assert workflow["nodes"][1]["images"][0]["url"] == resource["url"]
            assert bundle.read(resource["archive"]) == _test_png()

        imported = await client.post(
            "/studio/canvas-workflows/import",
            files={"file": ("reverse-compatible.zip", response.content, "application/zip")},
        )
        assert imported.status_code == 200, imported.text
        result = imported.json()
        assert result["reused"] == 1
        assert [node["type"] for node in result["nodes"]] == ["image", "output"]
        assert result["nodes"][0]["manual_references"][0]["asset_id"] == image.id
        assert len(result["connections"]) == 1
    finally:
        storage_mod.set_storage(None)


async def test_full_canvas_export_keeps_metadata_redacts_secrets_and_bundles_resources(
    client,
    session,
    tmp_path,
) -> None:
    storage_mod.set_storage(LocalStorage(tmp_path))
    try:
        media = await ingest_media(
            session,
            b"full-canvas-video",
            kind="video",
            name="scene.mp4",
            mime="video/mp4",
        )
        await session.commit()
        created_response = await client.post(
            "/studio/canvases",
            json={"title": "完整画布", "kind": "classic", "board_x": 120, "board_y": 80},
        )
        assert created_response.status_code == 200
        created = created_response.json()
        saved = await client.put(
            f"/studio/canvases/{created['id']}",
            json={
                "nodes": [
                    {
                        "id": "video-node",
                        "type": "video",
                        "x": 10,
                        "y": 20,
                        "items": [{"kind": "video", "media_asset_id": media.id}],
                    }
                ],
                "connections": [],
                "viewport": {"x": 30, "y": 40, "scale": 1.2},
                "settings": {"theme": "dark", "api_key": "must-not-export"},
                "base_version": created["version"],
            },
        )
        assert saved.status_code == 200

        exported_response = await client.post(
            f"/studio/canvas-workflows/canvases/{created['id']}/export",
            json={"filename": "完整画布"},
        )
        assert exported_response.status_code == 200
        assert "完整画布.json" in unquote(exported_response.headers["content-disposition"])
        exported = exported_response.json()
        assert exported["format"] == "lingua-canvas"
        assert exported["title"] == "完整画布"
        assert exported["kind"] == "classic"
        assert exported["board_x"] == 120
        assert exported["viewport"] == {"x": 30.0, "y": 40.0, "scale": 1.2}
        assert exported["settings"]["api_key"] == "[REDACTED]"
        assert exported["nodes"][0]["items"][0]["resource_ref"].startswith("media:")

        archive_response = await client.post(
            f"/studio/canvas-workflows/canvases/{created['id']}/export",
            json={"filename": "完整画布", "include_resources": True},
        )
        assert archive_response.status_code == 200
        with zipfile.ZipFile(io.BytesIO(archive_response.content)) as bundle:
            assert {"canvas.json", "workflow.json", "resources-manifest.json"} <= set(
                bundle.namelist()
            )
            canvas_document = json.loads(bundle.read("canvas.json"))
            manifest = json.loads(bundle.read("resources-manifest.json"))
            archive_path = canvas_document["resources"][0]["archive"]
            assert manifest["resources"][0]["file"] == archive_path
            assert bundle.read(archive_path) == b"full-canvas-video"
    finally:
        storage_mod.set_storage(None)


async def test_import_rejects_package_without_workflow_json(client) -> None:
    raw = io.BytesIO()
    with zipfile.ZipFile(raw, "w") as bundle:
        bundle.writestr("README.txt", "no workflow")
    response = await client.post(
        "/studio/canvas-workflows/import",
        files={"file": ("bad.zip", raw.getvalue(), "application/zip")},
    )
    assert response.status_code == 400
    assert response.json()["detail"] == "压缩包中没有 workflow.json"


async def test_import_adapts_infinite_smart_canvas_zip_and_rebuilds_resource(
    client,
    tmp_path,
) -> None:
    storage_mod.set_storage(LocalStorage(tmp_path))
    try:
        png = _test_png()
        document = {
            "format": "infinite-smart-canvas-workflow",
            "version": 1,
            "canvas_type": "smart",
            "nodes": [
                {
                    "id": "smart-image-1",
                    "type": "smart-image",
                    "x": 20,
                    "y": 30,
                    "title": "Source image",
                    "images": [
                        {
                            "url": "/output/source.png",
                            "name": "source.png",
                            "kind": "image",
                        }
                    ],
                    "runSettings": {"quality": "high", "api_key": "must-not-import"},
                },
                {
                    "id": "smart-prompt-1",
                    "type": "smart-prompt",
                    "x": 380,
                    "y": 30,
                    "text": "Keep the paper texture",
                },
                {
                    "id": "smart-loop-1",
                    "type": "smart-loop",
                    "x": 700,
                    "y": 30,
                    "count": 3,
                    "mode": "parallel",
                    "variablePrompt": "front\nside\nback",
                },
                {
                    "id": "output-1",
                    "type": "output",
                    "x": 1020,
                    "y": 30,
                    "images": [{"url": "/output/source.png", "kind": "image"}],
                },
            ],
            "connections": [
                {"from": "smart-image-1", "to": "smart-prompt-1"},
                {"from": "smart-prompt-1", "to": "smart-loop-1"},
            ],
            "resources": [
                {
                    "url": "/output/source.png",
                    "archive": "resources/source.png",
                    "name": "source.png",
                    "size": len(png),
                }
            ],
        }
        bundle_bytes = io.BytesIO()
        with zipfile.ZipFile(bundle_bytes, "w", zipfile.ZIP_DEFLATED) as bundle:
            bundle.writestr("workflow.json", json.dumps(document, ensure_ascii=False))
            bundle.writestr("resources/source.png", png)

        response = await client.post(
            "/studio/canvas-workflows/import",
            files={"file": ("source.zip", bundle_bytes.getvalue(), "application/zip")},
        )
        assert response.status_code == 200, response.text
        result = response.json()
        assert result["rebuilt"] == 1
        assert result["missing"] == []
        assert [node["type"] for node in result["nodes"]] == [
            "image",
            "prompt",
            "loop",
            "output",
        ]
        image_node, prompt_node, loop_node, output_node = result["nodes"]
        assert image_node["items"][0]["asset_id"] > 0
        assert image_node["run_settings"]["api_key"] == "[REDACTED]"
        assert image_node["source_type"] == "smart-image"
        assert prompt_node["text"] == "Keep the paper texture"
        assert loop_node["count"] == 3
        assert loop_node["mode"] == "parallel"
        assert loop_node["variable_prompts"] == ["front", "side", "back"]
        assert output_node["items"][0]["asset_id"] == image_node["items"][0]["asset_id"]
        assert len(result["connections"]) == 2
    finally:
        storage_mod.set_storage(None)


async def test_import_adapts_midjourney_state_and_bundled_output(client, tmp_path) -> None:
    storage_mod.set_storage(LocalStorage(tmp_path))
    try:
        png = _test_png()
        document = {
            "format": "infinite-canvas-workflow",
            "version": 1,
            "nodes": [
                {
                    "id": "midjourney-1",
                    "type": "midjourney",
                    "x": 80,
                    "y": 100,
                    "title": "Imported Midjourney",
                    "prompt": "paper theatre at night",
                    "apiProvider": "APIMart",
                    "mode": "edit",
                    "size": "16:9",
                    "version": "8.2",
                    "speed": "fast",
                    "lastTaskId": "mj-source-task",
                    "lastAction": "remix_strong",
                    "lastTaskStatus": "SUCCESS",
                    "lastImageCount": 4,
                    "lastPrompt": "paper theatre",
                    "mjModalTaskId": "mj-modal-task",
                    "mjModalPrompt": "replace the moon",
                    "apiKey": "must-not-import",
                    "generatedOutputs": [
                        {"url": "/output/mj-grid.png", "kind": "image"}
                    ],
                }
            ],
            "connections": [],
            "resources": [
                {
                    "url": "/output/mj-grid.png",
                    "archive": "resources/mj-grid.png",
                    "name": "mj-grid.png",
                    "size": len(png),
                }
            ],
        }
        bundle_bytes = io.BytesIO()
        with zipfile.ZipFile(bundle_bytes, "w", zipfile.ZIP_DEFLATED) as bundle:
            bundle.writestr("workflow.json", json.dumps(document, ensure_ascii=False))
            bundle.writestr("resources/mj-grid.png", png)

        response = await client.post(
            "/studio/canvas-workflows/import",
            files={"file": ("midjourney.zip", bundle_bytes.getvalue(), "application/zip")},
        )

        assert response.status_code == 200, response.text
        result = response.json()
        assert result["rebuilt"] == 1
        assert result["missing"] == []
        node = result["nodes"][0]
        assert node["type"] == "midjourney"
        assert node["prompt_draft"] == "paper theatre at night"
        assert node["mj_provider_hint"] == "APIMart"
        assert node["mj_mode"] == "edit"
        assert node["mj_size"] == "16:9"
        assert node["mj_version"] == "8.2"
        assert node["mj_speed"] == "fast"
        assert node["mj_last_task_id"] == "mj-source-task"
        assert node["mj_last_action"] == "remix_strong"
        assert node["mj_last_task_status"] == "SUCCESS"
        assert node["mj_last_image_count"] == 4
        assert node["mj_last_prompt"] == "paper theatre"
        assert node["mj_modal_task_id"] == "mj-modal-task"
        assert node["mj_modal_prompt"] == "replace the moon"
        assert node["items"][0]["asset_id"] > 0
        assert node["source_payload"]["apiKey"] == "[REDACTED]"
    finally:
        storage_mod.set_storage(None)


async def test_import_adapts_minimax_segments_and_binds_bundled_workflow(
    client,
    tmp_path,
) -> None:
    storage_mod.set_storage(LocalStorage(tmp_path))
    try:
        resources = {
            "resources/reference.png": _test_png(),
            "resources/reference.mp4": b"minimax-reference-video",
            "resources/reference.mp3": b"minimax-reference-audio",
        }
        document = {
            "format": "infinite-canvas-workflow",
            "version": 1,
            "nodes": [
                {
                    "id": "minimax-1",
                    "type": "minimax",
                    "x": 100,
                    "y": 120,
                    "title": "Imported director",
                    "duration": 6,
                    "aspectRatio": "9:16 (Portrait)",
                    "selectedSegmentId": "shot-1",
                    "segments": [
                        {
                            "id": "shot-1",
                            "start": 0,
                            "duration": 6,
                            "prompt": "A dancer turns toward camera",
                            "aspectRatio": "9:16 (Portrait)",
                            "megapixels": 0.7,
                            "seed": 42,
                            "trimIn": 0.5,
                            "trimOut": 5.5,
                            "refs": {
                                "image": [{"url": "/reference.png", "kind": "image"}],
                                "video": [{"url": "/reference.mp4", "kind": "video"}],
                                "audio": [{"url": "/reference.mp3", "kind": "audio"}],
                            },
                        }
                    ],
                }
            ],
            "connections": [],
            "resources": [
                {
                    "url": f"/{path.rsplit('/', 1)[-1]}",
                    "archive": path,
                    "name": path.rsplit("/", 1)[-1],
                }
                for path in resources
            ],
        }
        bundle_bytes = io.BytesIO()
        with zipfile.ZipFile(bundle_bytes, "w", zipfile.ZIP_DEFLATED) as bundle:
            bundle.writestr("workflow.json", json.dumps(document, ensure_ascii=False))
            for path, data in resources.items():
                bundle.writestr(path, data)

        response = await client.post(
            "/studio/canvas-workflows/import",
            files={"file": ("minimax.zip", bundle_bytes.getvalue(), "application/zip")},
        )

        assert response.status_code == 200, response.text
        result = response.json()
        assert result["rebuilt"] == 3
        assert result["missing"] == []
        node = result["nodes"][0]
        assert node["type"] == "workflow"
        assert node["title"] == "MiniMax H3"
        assert node["workflow_id"] > 0
        assert node["workflow_provider"] == "comfyui"
        timeline = node["workflow_timeline"]
        assert timeline["kind"] == "minimax"
        assert timeline["selected_id"] == "shot-1"
        segment = timeline["segments"][0]
        assert segment["length"] == 6
        assert segment["prompt"] == "A dancer turns toward camera"
        assert segment["aspect_ratio"] == "9:16 (Portrait)"
        assert segment["megapixels"] == 0.7
        assert segment["seed"] == 42
        assert segment["trim_in"] == 0.5
        assert segment["trim_out"] == 5.5
        assert [item["kind"] for item in segment["references"]] == [
            "image",
            "video",
            "audio",
        ]
        assert segment["references"][0]["asset_id"] > 0
        assert segment["references"][1]["media_asset_id"] > 0
        assert segment["references"][2]["media_asset_id"] > 0
    finally:
        storage_mod.set_storage(None)


async def test_import_adapts_ltx_director_timeline_audio_and_advanced_values(
    client,
    tmp_path,
) -> None:
    storage_mod.set_storage(LocalStorage(tmp_path))
    try:
        resources = {
            "resources/reference.png": _test_png(),
            "resources/voice.mp3": b"ltx-director-audio",
        }
        timeline = {
            "segments": [
                {
                    "id": "image-shot",
                    "start": 24,
                    "length": 48,
                    "prompt": "camera moves through paper clouds",
                    "type": "image",
                    "imageB64": "/reference.png",
                    "guideStrength": 1.25,
                },
                {
                    "id": "text-shot",
                    "start": 96,
                    "length": 12,
                    "prompt": "",
                    "type": "text",
                },
            ],
            "audioSegments": [
                {
                    "id": "voice-1",
                    "type": "audio",
                    "start": 12,
                    "length": 72,
                    "trimStart": 6,
                    "audioDurationFrames": 90,
                    "audioFile": "voice.mp3",
                    "fileName": "voice.mp3",
                }
            ],
        }
        document = {
            "format": "infinite-canvas-workflow",
            "version": 1,
            "nodes": [
                {
                    "id": "ltx-1",
                    "type": "ltxDirector",
                    "x": 80,
                    "y": 90,
                    "globalPrompt": "paper cutout animation",
                    "durationFrames": 144,
                    "durationSeconds": 6,
                    "frameRate": 24,
                    "customWidth": 1280,
                    "customHeight": 720,
                    "displayMode": "frames",
                    "useCustomAudio": True,
                    "imgCompression": 22,
                    "epsilon": 0.002,
                    "divisibleBy": 64,
                    "noiseSeed": 91,
                    "ltxSelectedSegId": "image-shot",
                    "ltxTimelineData": json.dumps(timeline),
                }
            ],
            "connections": [],
            "resources": [
                {
                    "url": f"/{path.rsplit('/', 1)[-1]}",
                    "archive": path,
                    "name": path.rsplit("/", 1)[-1],
                }
                for path in resources
            ],
        }
        bundle_bytes = io.BytesIO()
        with zipfile.ZipFile(bundle_bytes, "w", zipfile.ZIP_DEFLATED) as bundle:
            bundle.writestr("workflow.json", json.dumps(document, ensure_ascii=False))
            for path, data in resources.items():
                bundle.writestr(path, data)

        response = await client.post(
            "/studio/canvas-workflows/import",
            files={"file": ("ltx.zip", bundle_bytes.getvalue(), "application/zip")},
        )

        assert response.status_code == 200, response.text
        result = response.json()
        assert result["rebuilt"] == 2
        assert result["missing"] == []
        node = result["nodes"][0]
        assert node["type"] == "workflow"
        assert node["title"] == "LTX Director v2"
        assert node["workflow_id"] > 0
        assert node["workflow_provider"] == "comfyui"
        assert node["workflow_values"] == {
            "f_global_prompt": "paper cutout animation",
            "f_duration_frames": 144,
            "f_duration_seconds": 6.0,
            "f_frame_rate": 24.0,
            "f_custom_width": 1280,
            "f_custom_height": 720,
            "f_use_custom_audio": True,
            "f_noise_seed": 91,
            "f_4t0z0g8": "maintain aspect ratio",
            "f_display_mode": "frames",
            "f_epsilon": 0.002,
            "f_divisible_by": 64,
            "f_img_compression": 22.0,
            "f_timeline_ui": "",
        }
        imported = node["workflow_timeline"]
        assert imported["kind"] == "ltx"
        assert imported["duration_frames"] == 144
        assert imported["frame_rate"] == 24.0
        assert imported["selected_id"] == "image-shot"
        assert imported["segments"][0]["start"] == 24.0
        assert imported["segments"][0]["asset_id"] > 0
        assert imported["segments"][0]["guideStrength"] == 1.25
        assert imported["audio_segments"][0]["media_asset_id"] > 0
        assert imported["audio_segments"][0]["trim_start"] == 6.0
        assert imported["audio_segments"][0]["audio_duration_frames"] == 90.0
    finally:
        storage_mod.set_storage(None)


async def test_import_adapts_runninghub_nodes_and_binds_saved_catalog_entries(client) -> None:
    document = {
        "format": "infinite-canvas-workflow",
        "version": 1,
        "nodes": [
            {
                "id": "rh-workflow",
                "type": "rh",
                "x": 100,
                "y": 120,
                "rhMode": "workflow",
                "rhConfigKey": "workflow:2058824859437850625",
                "workflowId": "2058824859437850625",
                "rhPayment": "wallet",
                "instanceType": "plus",
                "rhParams": {
                    "187::image": {"value": "source.png"},
                    "163::seed": {"value": 42},
                },
                "rhRandomActive": {"163::seed": False},
                "api_key": "must-not-import",
            },
            {
                "id": "rh-app",
                "type": "rh",
                "x": 600,
                "y": 120,
                "rhMode": "app",
                "webappId": "2058517022748798977",
                "rhParams": {"1::prompt": {"value": "paper texture"}},
            },
        ],
        "connections": [],
        "resources": [],
    }

    response = await client.post(
        "/studio/canvas-workflows/import",
        files={
            "file": (
                "runninghub.json",
                json.dumps(document, ensure_ascii=False).encode(),
                "application/json",
            )
        },
    )

    assert response.status_code == 200, response.text
    workflow_node, app_node = response.json()["nodes"]
    assert workflow_node["type"] == "workflow"
    assert workflow_node["title"] == "SeedVR2 高清放大"
    assert workflow_node["workflow_provider"] == "runninghub"
    assert workflow_node["workflow_kind"] == "workflow"
    assert workflow_node["workflow_values"] == {
        "187::image": "source.png",
        "163::seed": 42,
    }
    assert workflow_node["workflow_use_wallet"] is True
    assert workflow_node["workflow_instance_type"] == "plus"
    assert workflow_node["workflow_random_fields"] == {"163::seed": False}
    assert workflow_node["source_payload"]["api_key"] == "[REDACTED]"
    assert app_node["type"] == "workflow"
    assert app_node["title"] == "2511-风格迁移"
    assert app_node["workflow_provider"] == "runninghub"
    assert app_node["workflow_kind"] == "app"
    assert app_node["workflow_values"] == {"1::prompt": "paper texture"}


async def test_import_binds_runninghub_model_hint_to_saved_model_api(client, session) -> None:
    model = StudioWorkflow(
        key="runninghub:remote:model:runninghub/flux-image",
        title="Flux Image Model API",
        provider="runninghub",
        kind="model",
        source="remote",
        source_id="runninghub/flux-image",
        payload={"id": "runninghub/flux-image", "endpoint": "rhart-image/flux"},
        ui_schema={
            "fields": [
                {
                    "id": "model::prompt",
                    "nodeId": "model",
                    "fieldName": "prompt",
                    "fieldType": "TEXT",
                    "enabled": True,
                }
            ]
        },
        content_hash="f" * 64,
        enabled=True,
    )
    session.add(model)
    await session.commit()

    document = {
        "format": "infinite-canvas-workflow",
        "version": 1,
        "nodes": [
            {
                "id": "rh-model",
                "type": "rh",
                "x": 100,
                "y": 120,
                "rhConfigKey": "model:runninghub/flux-image",
                "rhMode": "model",
                "prompt": "a fox",
            }
        ],
        "connections": [],
        "resources": [],
    }

    response = await client.post(
        "/studio/canvas-workflows/import",
        files={
            "file": (
                "runninghub-model.json",
                json.dumps(document).encode(),
                "application/json",
            )
        },
    )

    assert response.status_code == 200, response.text
    node = response.json()["nodes"][0]
    assert node["type"] == "workflow"
    assert node["title"] == "Flux Image Model API"
    assert node["workflow_id"] == model.id
    assert node["workflow_provider"] == "runninghub"
    assert node["workflow_kind"] == "model"
    assert node["workflow_values"] == {"model::prompt": "a fox"}
    assert node["workflow_use_wallet"] is True
    assert node["runninghub_model_hint"] == "runninghub/flux-image"
    assert node["runninghub_source_kind"] == "model"


async def test_import_marks_unpacked_infinite_canvas_local_resource_missing(client) -> None:
    document = {
        "format": "infinite-canvas-workflow",
        "version": 1,
        "nodes": [
            {
                "id": "source-image",
                "type": "image",
                "x": 0,
                "y": 0,
                "url": "/assets/not-packed.png",
                "name": "not-packed.png",
            }
        ],
        "connections": [],
        "resources": [],
    }
    response = await client.post(
        "/studio/canvas-workflows/import",
        files={
            "file": (
                "source.json",
                json.dumps(document).encode(),
                "application/json",
            )
        },
    )
    assert response.status_code == 200, response.text
    result = response.json()
    assert len(result["missing"]) == 1
    assert result["missing"][0].startswith("legacy-url:")
    assert result["nodes"][0]["items"][0]["missing"] is True


async def test_import_preserves_infinite_canvas_modelscope_generator(client) -> None:
    document = {
        "format": "infinite-canvas-workflow",
        "version": 1,
        "nodes": [
            {
                "id": "msgen-1",
                "type": "msgen",
                "x": 120,
                "y": 80,
                "prompt": "ink illustration of a cat",
                "msgenModel": "custom",
                "msCustomModel": "org/private-image-model",
                "msRatio": "wide",
                "msResolution": "2k",
                "count": 8,
                "msLoraEnabled": True,
                "msLoraId": "org/ink-lora",
                "msLoraStrength": 0.65,
                "api_key": "must-not-import",
            }
        ],
        "connections": [],
        "resources": [],
    }
    response = await client.post(
        "/studio/canvas-workflows/import",
        files={
            "file": (
                "modelscope.json",
                json.dumps(document).encode(),
                "application/json",
            )
        },
    )
    assert response.status_code == 200, response.text
    node = response.json()["nodes"][0]
    assert node["type"] == "modelscope"
    assert node["prompt_draft"] == "ink illustration of a cat"
    assert node["ms_model_hint"] == "org/private-image-model"
    assert node["ms_size"] == "2048x1152"
    assert node["ms_count"] == 8
    assert node["ms_lora_enabled"] is True
    assert node["ms_lora_id"] == "org/ink-lora"
    assert node["ms_lora_strength"] == 0.65
    assert node["source_payload"]["api_key"] == "[REDACTED]"


async def test_import_preserves_infinite_canvas_video_generator_settings(client) -> None:
    document = {
        "format": "infinite-canvas-workflow",
        "version": 1,
        "nodes": [
            {
                "id": "video-1",
                "type": "video",
                "x": 80,
                "y": 120,
                "model": "doubao-seedance-2-0-fast-260128",
                "apiProvider": "volcengine",
                "duration": 15,
                "aspectRatio": "9:16",
                "resolution": "1080p",
                "generateAudio": True,
                "cameraFixed": False,
                "watermark": True,
                "seed": 17,
                "multimodal": True,
                "useFrameRoles": False,
                "enhancePrompt": True,
                "enableUpsample": True,
                "api_key": "must-not-import",
            }
        ],
        "connections": [],
        "resources": [],
    }
    response = await client.post(
        "/studio/canvas-workflows/import",
        files={
            "file": (
                "video.json",
                json.dumps(document).encode(),
                "application/json",
            )
        },
    )
    assert response.status_code == 200, response.text
    node = response.json()["nodes"][0]
    assert node["type"] == "video"
    assert node["video_settings"] == {
        "model_hint": "doubao-seedance-2-0-fast-260128",
        "provider_hint": "volcengine",
        "duration": 15,
        "aspect_ratio": "9:16",
        "resolution": "1080p",
        "generate_audio": True,
        "fixed_camera": False,
        "watermark": True,
        "seed": 17,
        "enhance_prompt": True,
        "enable_upsample": True,
        "reference_mode": "multimodal",
    }
    assert node["source_payload"]["api_key"] == "[REDACTED]"


async def test_import_preserves_infinite_canvas_llm_node_and_pane_heights(client) -> None:
    document = {
        "format": "infinite-canvas-workflow",
        "version": 1,
        "nodes": [
            {
                "id": "llm-1",
                "type": "llm",
                "x": 120,
                "y": 80,
                "title": "Video analyst",
                "mode": "node",
                "showSystem": True,
                "systemPrompt": "Describe movement in chronological order.",
                "userInput": "What happens in this video?",
                "outputText": "A person crosses the frame.",
                "messages": [{"role": "assistant", "content": "Prior answer"}],
                "temperature": 0.3,
                "llmInputHeight": 180,
                "llmOutputHeight": 240,
            }
        ],
        "connections": [],
        "resources": [],
    }
    response = await client.post(
        "/studio/canvas-workflows/import",
        files={
            "file": (
                "llm.json",
                json.dumps(document).encode(),
                "application/json",
            )
        },
    )

    assert response.status_code == 200, response.text
    node = response.json()["nodes"][0]
    assert node["type"] == "llm"
    assert node["llm_system_enabled"] is True
    assert node["llm_system_prompt"] == "Describe movement in chronological order."
    assert node["llm_input"] == "What happens in this video?"
    assert node["llm_output"] == "A person crosses the frame."
    assert node["llm_messages"] == [{"role": "assistant", "content": "Prior answer"}]
    assert node["llm_temperature"] == 0.3
    assert node["llm_input_height"] == 180
    assert node["llm_output_height"] == 240
