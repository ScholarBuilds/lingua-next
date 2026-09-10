"""授权引导的守卫（需求 17 §4.4 · 验收 CR005-I）。

这里守的是**结构完整性与内部一致性**，不联网。链接能不能打开由
``scripts/check_provider_links.py`` 探活（那个要联网，不进单测——
网络抖一下就让整个套件红，是最没价值的不稳定测试）。

真正要防的两件事：

1. 引导写了一个 ``PROVIDER_TYPES`` 里不存在的供应商——UI 永远看不到它；
2. ``field_help`` 里写了表单上没有的字段名——用户看到一条对不上号的说明。
   这两种都不报错，只是那部分内容悄悄失效。
"""

from __future__ import annotations

import re

import pytest

from domain import provider_onboarding
from domain.credentials import PROVIDER_TYPES

GUIDES = provider_onboarding.ONBOARDING


class TestCoverage:
    def test_every_guide_points_at_a_real_provider_type(self) -> None:
        unknown = sorted(set(GUIDES) - set(PROVIDER_TYPES))
        assert unknown == [], f"这些供应商有引导但没有录入表单，UI 永远看不到：{unknown}"

    def test_main_providers_have_a_guide(self) -> None:
        """核心供应商必须有引导。TTS 那一族暂时可以没有，但主力不行。"""
        must = {"openai", "deepseek", "openai_compatible", "ollama", "modelscope",
                "gemini_image", "volcengine_video", "comfyui", "runninghub"}
        missing = sorted(must - set(GUIDES))
        assert missing == [], f"这些主力供应商还没写引导：{missing}"

    def test_lookup_returns_none_for_unknown(self) -> None:
        assert provider_onboarding.onboarding_for("does-not-exist") is None


class TestShape:
    @pytest.mark.parametrize("ptype", sorted(GUIDES))
    def test_has_summary_and_steps(self, ptype: str) -> None:
        guide = GUIDES[ptype]
        assert guide.get("summary", "").strip() != "", f"{ptype} 没写「这是什么」"
        steps = guide.get("steps", [])
        assert len(steps) > 0, f"{ptype} 一个步骤都没有，等于没有引导"

    @pytest.mark.parametrize("ptype", sorted(GUIDES))
    def test_every_step_has_title_and_detail(self, ptype: str) -> None:
        for i, step in enumerate(GUIDES[ptype].get("steps", [])):
            assert step.get("title", "").strip() != "", f"{ptype} 第 {i + 1} 步没标题"
            assert step.get("detail", "").strip() != "", f"{ptype} 第 {i + 1} 步没说明"

    @pytest.mark.parametrize("ptype", sorted(GUIDES))
    def test_links_have_labels_and_are_https(self, ptype: str) -> None:
        """有链接就必须有按钮文案，且必须是 https。

        裸 URL 当按钮文案会让引导卡变成一堵链接墙；http 链接在浏览器里会被拦。
        """
        for step in GUIDES[ptype].get("steps", []):
            url = step.get("url", "")
            if url == "":
                continue
            assert url.startswith("https://"), f"{ptype} 有非 https 链接：{url}"
            assert step.get("url_label", "").strip() != "", f"{ptype} 的链接没有按钮文案：{url}"

    @pytest.mark.parametrize("ptype", sorted(GUIDES))
    def test_home_is_https_or_empty(self, ptype: str) -> None:
        home = GUIDES[ptype].get("home", "")
        assert home == "" or home.startswith("https://"), f"{ptype} 的 home 不是 https：{home}"


class TestFieldHelp:
    @pytest.mark.parametrize("ptype", sorted(GUIDES))
    def test_field_help_keys_exist_on_the_form(self, ptype: str) -> None:
        """``field_help`` 的键必须是表单上真有的字段。

        写错字段名不会报错，只是那条说明永远不显示——而作者以为自己写了。
        """
        spec = PROVIDER_TYPES.get(ptype)
        if spec is None:
            pytest.skip("没有对应表单，由 TestCoverage 负责报错")
        form_fields = {f["name"] for f in spec.get("fields", [])}
        # `model` 不是凭据字段，是模型部署那边的，允许出现在说明里
        extra = set(GUIDES[ptype].get("field_help", {})) - form_fields - {"model"}
        assert extra == set(), f"{ptype} 的 field_help 写了表单上没有的字段：{sorted(extra)}"


class TestNoPlaceholders:
    """引导里不许留占位符。写一半的引导比没有更误导。"""

    PLACEHOLDER = re.compile(r"(TODO|TBD|待补|xxx|示例地址|\bfoo\b)", re.IGNORECASE)

    @pytest.mark.parametrize("ptype", sorted(GUIDES))
    def test_no_placeholder_text(self, ptype: str) -> None:
        guide = GUIDES[ptype]
        blobs = [guide.get("summary", ""), guide.get("pricing", "")]
        for step in guide.get("steps", []):
            blobs += [step.get("title", ""), step.get("detail", "")]
        blobs += list(guide.get("field_help", {}).values())
        blobs += list(guide.get("troubles", {}).values())
        hits = [b for b in blobs if self.PLACEHOLDER.search(b)]
        assert hits == [], f"{ptype} 的引导里还有占位符：{hits}"


class TestAllLinks:
    def test_collects_home_and_step_urls(self) -> None:
        links = provider_onboarding.all_links()
        urls = {url for _, url in links}
        assert "https://platform.openai.com/api-keys" in urls
        assert "https://comfy.org" in urls, "www.comfy.org 是死链，实测只有 comfy.org 能开"
        assert all(u.startswith("https://") for u in urls)

    def test_does_not_include_api_endpoints(self) -> None:
        """API 端点不进探活清单：它们的根路径本来就 404（实测
        api-inference.modelscope.cn/v1 与 api.apimart.ai 都是），
        拿去探活会得到一堆假死链。"""
        urls = {url for _, url in provider_onboarding.all_links()}
        assert not any("api-inference" in u for u in urls)
