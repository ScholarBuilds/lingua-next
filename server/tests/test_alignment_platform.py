import pytest

from domain import alignment


def test_windows_alignment_reports_platform_limit_before_optional_import(monkeypatch):
    monkeypatch.setattr(alignment.sys, 'platform', 'win32')
    with pytest.raises(RuntimeError, match='Windows 暂不支持'):
        alignment.align_text('missing.wav', 'hello')
    with pytest.raises(RuntimeError, match='Windows 暂不支持'):
        alignment._get_aligner()
