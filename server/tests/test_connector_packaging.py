"""连接器打包脚本：产物结构、排除规则与幂等。

脚本不在 server 包里，按路径加载。跑测试时产物一律落 tmp_path，不碰 tools/dist。
"""

from __future__ import annotations

import importlib.util
import json
import sys
import zipfile
from pathlib import Path

import pytest

from domain.studio_shared_folders import PROJECT_ROOT

SCRIPT_PATH = PROJECT_ROOT / "tools" / "package_connectors.py"
TEXT_SUFFIXES = {".js", ".json", ".html", ".css", ".md", ".txt"}


def _load_script():
    spec = importlib.util.spec_from_file_location("package_connectors", SCRIPT_PATH)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    # dataclass 解析延迟注解要能从 sys.modules 找回自己，先登记再执行
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


packager = _load_script()


def test_zip_puts_manifest_at_root_and_keeps_junk_out(tmp_path) -> None:
    results = packager.run(tmp_path, {"chrome", "photoshop"})

    assert {item["key"] for item in results} == {"chrome", "photoshop"}
    for item in results:
        with zipfile.ZipFile(tmp_path / item["zip_name"]) as archive:
            names = archive.namelist()
        # Chrome 与 UXP 都要求 manifest.json 在包根，多套一层目录就装不上
        assert "manifest.json" in names
        assert not any(name.startswith("node_modules/") for name in names)
        assert not any("/node_modules/" in name for name in names)
        assert not any(name.endswith((".DS_Store", ".pem", ".pyc", ".log")) for name in names)
        assert not any(name.startswith("/") for name in names)


def test_artifacts_carry_no_local_absolute_paths(tmp_path) -> None:
    results = packager.run(tmp_path, {"chrome", "photoshop"})

    for item in results:
        with zipfile.ZipFile(tmp_path / item["zip_name"]) as archive:
            for name in archive.namelist():
                if Path(name).suffix.lower() not in TEXT_SUFFIXES:
                    continue
                text = archive.read(name).decode("utf-8", errors="ignore")
                for marker in packager.LOCAL_PATH_MARKERS:
                    assert marker not in text, f"{item['zip_name']}::{name} 里有 {marker}"
    # 可加载目录同样是给别人拷走的，一起查
    for item in results:
        stage = tmp_path / item["stage_dir"]
        for path in stage.rglob("*"):
            if not path.is_file() or path.suffix.lower() not in TEXT_SUFFIXES:
                continue
            text = path.read_text(encoding="utf-8", errors="ignore")
            for marker in packager.LOCAL_PATH_MARKERS:
                assert marker not in text, f"{path} 里有 {marker}"


def test_loadable_stage_directory_mirrors_the_zip(tmp_path) -> None:
    results = packager.run(tmp_path, {"chrome", "photoshop"})

    for item in results:
        stage = tmp_path / item["stage_dir"]
        assert (stage / "manifest.json").is_file()
        with zipfile.ZipFile(tmp_path / item["zip_name"]) as archive:
            names = sorted(archive.namelist())
        on_disk = sorted(
            path.relative_to(stage).as_posix() for path in stage.rglob("*") if path.is_file()
        )
        assert on_disk == names


def test_rerun_is_idempotent_down_to_the_bytes(tmp_path) -> None:
    first = packager.run(tmp_path, {"chrome", "photoshop"})
    payloads = {
        item["zip_name"]: (tmp_path / item["zip_name"]).read_bytes() for item in first
    }
    stamps = json.loads((tmp_path / "BUILD.json").read_text(encoding="utf-8"))["artifacts"]

    second = packager.run(tmp_path, {"chrome", "photoshop"})

    assert all(item["changed"] is False for item in second)
    for name, data in payloads.items():
        assert (tmp_path / name).read_bytes() == data
    again = json.loads((tmp_path / "BUILD.json").read_text(encoding="utf-8"))["artifacts"]
    # 内容没变就不该显示成刚打的包
    assert {k: v["built_at"] for k, v in again.items()} == {
        k: v["built_at"] for k, v in stamps.items()
    }


def test_dist_carries_its_own_gitignore(tmp_path) -> None:
    packager.run(tmp_path, {"chrome"})

    assert (tmp_path / ".gitignore").read_text(encoding="utf-8").startswith("*")


def test_excluded_directories_never_reach_the_file_list(tmp_path) -> None:
    source = tmp_path / "fake-connector"
    (source / "node_modules" / "left-pad").mkdir(parents=True)
    (source / "icons").mkdir()
    (source / "manifest.json").write_text('{"version": "9.9.9"}', encoding="utf-8")
    (source / "app.js").write_text("export const ok = 1\n", encoding="utf-8")
    (source / "icons" / ".DS_Store").write_bytes(b"junk")
    (source / "node_modules" / "left-pad" / "index.js").write_text("x", encoding="utf-8")
    (source / "key.pem").write_text("secret", encoding="utf-8")

    files = packager.collect_files(source)

    assert [item.as_posix() for item in files] == ["app.js", "manifest.json"]
    assert packager.read_version(source) == "9.9.9"


def test_packaging_aborts_when_source_hardcodes_a_local_path(tmp_path) -> None:
    source = tmp_path / "fake-connector"
    source.mkdir()
    (source / "manifest.json").write_text('{"version": "1.0.0"}', encoding="utf-8")
    (source / "app.js").write_text("const dir = '/Users/your-user/lingua'\n", encoding="utf-8")

    files = packager.collect_files(source)
    with pytest.raises(packager.PackagingError) as exc:
        packager.assert_no_local_paths(source, files)

    assert "app.js" in str(exc.value)


def test_missing_manifest_aborts_instead_of_shipping_a_broken_package(tmp_path) -> None:
    source = tmp_path / "fake-connector"
    source.mkdir()
    (source / "app.js").write_text("const ok = 1\n", encoding="utf-8")

    with pytest.raises(packager.PackagingError):
        packager.collect_files(source)


def test_zip_bytes_do_not_depend_on_file_mtimes(tmp_path) -> None:
    source = tmp_path / "fake-connector"
    source.mkdir()
    (source / "manifest.json").write_text('{"version": "1.0.0"}', encoding="utf-8")
    (source / "app.js").write_text("const ok = 1\n", encoding="utf-8")
    files = packager.collect_files(source)

    before = packager.build_zip_bytes(source, files)
    (source / "app.js").touch()
    after = packager.build_zip_bytes(source, files)

    assert before == after


def test_uxp_panel_version_constant_matches_its_manifest() -> None:
    """UXP 运行时读不到自己的 manifest，版本只能写死在 state.js，两边必须一致。"""
    panel = PROJECT_ROOT / "tools" / "photoshop-asset-connector"
    manifest_version = json.loads((panel / "manifest.json").read_text(encoding="utf-8"))["version"]
    declared = (panel / "js" / "state.js").read_text(encoding="utf-8")

    assert f"DX.VERSION = '{manifest_version}';" in declared
