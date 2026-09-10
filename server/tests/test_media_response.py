"""媒体出口的 X-Accel 分支（FR-389）。

三处最容易出错的地方：开关是否真的切换了行为、内部 URI 有没有正确 percent-encode
（nginx 收到后会 unescape 一次，漏编码会指错文件）、不在媒体卷里的文件有没有回落。
"""

from pathlib import Path

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.testclient import TestClient
from starlette.background import BackgroundTask

from app.config import get_settings
from app.media import file_response, media_response
from domain.storage import LocalStorage, set_storage


@pytest.fixture
def media(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    """把媒体根指到临时目录，并让 storage 单例跟着换。"""
    root = tmp_path / "media"
    root.mkdir()
    (root / "videos").mkdir()
    (root / "videos" / "5.mp4").write_bytes(b"fake-video")

    settings = get_settings()
    monkeypatch.setattr(settings, "media_root", str(root), raising=False)
    set_storage(LocalStorage(root))
    yield root
    set_storage(None)


def _set_prefix(monkeypatch: pytest.MonkeyPatch, value: str) -> None:
    monkeypatch.setattr(get_settings(), "xaccel_prefix", value, raising=False)


# ────────────────────────────── 开关 ──────────────────────────────


def test_without_prefix_app_sends_the_file(media: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """留空前缀（本机开发默认）：应用自己发，正文可读，无 X-Accel 头。"""
    _set_prefix(monkeypatch, "")
    resp = media_response("videos/5.mp4", media_type="video/mp4")
    assert isinstance(resp, FileResponse)
    assert "X-Accel-Redirect" not in resp.headers


def test_with_prefix_delegates_to_nginx(media: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """配了前缀：空壳响应 + 指路头，正文交给 nginx。"""
    _set_prefix(monkeypatch, "/__media/")
    resp = media_response("videos/5.mp4", media_type="video/mp4")
    assert not isinstance(resp, FileResponse)
    assert resp.headers["X-Accel-Redirect"] == "/__media/videos/5.mp4"
    assert resp.headers["content-type"] == "video/mp4"
    assert resp.body == b""


def test_prefix_without_trailing_slash_still_works(
    media: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """配置里漏了尾斜杠不该拼出 /__mediavideos/5.mp4。"""
    _set_prefix(monkeypatch, "/__media")
    resp = media_response("videos/5.mp4")
    assert resp.headers["X-Accel-Redirect"] == "/__media/videos/5.mp4"


# ────────────────────────────── 路径编码 ──────────────────────────────


@pytest.mark.parametrize(
    ("name", "encoded"),
    [
        ("中文名.mp4", "%E4%B8%AD%E6%96%87%E5%90%8D.mp4"),
        ("a b.mp4", "a%20b.mp4"),
        ("100%.mp4", "100%25.mp4"),
        ("q?x.mp4", "q%3Fx.mp4"),
        ("a#b.mp4", "a%23b.mp4"),
    ],
)
def test_internal_uri_is_percent_encoded(
    media: Path, monkeypatch: pytest.MonkeyPatch, name: str, encoded: str
) -> None:
    """nginx 会对内部 URI 做一次 unescape，这里不编码就会截断或指错文件。"""
    _set_prefix(monkeypatch, "/__media/")
    (media / "videos" / name).write_bytes(b"x")
    resp = media_response(f"videos/{name}")
    assert resp.headers["X-Accel-Redirect"] == f"/__media/videos/{encoded}"


# ────────────────────────────── 回落 ──────────────────────────────


def test_file_outside_media_root_falls_back(
    media: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """preview_cache、临时导出这类不在 nginx 挂载卷里的文件必须应用自己发。"""
    _set_prefix(monkeypatch, "/__media/")
    outside = tmp_path / "preview_cache"
    outside.mkdir()
    clip = outside / "clip.mp4"
    clip.write_bytes(b"clip")

    resp = file_response(clip, media_type="video/mp4")
    assert isinstance(resp, FileResponse)
    assert "X-Accel-Redirect" not in resp.headers


def test_background_task_forces_app_to_send(
    media: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """带清理任务的（导出 apkg 用完即删）不能交给 nginx——它还没读完文件就被删了。"""
    _set_prefix(monkeypatch, "/__media/")
    path = media / "videos" / "5.mp4"
    resp = file_response(path, background=BackgroundTask(lambda: None))
    assert isinstance(resp, FileResponse)
    assert "X-Accel-Redirect" not in resp.headers


def test_missing_file_is_404(media: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    _set_prefix(monkeypatch, "/__media/")
    with pytest.raises(HTTPException) as exc:
        media_response("videos/nope.mp4")
    assert exc.value.status_code == 404


def test_bad_key_is_400(media: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """key 来自数据库列，脏值要被挡成 400 而不是穿透成任意文件读取。"""
    _set_prefix(monkeypatch, "/__media/")
    with pytest.raises(HTTPException) as exc:
        media_response("../../etc/passwd")
    assert exc.value.status_code == 400


# ────────────────────────────── 端到端 ──────────────────────────────


def test_range_still_works_when_app_sends(media: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """关掉 X-Accel 时 Range 由 starlette 负责，206 与 Content-Range 必须正确。"""
    _set_prefix(monkeypatch, "")
    app = FastAPI()

    @app.get("/v")
    def _v():  # noqa: ANN202
        return media_response("videos/5.mp4", media_type="video/mp4")

    client = TestClient(app)
    resp = client.get("/v", headers={"Range": "bytes=2-5"})
    assert resp.status_code == 206
    assert resp.headers["content-range"] == "bytes 2-5/10"
    assert resp.content == b"ke-v"


def test_headers_pass_through(media: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """业务自定义头（X-TTS-Provider 等）在两种模式下都要留住。"""
    for prefix in ("", "/__media/"):
        _set_prefix(monkeypatch, prefix)
        resp = media_response("videos/5.mp4", headers={"X-Probe": "yes"})
        assert resp.headers["X-Probe"] == "yes"
