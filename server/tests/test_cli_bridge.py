"""Local CLI adapters use fake executables only; no login or paid generation occurs."""

from __future__ import annotations

import base64
import stat
from pathlib import Path

import pytest

from domain import cli_bridge, imagegen
from domain.model_catalog import ResolvedModelRoute
from domain.models import ProviderCredential
from domain.video_generation import submit, wait_for_output

FAKE_CLI = r"""#!/usr/bin/env python3
import base64
import json
import re
import sys
import time
from pathlib import Path

PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="
)
args = sys.argv[1:]
if "--version" in args:
    print("fake-cli 1.4.2")
elif "--help" in args:
    print("fake CLI help")
elif args and args[0] == "user_credit":
    print(json.dumps({"total_credit": 88}))
elif args[:2] == ["login", "--headless"]:
    print("https://login.example/qr/test", flush=True)
    time.sleep(10)
elif args and args[0] == "logout":
    print("logged out")
elif args and args[0] == "query_result":
    output_arg = next(item for item in args if item.startswith("--download_dir="))
    output_dir = Path(output_arg.split("=", 1)[1])
    task_id = next(item.split("=", 1)[1] for item in args if item.startswith("--submit_id="))
    if task_id.startswith("video"):
        output = output_dir / "result.mp4"
        output.write_bytes(b"fake-mp4")
        print(json.dumps({"status": "success", "videos": [str(output)]}))
    else:
        output = output_dir / "result.png"
        output.write_bytes(PNG)
        print(json.dumps({"status": "success", "images": [str(output)]}))
elif args and args[0] in {"text2image", "image2image", "image_upscale"}:
    print(json.dumps({"submit_id": "image-task-1234", "status": "pending"}))
elif args and args[0] in {
    "text2video", "image2video", "frames2video",
    "multiframe2video", "multimodal2video",
}:
    print(json.dumps({"submit_id": "video-task-1234", "status": "pending"}))
elif "images" in args and "--out" in args:
    output = Path(args[args.index("--out") + 1])
    output.write_bytes(PNG)
    print(json.dumps({"path": str(output)}))
elif "exec" in args and "--output-last-message" in args:
    output = Path(args[args.index("--output-last-message") + 1])
    output.write_text("fake codex chat", encoding="utf-8")
    print("fake codex chat")
else:
    text = " ".join(args)
    match = re.search(r"(/[^\s]+output-\d+\.png)", text)
    if not match:
        print(json.dumps({"response": "fake gemini chat"}))
    else:
        output = Path(match.group(1).rstrip("。"))
        output.write_bytes(PNG)
        print(json.dumps({"path": str(output)}))
"""


def fake_cli(tmp_path: Path) -> str:
    path = tmp_path / "fake-cli"
    path.write_text(FAKE_CLI, encoding="utf-8")
    path.chmod(path.stat().st_mode | stat.S_IXUSR)
    return str(path)


def route(executable: str, **overrides) -> ResolvedModelRoute:
    values = {
        "deployment_id": 77,
        "adapter_type": "codex",
        "upstream_model_id": "gpt-image-2",
        "provider_type": "codex_cli",
        "credential_config": {"helper_executable": executable, "timeout": "20"},
        "protocol_options": {},
    }
    values.update(overrides)
    return ResolvedModelRoute(**values)


async def test_codex_and_gemini_cli_image_adapters(tmp_path) -> None:
    executable = fake_cli(tmp_path)
    codex = await cli_bridge.generate_images(
        "codex_cli",
        config={"helper_executable": executable, "timeout": "20"},
        prompt="a paper boat",
        model="gpt-image-2",
        size="1024x1024",
        n=1,
        references=[],
    )
    gemini = await cli_bridge.generate_images(
        "gemini_cli",
        config={"executable": executable, "timeout": "20"},
        prompt="a paper boat",
        model="auto",
        size="1024x1024",
        n=1,
        references=[],
    )
    assert len(codex.images) == len(gemini.images) == 1
    assert codex.images[0].startswith(b"\x89PNG")
    assert gemini.images[0].startswith(b"\x89PNG")


async def test_imagegen_routes_codex_cli_without_openai_client(tmp_path) -> None:
    executable = fake_cli(tmp_path)
    result = await imagegen._render_images_impl(
        "a lighthouse",
        capability="image-free",
        size="1024x1024",
        n=1,
        route=route(executable),
    )
    assert len(result.images) == 1
    assert result.model_reported == "gpt-image-2"


async def test_jimeng_image_and_resumable_video(session, tmp_path, monkeypatch) -> None:
    executable = fake_cli(tmp_path)
    config = {"executable": executable, "timeout": "20", "submit_poll_seconds": "1"}
    image = await cli_bridge.generate_images(
        "jimeng_cli",
        config=config,
        prompt="ink landscape",
        model="5.0",
        size="2048x2048",
        n=1,
        references=[],
    )
    assert image.images[0].startswith(b"\x89PNG")

    monkeypatch.setattr("domain.video_generation.POLL_INTERVAL_S", 0)
    handle = await submit(
        session,
        route=route(
            executable,
            adapter_type="jimeng",
            upstream_model_id="seedance2.0",
            provider_type="jimeng_cli",
            credential_config=config,
        ),
        prompt="slow camera move",
        duration=5,
        aspect_ratio="16:9",
        resolution="720p",
    )
    assert handle.protocol == "jimeng"
    assert handle.provider_task_id == "video-task-1234"
    output = await wait_for_output(handle)
    assert output.data == b"fake-mp4"
    assert output.mime == "video/mp4"


async def test_jimeng_native_upscale_and_multimodal_video_args(tmp_path) -> None:
    executable = fake_cli(tmp_path)
    config = {"executable": executable, "timeout": "20"}
    result = await cli_bridge.upscale_jimeng_image(
        config=config,
        image=(
            "source.png",
            base64.b64decode(
                "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="
            ),
        ),
        resolution_type="4k",
    )
    assert result.images[0].startswith(b"\x89PNG")
    provider_result = await imagegen.upscale_jimeng_image(
        (
            "source.png",
            base64.b64decode(
                "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="
            ),
        ),
        resolution_type="4k",
        route=route(
            executable,
            adapter_type="jimeng",
            upstream_model_id="jimeng-upscale",
            provider_type="jimeng_cli",
            credential_config=config,
        ),
    )
    assert provider_result.images[0].startswith(b"\x89PNG")

    image_path = tmp_path / "image.png"
    video_path = tmp_path / "video.mp4"
    audio_path = tmp_path / "audio.mp3"
    args = cli_bridge._jimeng_video_args(
        prompt="keep character and rhythm",
        model="seedance2.0",
        duration=5,
        aspect_ratio="16:9",
        resolution="720p",
        references=[(image_path, "reference_image")],
        media_references=[(video_path, "video"), (audio_path, "audio")],
        multimodal=True,
        poll_seconds=1,
    )
    assert args[0] == "multimodal2video"
    assert f"--image={image_path}" in args
    assert f"--video={video_path}" in args
    assert f"--audio={audio_path}" in args

    with pytest.raises(cli_bridge.CliBridgeError, match="音频不能单独"):
        cli_bridge._jimeng_video_args(
            prompt="audio only",
            model="seedance2.0",
            duration=5,
            aspect_ratio="16:9",
            resolution="720p",
            references=[],
            media_references=[(audio_path, "audio")],
            multimodal=True,
            poll_seconds=1,
        )


def test_jimeng_multiframe_uses_per_transition_arguments(tmp_path) -> None:
    references = [(tmp_path / f"frame-{index}.png", "reference_image") for index in range(4)]
    args = cli_bridge._jimeng_video_args(
        prompt="wide shot\nclose-up",
        model="seedance2.0",
        duration=18,
        aspect_ratio="16:9",
        resolution="1080p",
        references=references,
        media_references=[],
        multimodal=False,
        poll_seconds=1,
    )
    assert args[0] == "multiframe2video"
    assert "--video_resolution=1080p" in args
    assert [item for item in args if item.startswith("--transition-prompt=")] == [
        "--transition-prompt=wide shot",
        "--transition-prompt=close-up",
        "--transition-prompt=close-up",
    ]
    assert args.count("--transition-duration=6") == 3
    assert not any(item.startswith("--model_version=") for item in args)

    with pytest.raises(cli_bridge.CliBridgeError, match="最多支持 20 张"):
        cli_bridge._jimeng_video_args(
            prompt="transition",
            model="seedance2.0",
            duration=20,
            aspect_ratio="16:9",
            resolution="720p",
            references=references * 6,
            media_references=[],
            multimodal=False,
            poll_seconds=1,
        )


async def test_cli_status_and_static_models(tmp_path) -> None:
    executable = fake_cli(tmp_path)
    status = await cli_bridge.provider_status({"executable": executable}, "jimeng_cli")
    assert status["logged_in"] is True
    assert status["credit"] == {"total_credit": 88}
    models = cli_bridge.provider_models("jimeng_cli")
    assert {item["media_types"][0] for item in models} == {"image", "video"}


async def test_codex_and_gemini_chat_use_plain_text_cli(tmp_path) -> None:
    executable = fake_cli(tmp_path)
    messages = [
        {"role": "system", "content": "be concise"},
        {"role": "user", "content": "hello"},
    ]
    codex = await cli_bridge.generate_chat(
        "codex_cli",
        config={"executable": executable, "timeout": "20"},
        messages=messages,
        model="gpt-5.5",
    )
    gemini = await cli_bridge.generate_chat(
        "gemini_cli",
        config={"executable": executable, "timeout": "20"},
        messages=messages,
        model="auto",
    )
    assert codex.text == "fake codex chat"
    assert gemini.text == "fake gemini chat"


async def test_jimeng_login_status_help_and_logout(tmp_path) -> None:
    executable = fake_cli(tmp_path)
    config = {"executable": executable}
    help_text = await cli_bridge.provider_help(config, "jimeng_cli", "text2image")
    assert help_text == "fake CLI help"
    started = await cli_bridge.jimeng_login_start(config)
    assert started["running"] is True
    assert started["qr_url"] == "https://login.example/qr/test"
    logged_out = await cli_bridge.jimeng_logout(config)
    assert logged_out["logged_in"] is False


async def test_cli_management_routes_expose_status_and_allowlisted_help(
    client, session, tmp_path
) -> None:
    executable = fake_cli(tmp_path)
    credential = ProviderCredential(
        name="本机即梦",
        kind="image",
        provider_type="jimeng_cli",
        config={"executable": executable},
        enabled=True,
    )
    session.add(credential)
    await session.commit()
    await session.refresh(credential)

    status = await client.get(f"/config/credentials/{credential.id}/cli-status")
    assert status.status_code == 200
    assert status.json()["logged_in"] is True
    help_response = await client.post(
        f"/config/credentials/{credential.id}/cli-help",
        json={"command": "text2image"},
    )
    assert help_response.status_code == 200
    assert help_response.json() == {"text": "fake CLI help"}
    rejected = await client.post(
        f"/config/credentials/{credential.id}/cli-help",
        json={"command": "delete-everything"},
    )
    assert rejected.status_code == 400


async def test_run_cli_enforces_timeout(tmp_path) -> None:
    path = tmp_path / "slow-cli"
    path.write_text("#!/bin/sh\nsleep 10\n", encoding="utf-8")
    path.chmod(path.stat().st_mode | stat.S_IXUSR)
    with pytest.raises(cli_bridge.CliBridgeError, match="超过 1 秒"):
        await cli_bridge.run_cli(str(path), [], cwd=tmp_path, timeout=1)
