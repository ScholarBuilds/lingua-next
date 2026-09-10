"""画风层：导入库、分类、自定义风格（模块 16 FR-442）。

守的是几条会静默出错的约束：导入的数据被清洗干净了没、自定义风格与内置撞名没被拦、
以及**别的进程能不能看见新建的风格**——最后这条是本模块刚踩过的坑的同款。
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from domain import image_prompts as ip
from domain import image_sizes, image_styles

DATA = Path(__file__).resolve().parents[1] / "data" / "image_styles.json"


class TestImportedLibrary:
    def test_data_file_exists_and_is_sane(self) -> None:
        assert DATA.exists(), "跑 scripts/import_image_styles.py 生成"
        payload = json.loads(DATA.read_text(encoding="utf-8"))
        rows = payload["styles"]
        assert len(rows) >= 100
        for row in rows:
            assert row["key"] and row["label"] and row["render"]
            assert row["category"] in payload["categories"]

    def test_every_style_has_a_chinese_label(self) -> None:
        """面向用户的枚举必须有中文标签（BR-111）。一百多个里混进裸英文名就白做了。"""
        for preset in ip.STYLE_PRESETS.values():
            assert preset.label, f"{preset.key} 没有名字"
            has_cjk = any("一" <= ch <= "鿿" for ch in preset.label)
            assert has_cjk, f"{preset.key} 的名字 {preset.label!r} 不是中文"

    def test_quality_boosters_are_stripped(self) -> None:
        """SDXL 那套质量咒对指令跟随模型不提升画质，只稀释真正的风格描述。

        导入时清洗掉是这一步的主要价值，不清洗等于把一百多条噪音塞进提示词。
        """
        junk = ("8k", "4k", "masterpiece", "best quality", "highly detailed",
                "trending on artstation", "award winning")
        for preset in ip.STYLE_PRESETS.values():
            terms = {t.strip().lower() for t in preset.render.split(",")}
            leaked = terms & set(junk)
            assert not leaked, f"{preset.key} 残留质量咒 {leaked}"

    def test_no_weight_syntax_leaks(self) -> None:
        """`(word:1.4)` 是 SD 的 UI 约定，别的模型只会把括号当字面量画进去。"""
        for preset in ip.STYLE_PRESETS.values():
            assert ":1." not in preset.render, f"{preset.key} 残留权重语法"

    def test_no_prompt_placeholder_leaks(self) -> None:
        for preset in ip.STYLE_PRESETS.values():
            assert "{prompt}" not in preset.render, f"{preset.key} 残留占位符"

    def test_builtin_five_are_cover_category(self) -> None:
        """自制那五个是照卡片封面真实显示尺寸调的，不能和通用风格混在一起挑。"""
        covers = [p for p in ip.STYLE_PRESETS.values() if p.category == "cover"]
        assert len(covers) == 5
        assert all(p.source == "自制" for p in covers)

    def test_category_view_counts_match(self) -> None:
        """分类页签覆盖全部画风——除了刻意排除的「不指定画风」。

        它的描述字段全空，本来就不是一种画风，做成只有一项的页签是噪声。
        `preset_view()` 反过来必须收它：那份是前端 key→名字的反查表。
        """
        hidden = [p for p in ip.STYLE_PRESETS.values() if p.category == ip.NO_STYLE_CATEGORY]
        assert [p.key for p in hidden] == [ip.NO_STYLE_KEY]
        view = ip.style_category_view()
        assert sum(row["count"] for row in view) == len(ip.STYLE_PRESETS) - len(hidden)
        assert ip.NO_STYLE_KEY in {row["key"] for row in ip.preset_view()}

    def test_preset_view_is_grouped_by_category(self) -> None:
        order = [row["category"] for row in ip.preset_view()]
        first_seen = {c: order.index(c) for c in dict.fromkeys(order)}
        assert order == sorted(order, key=lambda c: first_seen[c])
        assert order[0] == "cover", "封面专用要排第一"

    def test_imported_styles_render_into_a_prompt(self) -> None:
        """导入的风格必须真能用来渲染提示词，不能只是躺在注册表里好看。"""
        target = ip.get_target("free")
        brief = {"focal": "a paper lantern on a wooden table", "supporting": ["a teacup"]}
        for key in ("sai-cinematic", "artstyle-art-deco", "photo-film-noir"):
            if key not in ip.STYLE_PRESETS:
                continue
            text, structure = ip.render_prompt(target, brief, style_key=key, size="1024x1024")
            assert ip.STYLE_PRESETS[key].render.split(",")[0].strip() in text
            assert structure is not None


class TestSizeTiers:
    def test_every_tier_passes_hard_limits(self) -> None:
        for ratio in image_sizes.RATIOS.values():
            for tier in image_sizes.TIERS:
                size = ratio.sizes[tier]
                assert ip.validate_size(size) == size
                w, h = ip.parse_size(size)
                assert max(w, h) <= ip.MAX_EDGE

    def test_4k_long_edge_is_3840(self) -> None:
        for key, ratio in image_sizes.RATIOS.items():
            w, h = ip.parse_size(ratio.sizes["4k"])
            assert max(w, h) == 3840, f"{key} 的 4K 长边不是 3840"

    def test_tier_sizes_keep_their_ratio(self) -> None:
        """换档不该悄悄改变比例——用户选的是比例，档位只该改像素多少。"""
        for key, ratio in image_sizes.RATIOS.items():
            values = []
            for tier in image_sizes.TIERS:
                w, h = ip.parse_size(ratio.sizes[tier])
                values.append(w / h)
            spread = max(values) - min(values)
            assert spread < 0.05, f"{key} 各档比例漂了 {spread:.3f}"

    def test_experimental_flag_is_informational_not_blocking(self) -> None:
        """CR-002 之后「上游标注实验性」是事实标注，不再阻断。"""
        assert ip.is_experimental("3840x2160") is True
        assert ip.validate_size("3840x2160") == "3840x2160"
        assert ip.is_experimental("1024x576") is False

    def test_view_exposes_experimental_per_tier(self) -> None:
        view = image_sizes.view()
        for row in view["ratios"]:
            assert set(row["experimental"]) == set(image_sizes.TIERS)


class TestCustomStyleValidation:
    def _draft(self, **over: object) -> image_styles.StyleDraft:
        base = {
            "key": "my-test", "label": "测试风格", "category": "art",
            "render": "flat vector, muted palette",
        }
        base.update(over)
        return image_styles.StyleDraft(**base)  # type: ignore[arg-type]

    def test_accepts_a_reasonable_draft(self) -> None:
        clean = self._draft().validated(existing=False)
        assert clean.key == "my-test"

    def test_rejects_bad_key(self) -> None:
        for bad in ("A", "1abc", "has space", "x", "带中文", "a" * 60):
            with pytest.raises(ip.PromptError, match="标识"):
                self._draft(key=bad).validated(existing=False)

    def test_rejects_collision_with_builtin(self) -> None:
        with pytest.raises(ip.PromptError, match="占用"):
            self._draft(key="soft-flat").validated(existing=False)

    def test_rejects_empty_render(self) -> None:
        with pytest.raises(ip.PromptError, match="画面描述"):
            self._draft(render="   ").validated(existing=False)

    def test_rejects_unknown_category(self) -> None:
        with pytest.raises(ip.PromptError, match="分类"):
            self._draft(category="nowhere").validated(existing=False)

    def test_cover_category_is_reserved_for_builtins(self) -> None:
        """封面专用那一档的构图禁区是照真实卡片尺寸量的，用户自写的没有这层保证。"""
        assert "cover" not in image_styles.ALLOWED_CATEGORIES
        with pytest.raises(ip.PromptError, match="分类"):
            self._draft(category="cover").validated(existing=False)

    def test_trims_and_drops_blank_avoid_terms(self) -> None:
        clean = self._draft(extra_avoid=("  neon  ", "", "   ")).validated(existing=False)
        assert clean.extra_avoid == ("neon",)


class TestCustomStylesReachEveryProcess:
    """自定义风格存在库里，而注册表是**每个进程各一份内存副本**。

    API 与 worker 是两个进程：用户在网页上新建一个风格，只写进 API 那份注册表的话，
    worker 出图时会报「未知风格预设」——网页能下单、后台失败，本模块已经踩过一次
    同款（§14.6 的用途注册）。所以凡是渲染提示词的地方，都必须先 `ensure_loaded`。

    没有数据库夹具，这里用源码级不变式守：谁调 `render_prompt`，谁就得调
    `ensure_loaded`。新增渲染路径时这条会红。
    """

    SERVER = Path(__file__).resolve().parents[1]

    def _render_call_sites(self) -> list[Path]:
        hits: list[Path] = []
        for path in list(self.SERVER.glob("domain/*.py")) + list(
            self.SERVER.glob("app/routers/*.py")
        ):
            text = path.read_text(encoding="utf-8")
            if "render_prompt(" in text and path.name != "image_prompts.py":
                hits.append(path)
        return hits

    def test_there_is_at_least_one_call_site(self) -> None:
        # 这条防的是上面那个 glob 因为改目录结构而悄悄什么都没扫到
        assert self._render_call_sites(), "一个渲染点都没扫到，检查扫描路径"

    def test_every_render_site_loads_custom_styles_first(self) -> None:
        missing = [
            path.name
            for path in self._render_call_sites()
            if "ensure_loaded(" not in path.read_text(encoding="utf-8")
        ]
        assert not missing, (
            f"这些文件渲染提示词却没先加载自定义风格：{missing}。"
            "worker 会因此报「未知风格预设」，而 API 进程一切正常"
        )


class TestTierEffectiveness:
    """标定数据说明「换档位到底改不改像素」。

    实测过一次：某中转对 1K/2K/4K 返回的像素量完全一样（都约 1.57MP），它固定按一个
    像素预算出图，只认比例不认分辨率。这种情况下 UI 必须照实说，不能让人对着一个
    选了没用的控件白挑。
    """

    def setup_method(self) -> None:
        self._saved = dict(image_sizes.MEASURED)
        image_sizes.MEASURED.clear()

    def teardown_method(self) -> None:
        image_sizes.MEASURED.clear()
        image_sizes.MEASURED.update(self._saved)

    def test_no_data_means_unknown(self) -> None:
        assert image_sizes.tiers_effective() is None

    def test_single_tier_is_not_enough_to_judge(self) -> None:
        image_sizes.record_measured("16:9", "1k", "1672x941")
        assert image_sizes.tiers_effective() is None

    def test_identical_pixels_across_tiers_means_inert(self) -> None:
        for tier in ("1k", "2k", "4k"):
            image_sizes.record_measured("16:9", tier, "1672x941")
        assert image_sizes.tiers_effective() is False

    def test_rounding_noise_does_not_count_as_effective(self) -> None:
        """同一比例三档返回 1994x789 / 1986x792 / 1983x793——数值不同但像素量只差
        0.1%，那是取整噪声。按字符串比会误判成「档位有效」，必须按像素量比。"""
        image_sizes.record_measured("2.5:1", "1k", "1994x789")
        image_sizes.record_measured("2.5:1", "2k", "1986x792")
        image_sizes.record_measured("2.5:1", "4k", "1983x793")
        assert image_sizes.tiers_effective() is False

    def test_real_resolution_difference_counts(self) -> None:
        image_sizes.record_measured("1:1", "1k", "1024x1024")
        image_sizes.record_measured("1:1", "4k", "2048x2048")  # 4 倍像素
        assert image_sizes.tiers_effective() is True

    def test_view_carries_the_verdict(self) -> None:
        for tier in ("1k", "2k"):
            image_sizes.record_measured("16:9", tier, "1672x941")
        view = image_sizes.view()
        assert view["calibrated"] is True
        assert view["tiers_effective"] is False
