"""YouTube 内置登录域测试：Netscape 转换、域过滤、未登录导出报错、login_profile 现导回退。"""

from pathlib import Path

import pytest

import domain.video_source as video_source
import domain.youtube_login as youtube_login
from domain.video_source import build_ytdlp_opts
from domain.youtube_login import YoutubeLoginError, cookies_to_netscape, export_cookies


def _cookie(**overrides) -> dict:
    base = {
        "name": "SAPISID",
        "value": "abc123",
        "domain": ".youtube.com",
        "path": "/",
        "expires": 1893456000.5,
        "httpOnly": False,
        "secure": True,
    }
    return {**base, **overrides}


def test_netscape_header_and_field_order() -> None:
    text = cookies_to_netscape([_cookie()])
    lines = text.splitlines()
    assert lines[0] == "# Netscape HTTP Cookie File"  # yt-dlp 靠首行识别格式
    row = lines[-1].split("\t")
    assert row == [".youtube.com", "TRUE", "/", "TRUE", "1893456000", "SAPISID", "abc123"]
    assert text.endswith("\n")


def test_netscape_httponly_prefix() -> None:
    text = cookies_to_netscape([_cookie(name="LOGIN_INFO", httpOnly=True)])
    row = text.splitlines()[-1]
    assert row.startswith("#HttpOnly_.youtube.com\t")
    assert row.split("\t")[5] == "LOGIN_INFO"


def test_netscape_host_only_and_session_cookie() -> None:
    # 无前导点域 → include_subdomains=FALSE；会话 cookie（expires=-1）过期时间记 0
    text = cookies_to_netscape(
        [_cookie(domain="studio.youtube.com", expires=-1, secure=False)]
    )
    row = text.splitlines()[-1].split("\t")
    assert row[0:2] == ["studio.youtube.com", "FALSE"]
    assert row[3] == "FALSE"
    assert row[4] == "0"


def test_domain_relevant_filters_third_party() -> None:
    relevant = youtube_login._domain_relevant
    assert relevant(".youtube.com")
    assert relevant("accounts.google.com")
    assert relevant(".google.com")
    assert not relevant(".doubleclick.net")
    assert not relevant("evil-google.com")  # 后缀伪装域不放行


async def test_export_cookies_without_profile_raises(monkeypatch, tmp_path) -> None:
    monkeypatch.setattr(youtube_login, "PROFILE_DIR", tmp_path / "absent")
    with pytest.raises(YoutubeLoginError, match="尚未登录"):
        await export_cookies()


def test_profile_logged_in_false_without_profile(monkeypatch, tmp_path) -> None:
    monkeypatch.setattr(youtube_login, "PROFILE_DIR", tmp_path / "absent")
    assert youtube_login.profile_logged_in() is False


def test_build_opts_login_profile_uses_fresh_export(monkeypatch) -> None:
    fresh = "# Netscape HTTP Cookie File\nfresh-cookie-line\n"
    monkeypatch.setattr(youtube_login, "export_cookies_sync", lambda: fresh)
    opts, cookie_path = build_ytdlp_opts(
        {"login_profile": True, "cookies_text": "stale-line"}
    )
    try:
        assert cookie_path is not None
        assert "fresh-cookie-line" in Path(cookie_path).read_text(encoding="utf-8")
    finally:
        if cookie_path:
            Path(cookie_path).unlink(missing_ok=True)


def test_build_opts_login_profile_falls_back_to_stored(monkeypatch) -> None:
    def boom() -> str:
        raise YoutubeLoginError("profile 被占用")

    monkeypatch.setattr(youtube_login, "export_cookies_sync", boom)
    opts, cookie_path = build_ytdlp_opts(
        {"login_profile": True, "cookies_text": "stale-but-usable"}
    )
    try:
        assert cookie_path is not None
        assert "stale-but-usable" in Path(cookie_path).read_text(encoding="utf-8")
    finally:
        if cookie_path:
            Path(cookie_path).unlink(missing_ok=True)


def test_build_opts_without_flag_keeps_stored_cookies(monkeypatch) -> None:
    def fail() -> str:  # 无标记凭据绝不触发现导
        raise AssertionError("export_cookies_sync should not be called")

    monkeypatch.setattr(youtube_login, "export_cookies_sync", fail)
    opts, cookie_path = build_ytdlp_opts({"cookies_text": "manual-line"})
    try:
        assert cookie_path is not None
        assert "manual-line" in Path(cookie_path).read_text(encoding="utf-8")
    finally:
        if cookie_path:
            Path(cookie_path).unlink(missing_ok=True)


def test_fresh_profile_cookies_strips_whitespace(monkeypatch) -> None:
    monkeypatch.setattr(youtube_login, "export_cookies_sync", lambda: "  line1\n")
    assert video_source._fresh_profile_cookies({}) == "line1"
