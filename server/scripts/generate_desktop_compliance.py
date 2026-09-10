from __future__ import annotations

import argparse
import json
import subprocess
from importlib import metadata
from pathlib import Path
from urllib.parse import quote

from packaging.utils import canonicalize_name


def _python_components(server_root: Path) -> list[dict]:
    exported = subprocess.run(
        ["uv", "export", "--format", "requirements-txt", "--no-dev", "--no-hashes"],
        cwd=server_root,
        check=True,
        capture_output=True,
        text=True,
    ).stdout
    names = {
        canonicalize_name(line.split("==", 1)[0].split("[", 1)[0])
        for line in exported.splitlines()
        if line and not line.startswith(("#", "-e ", "--")) and "==" in line
    }
    components: list[dict] = []
    for distribution in metadata.distributions():
        name = str(distribution.metadata.get("Name") or "")
        if not name or canonicalize_name(name) not in names:
            continue
        license_name = str(
            distribution.metadata.get("License-Expression")
            or distribution.metadata.get("License")
            or "UNKNOWN"
        ).strip()
        components.append(
            {
                "type": "library",
                "group": "pypi",
                "name": name,
                "version": distribution.version,
                "purl": f"pkg:pypi/{quote(canonicalize_name(name))}@{quote(distribution.version)}",
                "licenses": [{"license": {"name": license_name[:500] or "UNKNOWN"}}],
            }
        )
    return components


def _node_components(root: Path, scope: str) -> list[dict]:
    raw = subprocess.run(
        ["pnpm", "licenses", "list", "--prod", "--json"],
        cwd=root,
        check=True,
        capture_output=True,
        text=True,
    ).stdout
    licenses = json.loads(raw)
    components: list[dict] = []
    for license_name, packages in licenses.items():
        for package in packages:
            name = str(package["name"])
            for version in package.get("versions") or []:
                components.append(
                    {
                        "type": "library",
                        "group": f"npm-{scope}",
                        "name": name,
                        "version": str(version),
                        "purl": f"pkg:npm/{quote(name, safe='@/')}@{quote(str(version))}",
                        "licenses": [{"license": {"name": str(license_name)}}],
                    }
                )
    return components


def _binary_components(entries: list[list[str]]) -> list[dict]:
    """随包的独立二进制（ffmpeg / deno）不在任何包管理器的清单里，按名字 / 版本 / 许可显式登记。"""
    return [
        {
            "type": "application",
            "group": "binary",
            "name": name,
            "version": version,
            "licenses": [{"license": {"name": license_name}}],
        }
        for name, version, license_name in entries
    ]


def generate(
    output: Path,
    server_root: Path,
    desktop_root: Path,
    web_root: Path,
    binaries: list[list[str]] | None = None,
) -> None:
    components = [
        *_python_components(server_root),
        *_node_components(desktop_root, "desktop"),
        *_node_components(web_root, "web"),
        *_binary_components(binaries or []),
    ]
    unique = {
        (item.get("purl") or f"{item['group']}:{item['name']}:{item['version']}"): item
        for item in components
    }
    ordered = sorted(
        unique.values(), key=lambda item: (item["group"], item["name"].lower(), item["version"])
    )
    output.mkdir(parents=True, exist_ok=True)
    (output / "sbom.cdx.json").write_text(
        json.dumps(
            {
                "bomFormat": "CycloneDX",
                "specVersion": "1.6",
                "version": 1,
                "metadata": {"component": {"type": "application", "name": "NEXUS"}},
                "components": ordered,
            },
            ensure_ascii=False,
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )
    notice_lines = [
        "# NEXUS third-party notices",
        "",
        "This distribution includes the following runtime components and their transitive dependencies.",
        "",
        "| Component | Version | License |",
        "| --- | --- | --- |",
    ]
    for item in ordered:
        license_value = item["licenses"][0]["license"]
        license_name = license_value.get("id") or license_value.get("name") or "UNKNOWN"
        notice_lines.append(f"| {item['name']} | {item['version']} | {license_name} |")
    (output / "THIRD_PARTY_NOTICES.md").write_text("\n".join(notice_lines) + "\n", encoding="utf-8")


def main() -> None:
    parser = argparse.ArgumentParser(description="Generate desktop SBOM and license notice")
    parser.add_argument("output", type=Path)
    parser.add_argument("--server-root", type=Path, required=True)
    parser.add_argument("--desktop-root", type=Path, required=True)
    parser.add_argument("--web-root", type=Path, required=True)
    parser.add_argument(
        "--component",
        nargs=3,
        action="append",
        default=[],
        metavar=("NAME", "VERSION", "LICENSE"),
        help="随包二进制，如 --component ffmpeg 7.1 GPL-2.0-or-later",
    )
    args = parser.parse_args()
    generate(args.output, args.server_root, args.desktop_root, args.web_root, args.component)


if __name__ == "__main__":
    main()
