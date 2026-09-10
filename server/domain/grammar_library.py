from __future__ import annotations

import hashlib
import shutil
from dataclasses import dataclass, field
from pathlib import Path

from domain.grammar_notes import SKIP_DIRS

_SKIP_FOLDED = {name.casefold() for name in SKIP_DIRS}


def _allowed(relative: Path) -> bool:
    return all(
        not part.startswith(".") and part.casefold() not in _SKIP_FOLDED
        for part in relative.parts
    )


def markdown_files(root: Path) -> list[Path]:
    root = root.expanduser().resolve()
    if not root.is_dir():
        return []
    return [
        path
        for path in sorted(root.rglob("*.md"), key=lambda item: str(item.relative_to(root)))
        if path.is_file() and not path.is_symlink() and _allowed(path.relative_to(root))
    ]


def _digest(path: Path) -> bytes:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.digest()


@dataclass
class ImportResult:
    source: Path
    target: Path
    discovered: int
    copied: int = 0
    unchanged: int = 0
    conflicts: list[str] = field(default_factory=list)

    def view(self) -> dict:
        return {
            "source": str(self.source),
            "target": str(self.target),
            "discovered": self.discovered,
            "copied": self.copied,
            "unchanged": self.unchanged,
            "conflicts": self.conflicts,
        }


def import_markdown_tree(source: Path, target: Path) -> ImportResult:
    source = source.expanduser().resolve()
    target = target.expanduser().resolve()
    if not source.is_dir():
        raise ValueError("选择的讲义目录不存在")
    if source == target or source.is_relative_to(target) or target.is_relative_to(source):
        raise ValueError("源目录和 NEXUS 讲义目录不能互相包含")

    files = markdown_files(source)
    if not files:
        raise ValueError("选择的目录里没有可导入的 Markdown 讲义")

    result = ImportResult(source=source, target=target, discovered=len(files))
    target.mkdir(parents=True, exist_ok=True)
    for path in files:
        relative = path.relative_to(source)
        destination = target / relative
        if destination.exists():
            if destination.is_file() and _digest(path) == _digest(destination):
                result.unchanged += 1
            else:
                result.conflicts.append(str(relative))
            continue
        destination.parent.mkdir(parents=True, exist_ok=True)
        temporary = destination.with_name(f".{destination.name}.importing")
        shutil.copy2(path, temporary)
        temporary.replace(destination)
        result.copied += 1
    return result
