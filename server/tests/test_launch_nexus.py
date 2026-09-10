from __future__ import annotations

import argparse
import importlib.util
from pathlib import Path
from types import ModuleType, SimpleNamespace

import pytest

PROJECT_ROOT = Path(__file__).resolve().parents[2]


def load_launcher() -> ModuleType:
    path = PROJECT_ROOT / "tools" / "launch_nexus.py"
    spec = importlib.util.spec_from_file_location("launch_nexus", path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_source_desktop_is_default(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    launcher = load_launcher()
    electron = tmp_path / "electron"
    electron.touch()
    calls: list[tuple[str, object]] = []

    monkeypatch.setattr(launcher, "electron_bin", lambda: electron)
    monkeypatch.setattr(launcher, "desktop_build_required", lambda: True)
    monkeypatch.setattr(
        launcher,
        "start_installed_desktop",
        lambda: pytest.fail("default launch must not open the installed app"),
    )
    monkeypatch.setattr(
        launcher.subprocess,
        "run",
        lambda *args, **kwargs: SimpleNamespace(returncode=0),
    )
    monkeypatch.setattr(
        launcher,
        "spawn",
        lambda name, command, cwd, env=None: calls.append((name, command)) or 42,
    )
    monkeypatch.setattr(
        launcher,
        "require_process_running",
        lambda name, pid, delay=0.0: calls.append(("health", (name, pid, delay))),
    )

    launcher.start_desktop()

    assert calls == [
        ("desktop", [str(electron), "."]),
        ("health", ("desktop", 42, 1.5)),
    ]


def test_source_desktop_reuses_current_build(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    launcher = load_launcher()
    electron = tmp_path / "electron"
    electron.touch()

    monkeypatch.setattr(launcher, "electron_bin", lambda: electron)
    monkeypatch.setattr(launcher, "desktop_build_required", lambda: False)
    monkeypatch.setattr(
        launcher.subprocess,
        "run",
        lambda *args, **kwargs: pytest.fail("current desktop build must not run tsc"),
    )
    monkeypatch.setattr(launcher, "spawn", lambda *args, **kwargs: 42)
    monkeypatch.setattr(launcher, "require_process_running", lambda *args, **kwargs: None)

    launcher.start_desktop()


def test_desktop_build_freshness_tracks_sources_and_deleted_outputs(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    launcher = load_launcher()
    source_dir = tmp_path / "src"
    output_dir = tmp_path / "dist"
    source_dir.mkdir()
    output_dir.mkdir()
    (tmp_path / "package.json").write_text("{}")
    (tmp_path / "tsconfig.json").write_text("{}")
    source = source_dir / "main.ts"
    output = output_dir / "main.js"
    source.write_text("export {}")
    output.write_text('"use strict"')
    output.touch()
    monkeypatch.setattr(launcher, "DESKTOP_DIR", tmp_path)

    assert launcher.desktop_build_required() is False

    source.touch()
    assert launcher.desktop_build_required() is True

    output.touch()
    (output_dir / "removed.js").write_text('"use strict"')
    assert launcher.desktop_build_required() is True


def test_installed_desktop_requires_explicit_mode(monkeypatch: pytest.MonkeyPatch) -> None:
    launcher = load_launcher()
    calls: list[str] = []
    monkeypatch.setattr(launcher, "start_installed_desktop", lambda: calls.append("installed"))

    launcher.start_desktop(use_installed=True)

    assert calls == ["installed"]


def test_services_fail_when_worker_exits(monkeypatch: pytest.MonkeyPatch) -> None:
    launcher = load_launcher()
    pids = {"api": 11, "worker": 12, "web": 13}

    monkeypatch.setattr(launcher.shutil, "which", lambda _name: "/usr/local/bin/pnpm")
    monkeypatch.setattr(launcher, "spawn", lambda name, *args, **kwargs: pids[name])
    monkeypatch.setattr(launcher, "wait_http", lambda *_args, **_kwargs: True)

    def require(name: str, _pid: int, delay: float = 0.0) -> None:
        if name == "worker":
            raise RuntimeError("worker 启动后立即退出")

    monkeypatch.setattr(launcher, "require_process_running", require)

    with pytest.raises(RuntimeError, match="worker 启动后立即退出"):
        launcher.start_services(timeout=1, desktop=False)


def test_desktop_services_use_in_process_queue(monkeypatch: pytest.MonkeyPatch) -> None:
    launcher = load_launcher()
    spawned: list[str] = []

    monkeypatch.setattr(launcher.shutil, "which", lambda _name: "/usr/local/bin/pnpm")
    monkeypatch.setattr(
        launcher,
        "spawn",
        lambda name, *args, **kwargs: spawned.append(name) or len(spawned) + 10,
    )
    monkeypatch.setattr(launcher, "wait_http", lambda *_args, **_kwargs: True)
    monkeypatch.setattr(launcher, "require_process_running", lambda *_args, **_kwargs: None)

    launcher.start_services(timeout=1, desktop=True)

    assert spawned == ["api", "web"]


def test_desktop_api_env_uses_sqlite_and_file_vault(monkeypatch: pytest.MonkeyPatch) -> None:
    launcher = load_launcher()
    monkeypatch.setattr(launcher, "DESKTOP_DATA_DIR", Path("/tmp/nexus-desktop"))
    monkeypatch.setattr(launcher, "DESKTOP_DATABASE", Path("/tmp/nexus-desktop/nexus.sqlite3"))
    monkeypatch.setattr(launcher, "DESKTOP_QUEUE", Path("/tmp/nexus-desktop/queue.sqlite3"))
    monkeypatch.setattr(launcher, "DESKTOP_MEDIA", Path("/tmp/nexus-desktop/media"))
    monkeypatch.setattr(launcher, "DESKTOP_MODELS", Path("/tmp/nexus-desktop/models"))
    monkeypatch.setattr(launcher, "DESKTOP_GRAMMAR", Path("/tmp/nexus-desktop/grammar"))
    monkeypatch.setattr(launcher, "DESKTOP_BACKUPS", Path("/tmp/nexus-desktop/backups"))

    env = launcher.desktop_api_env()

    assert env["LINGUA_RUNTIME_PROFILE"] == "desktop"
    assert env["LINGUA_DATABASE_URL"] == "sqlite+aiosqlite:////tmp/nexus-desktop/nexus.sqlite3"
    assert env["LINGUA_VAULT_KEY_BACKEND"] == "file"
    assert env["LINGUA_GRAMMAR_DOCS_ROOT"] == "/tmp/nexus-desktop/grammar"


def test_failed_desktop_start_cleans_up_started_processes(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    launcher = load_launcher()
    cleanup_calls: list[str] = []
    args = argparse.Namespace(
        timeout=1,
        no_open=True,
        browser=False,
        installed=False,
    )

    monkeypatch.setattr(launcher, "ensure_deps", lambda: None)
    monkeypatch.setattr(launcher, "stop_all", lambda: cleanup_calls.append("stop"))
    monkeypatch.setattr(launcher, "ensure_desktop_database", lambda: None)
    monkeypatch.setattr(
        launcher,
        "start_services",
        lambda _timeout, desktop: (_ for _ in ()).throw(RuntimeError("web failed")),
    )

    with pytest.raises(RuntimeError, match="web failed"):
        launcher.start_desktop_profile(args)

    assert cleanup_calls == ["stop", "stop"]


def test_english_entrypoints_reference_launcher() -> None:
    entrypoints = (
        PROJECT_ROOT / "Start NEXUS.command",
        PROJECT_ROOT / "start-nexus.sh",
        PROJECT_ROOT / "start-nexus.bat",
    )

    for path in entrypoints:
        assert path.is_file()
        assert "launch_nexus.py" in path.read_text()


def test_launcher_has_no_retired_runtime_prerequisites() -> None:
    source = (PROJECT_ROOT / "tools" / "launch_nexus.py").read_text()

    for command in ("interpreter", "agent-browser", "cua-driver"):
        assert command not in source
