"""MiniMax H3 分镜导出：只使用本机媒体资产，ffmpeg 全部打桩。"""

from __future__ import annotations

import subprocess
from pathlib import Path

from domain import storage as storage_mod
from domain import studio_minimax
from domain.storage import LocalStorage
from domain.studio_media_assets import ingest_one


async def test_minimax_timeline_export_trims_concats_and_ingests(
    client,
    session,
    tmp_path,
    monkeypatch,
) -> None:
    storage_mod.set_storage(LocalStorage(tmp_path))
    commands: list[list[str]] = []

    async def fake_run(command: list[str], timeout: int):
        commands.append(command)
        if Path(command[0]).name == "ffprobe":
            return subprocess.CompletedProcess(command, 0, stdout="0\n", stderr="")
        output = Path(command[-1])
        output.write_bytes(f"generated-{len(commands)}".encode())
        return subprocess.CompletedProcess(command, 0, stdout="", stderr="")

    monkeypatch.setattr(studio_minimax.shutil, "which", lambda name: f"/usr/bin/{name}")
    monkeypatch.setattr(studio_minimax, "_run_async", fake_run)
    try:
        first = await ingest_one(
            session,
            b"first-source-video",
            kind="video",
            name="first.mp4",
            mime="video/mp4",
        )
        second = await ingest_one(
            session,
            b"second-source-video",
            kind="video",
            name="second.mp4",
            mime="video/mp4",
        )
        await session.commit()

        response = await client.post(
            "/studio/minimax/timeline-export",
            json={
                "filename": "director-cut",
                "clips": [
                    {
                        "media_asset_id": first.id,
                        "start": 0.25,
                        "end": 1.25,
                        "duration": 2,
                    },
                    {
                        "media_asset_id": second.id,
                        "start": 0,
                        "end": 1.5,
                        "duration": 2,
                    },
                ],
            },
        )

        assert response.status_code == 200, response.text
        result = response.json()
        assert result["kind"] == "video"
        assert result["name"] == "director-cut.mp4"
        assert result["duration_ms"] == 2500
        assert result["details"]["operation"] == "minimax-timeline-export"
        probes = [command for command in commands if Path(command[0]).name == "ffprobe"]
        ffmpeg = [command for command in commands if Path(command[0]).name == "ffmpeg"]
        assert len(probes) == 2
        assert len(ffmpeg) == 3
        assert ffmpeg[0][ffmpeg[0].index("-ss") + 1] == "0.250"
        assert ffmpeg[0][ffmpeg[0].index("-t") + 1] == "1.000"
        assert "concat" in ffmpeg[-1]
        content = await client.get(result["url"].removeprefix("/api"))
        assert content.status_code == 200
        assert content.content.startswith(b"generated-")
    finally:
        storage_mod.set_storage(None)


async def test_minimax_timeline_export_reports_missing_ffmpeg(
    client,
    monkeypatch,
) -> None:
    monkeypatch.setattr(studio_minimax.shutil, "which", lambda name: None)
    response = await client.post(
        "/studio/minimax/timeline-export",
        json={
            "clips": [
                {
                    "media_asset_id": 1,
                    "start": 0,
                    "end": 1,
                    "duration": 1,
                }
            ]
        },
    )
    assert response.status_code == 503
    assert "ffmpeg" in response.json()["detail"]
