"""生图默认参数单一事实源的守卫（需求 17 §6.4.1 · CR-005 §3.5）。

这里守两件事：

1. **全局默认真的是 high**——用户明确要求，且它散落过十三处，
   任何一处退回 medium 都要在这里炸出来。
2. **没有人再写字面量默认**——源码级扫描。新加一条出图路径时
   顺手写 ``= "medium"`` 是最自然的手滑，而它不会报错，
   只会让那条链路悄悄出中等质量的图。
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

from domain import image_defaults

SERVER_ROOT = Path(__file__).resolve().parents[1]


class TestFallback:
    def test_factory_default_is_high(self) -> None:
        assert image_defaults.FALLBACK_QUALITY == "high"

    def test_quality_falls_back_when_cache_empty(self) -> None:
        image_defaults.reset_cache()
        assert image_defaults.quality() == "high"

    def test_cache_wins_over_factory(self) -> None:
        image_defaults.reset_cache()
        image_defaults._CACHE["quality"] = "low"
        try:
            assert image_defaults.quality() == "low"
        finally:
            image_defaults.reset_cache()

    def test_illegal_cached_value_is_ignored(self) -> None:
        image_defaults.reset_cache()
        image_defaults._CACHE["quality"] = "ultra"
        try:
            # 库里存了废弃档名时不该整条链路崩掉，回落出厂默认继续跑
            assert image_defaults.quality() == "high"
        finally:
            image_defaults.reset_cache()


class TestNormalize:
    @pytest.mark.parametrize(
        "raw,want", [("low", "low"), ("HIGH", "high"), ("  medium ", "medium")]
    )
    def test_accepts_legal_values(self, raw: str, want: str) -> None:
        assert image_defaults.normalize_quality(raw) == want

    @pytest.mark.parametrize("raw", [None, "", "ultra", "auto", "4k"])
    def test_falls_back_on_anything_else(self, raw: str | None) -> None:
        image_defaults.reset_cache()
        assert image_defaults.normalize_quality(raw) == "high"


class TestNoLiteralDefaults:
    """源码级守卫：出图路径上不许再出现 ``quality`` 的字面量默认。

    只扫**默认值**形态，两种：

    - 带类型标注的默认值：``quality: str = "medium"``、``quality: Literal[...] = "medium"``
    - 兜底默认：``quality=... or "medium"``

    显式传值不算（``quality="low"`` 这种关键字实参是优先级第一层，完全合法——
    连通性探测、空态小图就该显式要低质量）。判据是有没有类型标注：
    默认值一定出现在 ``def`` 签名或类字段声明里，实参没有。
    """

    ANNOTATED_DEFAULT = re.compile(r'\bquality\s*:[^=\n]+=\s*["\'](?:low|medium|high)["\']')
    OR_FALLBACK = re.compile(r'\bquality\b[^\n]*\bor\s+["\'](?:low|medium|high)["\']')

    def _sources(self) -> list[Path]:
        out: list[Path] = []
        for sub in ("domain", "app", "worker"):
            out.extend(p for p in (SERVER_ROOT / sub).rglob("*.py") if "test" not in p.name)
        return out

    def test_no_literal_quality_default_in_production_code(self) -> None:
        offenders: list[str] = []
        for path in self._sources():
            for lineno, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
                stripped = line.strip()
                if stripped.startswith("#"):
                    continue
                if self.ANNOTATED_DEFAULT.search(line) or self.OR_FALLBACK.search(line):
                    offenders.append(f"{path.relative_to(SERVER_ROOT)}:{lineno}: {stripped}")
        assert offenders == [], (
            "这些地方写了生图质量的字面量默认，改成 image_defaults.FALLBACK_QUALITY "
            "或 image_defaults.normalize_quality()：\n" + "\n".join(offenders)
        )
