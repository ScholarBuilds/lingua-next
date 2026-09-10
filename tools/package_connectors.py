#!/usr/bin/env python3
"""把两个连接器打成可分发、可加载的产物。

产物路径固定在 ``tools/dist/``：

- ``lingua-chrome-collector/``      Chrome「加载已解压的扩展程序」直接选这个目录
- ``lingua-chrome-collector.zip``   拷给别人 / 上传 Web Store 的包，manifest.json 在根
- ``lingua-photoshop-connector/``   UXP Developer Tool ``Add Plugin`` 选里面的 manifest.json
- ``lingua-photoshop-connector.zip`` 拷给别人用的包
- ``BUILD.json``                    产物台账（版本、sha256、构建时间）
- ``README.md``                     分发与安装说明

幂等：内容没变就不重写文件，zip 里的时间戳固定在 1980-01-01，同样的源码跑多少次
产出的字节都一样。构建前会拒收 node_modules 之类的目录，并扫一遍文本文件，
发现本机绝对路径就中止——打进包里会泄露路径且换机器必坏。

.crx 和 .ccx 不在这里生成，原因见 README：两者都要签名密钥，见产物 README.md。
"""

from __future__ import annotations

import argparse
import hashlib
import io
import json
import shutil
import sys
import zipfile
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path

TOOLS_DIR = Path(__file__).resolve().parent
DIST_DIR = TOOLS_DIR / "dist"
BUILD_RECORD = "BUILD.json"

# 打包时一律剔除的目录与文件：依赖树、版本控制、编辑器与系统垃圾、密钥和既有产物
EXCLUDED_DIRS = frozenset(
    {
        "node_modules",
        ".git",
        ".svn",
        ".idea",
        ".vscode",
        "__pycache__",
        "dist",
        "build",
        ".cache",
    }
)
EXCLUDED_NAMES = frozenset({".DS_Store", "Thumbs.db", ".env", ".env.local"})
EXCLUDED_SUFFIXES = frozenset({".pyc", ".log", ".pem", ".crx", ".ccx", ".zip", ".map"})

# 会被扫本机绝对路径的文本类型
TEXT_SUFFIXES = frozenset({".js", ".json", ".html", ".css", ".md", ".txt", ".svg", ".mjs"})

# 出现即判定为把本机路径写死进了源码
LOCAL_PATH_MARKERS = ("/Users/", "/home/", "/root/", "C:\\Users\\", "C:/Users/")

# zip 内固定时间戳：DOS 时间的最小合法值，保证同源同字节
FIXED_TIMESTAMP = (1980, 1, 1, 0, 0, 0)


@dataclass(frozen=True)
class Connector:
    key: str
    source_name: str
    stage_name: str
    label: str
    host: str


CONNECTORS: tuple[Connector, ...] = (
    Connector(
        key="chrome",
        source_name="chrome-local-asset-importer",
        stage_name="lingua-chrome-collector",
        label="浏览器素材采集扩展",
        host="Chrome / Edge",
    ),
    Connector(
        key="photoshop",
        source_name="photoshop-asset-connector",
        stage_name="lingua-photoshop-connector",
        label="Photoshop 画布面板",
        host="Adobe Photoshop 24+ / UXP",
    ),
)


class PackagingError(RuntimeError):
    """源码不满足打包前置条件，直接中止，不产出半成品。"""


def _skip(path: Path) -> bool:
    if path.name in EXCLUDED_NAMES:
        return True
    if path.suffix.lower() in EXCLUDED_SUFFIXES:
        return True
    return any(part in EXCLUDED_DIRS for part in path.parts)


def collect_files(source: Path) -> list[Path]:
    """源目录里要进包的相对路径，按字典序排定，保证跨机器顺序一致。"""
    if not source.is_dir():
        raise PackagingError(f"源目录不存在：{source}")
    files = [
        item.relative_to(source)
        for item in source.rglob("*")
        if item.is_file() and not _skip(item.relative_to(source))
    ]
    if not files:
        raise PackagingError(f"源目录里没有可打包的文件：{source}")
    manifest = Path("manifest.json")
    if manifest not in files:
        raise PackagingError(f"缺少 manifest.json：{source}")
    return sorted(files, key=lambda item: item.as_posix())


def assert_no_local_paths(source: Path, files: list[Path]) -> None:
    """文本文件里不许出现本机绝对路径。"""
    offenders: list[str] = []
    for rel in files:
        if rel.suffix.lower() not in TEXT_SUFFIXES:
            continue
        text = (source / rel).read_text(encoding="utf-8", errors="ignore")
        hits = [marker for marker in LOCAL_PATH_MARKERS if marker in text]
        if hits:
            offenders.append(f"{rel.as_posix()} 命中 {', '.join(hits)}")
    if offenders:
        detail = "\n  ".join(offenders)
        raise PackagingError(f"源码里写死了本机绝对路径，先改掉再打包：\n  {detail}")


def read_version(source: Path) -> str:
    payload = json.loads((source / "manifest.json").read_text(encoding="utf-8"))
    version = str(payload.get("version") or "").strip()
    if not version:
        raise PackagingError(f"manifest.json 没有 version：{source}")
    return version


def write_if_changed(path: Path, data: bytes) -> bool:
    """内容一致就不落盘，mtime 不动——重复跑脚本不该让产物看起来是新的。"""
    if path.is_file() and path.read_bytes() == data:
        return False
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    return True


def sync_stage(source: Path, stage: Path, files: list[Path]) -> int:
    """把源目录同步成一份干净的可加载目录，并清掉上一轮残留的多余文件。"""
    changed = 0
    wanted = {rel.as_posix() for rel in files}
    for rel in files:
        if write_if_changed(stage / rel, (source / rel).read_bytes()):
            changed += 1
    if stage.is_dir():
        for item in sorted(stage.rglob("*"), key=lambda p: len(p.parts), reverse=True):
            if item.is_file() and item.relative_to(stage).as_posix() not in wanted:
                item.unlink()
                changed += 1
            elif item.is_dir() and not any(item.iterdir()):
                item.rmdir()
    return changed


def build_zip_bytes(source: Path, files: list[Path]) -> bytes:
    """manifest.json 落在包根，时间戳固定，同源必然同字节。"""
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for rel in files:
            info = zipfile.ZipInfo(rel.as_posix(), date_time=FIXED_TIMESTAMP)
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o644 << 16
            archive.writestr(info, (source / rel).read_bytes())
    return buffer.getvalue()


DIST_README = """# 连接器分发产物

`python3 tools/package_connectors.py` 生成，目录固定，可重复覆盖。

## Chrome 采集扩展

装到自己机器上（不需要先打包）：

1. 地址栏打开 `chrome://extensions`
2. 打开右上角「开发者模式」
3. 点「加载已解压的扩展程序」，选 `lingua-chrome-collector/`

发给别人：把 `lingua-chrome-collector.zip` 发过去，对方解压后照上面三步加载。

想要 `.crx`：Chrome 未上架 Web Store 的扩展没有免开发者模式的装法。
`.crx` 需要一对签名密钥，在 `chrome://extensions` 点「打包扩展程序」，
扩展根目录填 `lingua-chrome-collector/`，首次留空私钥会生成 `.pem`，
之后每次升级都要带上同一个 `.pem`，否则扩展 ID 会变。命令行等价写法：

    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \\
      --pack-extension=<绝对路径>/lingua-chrome-collector \\
      --pack-extension-key=<绝对路径>/lingua-chrome-collector.pem

`.pem` 是私钥，不要提交进仓库。生成的 `.crx` 从本地拖进 `chrome://extensions`
仍会被 Chrome 拦（非 Web Store 来源），所以日常还是用「加载已解压的扩展程序」。

## Photoshop UXP 面板

装到自己机器上：

1. 安装 Adobe UXP Developer Tool，打开 Photoshop 24.0 或更高版本
2. UDT 点 `Add Plugin`，选 `lingua-photoshop-connector/manifest.json`
3. 点 `Load`，从 Photoshop「增效工具」菜单打开「Lingua 画布工具」

发给别人：把 `lingua-photoshop-connector.zip` 发过去，对方解压后照上面三步加载。

想要 `.ccx`：Creative Cloud 能双击安装的 `.ccx` 必须由 UXP Developer Tool 的
`Package` 动作签名产出（选中插件 → `⋯` → `Package`），签名密钥在本机 UDT 里，
脚本拿不到，所以这里不生成同名的未签名压缩包——那种包 Creative Cloud 一律拒装，
放出来只会骗人。要免 UDT 分发只能走 Adobe Exchange 上架。
"""


def package(connector: Connector, dist: Path) -> dict:
    source = TOOLS_DIR / connector.source_name
    files = collect_files(source)
    assert_no_local_paths(source, files)
    version = read_version(source)
    stage = dist / connector.stage_name
    stage_changes = sync_stage(source, stage, files)
    zip_name = f"{connector.stage_name}.zip"
    payload = build_zip_bytes(source, files)
    zip_changed = write_if_changed(dist / zip_name, payload)
    return {
        "key": connector.key,
        "label": connector.label,
        "host": connector.host,
        "version": version,
        "files": len(files),
        "stage_dir": stage.name,
        "zip_name": zip_name,
        "sha256": hashlib.sha256(payload).hexdigest(),
        "bytes": len(payload),
        "changed": stage_changes > 0 or zip_changed,
    }


def load_record(dist: Path) -> dict:
    try:
        payload = json.loads((dist / BUILD_RECORD).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    artifacts = payload.get("artifacts")
    return artifacts if isinstance(artifacts, dict) else {}


def write_record(dist: Path, results: list[dict]) -> None:
    """台账里保留上一次的 built_at：内容没变就不该显示成刚打的包。"""
    previous = load_record(dist)
    now = datetime.now(UTC).isoformat()
    artifacts = {}
    for item in results:
        old = previous.get(item["zip_name"])
        built_at = now
        if isinstance(old, dict) and old.get("sha256") == item["sha256"]:
            built_at = str(old.get("built_at") or now)
        artifacts[item["zip_name"]] = {
            "connector": item["key"],
            "version": item["version"],
            "sha256": item["sha256"],
            "bytes": item["bytes"],
            "files": item["files"],
            "stage_dir": item["stage_dir"],
            "built_at": built_at,
        }
    body = json.dumps({"artifacts": artifacts}, ensure_ascii=False, indent=2, sort_keys=True)
    write_if_changed(dist / BUILD_RECORD, body.encode("utf-8") + b"\n")


# 产物是可再生的二进制，不进版本库。写在 dist 自己身上，免得动仓库根 .gitignore
DIST_GITIGNORE = "*\n!.gitignore\n"


def run(dist: Path, keys: set[str]) -> list[dict]:
    dist.mkdir(parents=True, exist_ok=True)
    results = [package(item, dist) for item in CONNECTORS if item.key in keys]
    write_record(dist, results)
    write_if_changed(dist / "README.md", DIST_README.encode("utf-8"))
    write_if_changed(dist / ".gitignore", DIST_GITIGNORE.encode("utf-8"))
    return results


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="打包 Chrome 扩展与 Photoshop UXP 面板")
    parser.add_argument(
        "--only",
        choices=[item.key for item in CONNECTORS],
        action="append",
        help="只打其中一个，可重复",
    )
    parser.add_argument("--out", default=str(DIST_DIR), help="产物目录，默认 tools/dist")
    parser.add_argument("--clean", action="store_true", help="先清空产物目录再打")
    args = parser.parse_args(argv)

    dist = Path(args.out).expanduser().resolve()
    if args.clean and dist.is_dir():
        shutil.rmtree(dist)
    keys = set(args.only or [item.key for item in CONNECTORS])
    try:
        results = run(dist, keys)
    except PackagingError as exc:
        print(f"打包中止：{exc}", file=sys.stderr)
        return 1

    print(f"产物目录 {dist}")
    for item in results:
        mark = "更新" if item["changed"] else "无变化"
        print(
            f"  {item['label']} v{item['version']}  {item['files']} 个文件  "
            f"{item['bytes'] / 1024:.0f} KB  [{mark}]"
        )
        print(f"    可加载目录 {dist / item['stage_dir']}")
        print(f"    分发压缩包 {dist / item['zip_name']}")
    print("  .crx / .ccx 的签名分发说明见 " + str(dist / "README.md"))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
