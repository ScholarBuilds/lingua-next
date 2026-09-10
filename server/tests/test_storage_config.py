from pathlib import Path

import pytest

from app.config import get_settings


@pytest.mark.asyncio
async def test_storage_stats_include_optional_local_models(
    client, tmp_path: Path, monkeypatch
) -> None:
    media_root = tmp_path / "media"
    models_root = tmp_path / "models"
    (media_root / "tts").mkdir(parents=True)
    models_root.mkdir()
    (media_root / "tts" / "sample.pcm").write_bytes(b"a" * 16 * 1024)
    (models_root / "asr.bin").write_bytes(b"b" * 16 * 1024)

    settings = get_settings()
    monkeypatch.setattr(settings, "media_root", str(media_root))
    monkeypatch.setattr(settings, "local_models_root", str(models_root))

    response = await client.get("/config/storage-stats")

    assert response.status_code == 200
    assert response.json()["tts_cache_mb"] > 0
    assert response.json()["local_models_mb"] > 0


@pytest.mark.asyncio
async def test_clear_local_models_only_removes_model_files(
    client, tmp_path: Path, monkeypatch
) -> None:
    media_root = tmp_path / "media"
    models_root = tmp_path / "models"
    media_root.mkdir()
    (media_root / "keep.dat").write_bytes(b"keep")
    (models_root / "provider").mkdir(parents=True)
    (models_root / "provider" / "model.bin").write_bytes(b"model")

    settings = get_settings()
    monkeypatch.setattr(settings, "media_root", str(media_root))
    monkeypatch.setattr(settings, "local_models_root", str(models_root))

    response = await client.post("/config/clear-local-models")

    assert response.status_code == 200
    assert response.json()["files"] == 1
    assert not (models_root / "provider" / "model.bin").exists()
    assert (media_root / "keep.dat").read_bytes() == b"keep"
