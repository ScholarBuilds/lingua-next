"""生图提示词层与资产层的纯函数单测（模块 16）。

守三件事：尺寸校验不放过非法值也不静默纠正、提示词里的禁令确实进得去、
体检判据不会把正常的扁平风插画当成纯色图误杀。
"""

import io

import pytest

from domain import image_prompts as ip


class TestValidateSize:
    def test_accepts_preset_sizes(self):
        for target in ip.TARGETS.values():
            for size in target.sizes:
                assert ip.validate_size(size) == size

    def test_rejects_non_multiple_of_16(self):
        # 静默纠正会让产物指纹与用户填的值对不上，下次重跑莫名不命中缓存
        with pytest.raises(ip.PromptError, match="16 的倍数"):
            ip.validate_size("1000x600")

    def test_rejects_ratio_beyond_3_to_1(self):
        with pytest.raises(ip.PromptError, match="宽高比"):
            ip.validate_size("3200x256")

    def test_rejects_beyond_max_edge(self):
        # 单边上限是硬约束，仍然拦
        with pytest.raises(ip.PromptError, match="单边"):
            ip.validate_size("4096x2048")

    def test_experimental_sizes_pass_but_are_flagged(self):
        """超过 2560x1440 只标记不拦（CR-002 开放 4K 后的口径）。

        改动前这里是直接抛错。用户明确要 4K 且自有账号 token 不是约束，所以
        「上游标注实验性」从阻断降级成事实标注——能出和上游保证出得好是两回事，
        UI 照实标出来即可。
        """
        assert ip.validate_size("3072x1536") == "3072x1536"
        assert ip.is_experimental("3072x1536") is True
        assert ip.is_experimental("1024x1024") is False

    def test_rejects_garbage(self):
        for bad in ("", "abc", "1024", "1024*768"):
            with pytest.raises(ip.PromptError):
                ip.validate_size(bad)

    def test_accepts_full_width_x(self):
        assert ip.validate_size("1024×1024") == "1024x1024"


class TestStructure:
    def _brief(self):
        return ip.clean_brief(
            {
                "focal": "a cafe counter with an espresso machine",
                "supporting": ["a pastry case", "hanging menu board"],
                "setting": "morning light from a side window",
                "mood": "warm, calm, inviting",
                "palette": "warm browns and cream",
                "avoid": ["modern laptops"],
            }
        )

    def test_text_is_banned_by_default(self):
        target = ip.get_target("deck_cover")
        prompt, structure = ip.render_prompt(target, self._brief())
        avoid = " ".join(structure["constraints"]["avoid"]).lower()
        assert "text" in avoid and "logo" in avoid
        assert "modern laptops" in avoid  # brief 里的忌讳也要并进去
        assert "espresso machine" in prompt

    def test_free_target_allows_text(self):
        target = ip.get_target("free")
        _prompt, structure = ip.render_prompt(target, self._brief())
        first = structure["constraints"]["avoid"][0].lower()
        assert "text" not in first

    def test_safe_areas_reach_the_prompt(self):
        """卡片左上压徽章、右下压进度环，禁区不进提示词主体就会正好被挡住。"""
        target = ip.get_target("deck_cover")
        prompt, structure = ip.render_prompt(target, self._brief())
        safe = " ".join(structure["layout"]["safe_areas"])
        assert "top-left" in safe and "bottom-right" in safe
        assert "top-left" in prompt

    def test_style_preset_wins_over_model_freedom(self):
        """风格由预设决定：换风格必须换掉 render 描述。"""
        target = ip.get_target("deck_cover")
        _flat, flat = ip.render_prompt(target, self._brief(), style_key="soft-flat")
        _iso, iso = ip.render_prompt(target, self._brief(), style_key="clean-isometric")
        assert flat["style"]["render"] != iso["style"]["render"]
        assert "isometric" in iso["style"]["render"]

    def test_unknown_style_rejected(self):
        with pytest.raises(ip.PromptError):
            ip.render_prompt(ip.get_target("free"), self._brief(), style_key="nope")

    def test_canvas_records_actual_size(self):
        target = ip.get_target("deck_cover")
        _p, structure = ip.render_prompt(target, self._brief(), size="1024x1024")
        assert structure["layout"]["canvas"].startswith("1024x1024")

    def test_allow_text_target_carries_exact_strings(self):
        target = ip.get_target("free")
        _p, structure = ip.render_prompt(target, self._brief(), text_content={"title": "Moby-Dick"})
        assert structure["text"]["title"] == "Moby-Dick"
        assert "verbatim" in structure["text"]["rule"]


class TestNoStyle:
    """「不指定画风」是一等选项，不是「没选」的同义词。

    改这版之前：`free`（自由出图）继承 dataclass 默认的 soft-flat，而空串又会被
    `style_key or default_style` 吞掉、回落成同一个默认——于是「随便画一张」全是柔和
    扁平插画，且没有任何办法表达「我不要画风」。
    """

    def _brief(self, **over):
        base = {"focal": "a brass desk bell", "supporting": ["a folded newspaper"]}
        base.update(over)
        return ip.clean_brief(base)

    def test_no_style_is_a_real_registered_preset(self):
        preset = ip.STYLE_PRESETS[ip.NO_STYLE_KEY]
        assert preset is ip.NO_STYLE
        assert preset.key == "none" and preset.label == "不指定画风"
        assert preset.category == ip.NO_STYLE_CATEGORY
        # 四个描述字段全空是它的定义本身：空了 style 段才会整段不进结构
        assert (preset.render, preset.palette, preset.lighting, preset.texture) == (
            "",
            "",
            "",
            "",
        )

    def test_missing_key_falls_back_to_the_target_default(self):
        target = ip.get_target("deck_cover")
        for nothing in (None, "", "   "):
            assert target.resolved_style(nothing).key == target.default_style == "soft-flat"

    def test_explicit_none_is_not_a_fallback(self):
        """「明确不要画风」与「没选」必须是两条路，否则前者根本无法表达。"""
        assert ip.get_target("deck_cover").resolved_style("none") is ip.NO_STYLE

    def test_unknown_key_still_raises(self):
        with pytest.raises(ip.PromptError, match="未知风格预设"):
            ip.get_target("free").resolved_style("no-such-style")

    def test_free_target_defaults_to_no_style(self):
        assert ip.get_target("free").default_style == ip.NO_STYLE_KEY

    def test_free_prompt_carries_no_style_section(self):
        prompt, structure = ip.render_prompt(ip.get_target("free"), self._brief())
        assert "style" not in structure, "没指定画风就不该有 style 段"
        assert "flat vector" not in prompt  # soft-flat 的招牌词一个都不许漏进去

    def test_brief_palette_survives_without_a_style(self):
        """用户没指定画风、立意却给了配色——style 段只剩 palette，这是对的。"""
        _p, structure = ip.render_prompt(
            ip.get_target("free"), self._brief(palette="warm browns and cream")
        )
        assert structure["style"] == {"palette": "warm browns and cream"}

    def test_learning_targets_keep_their_tuned_style(self):
        """学习用途的画风照着卡片真实显示尺寸调过，这次不能被顺手改掉。"""
        for key in (
            "deck_cover",
            "book_cover",
            "talk_scene",
            "passage_illustration",
            "word_mnemonic",
        ):
            target = ip.get_target(key)
            assert target.default_style == "soft-flat"
            _p, structure = ip.render_prompt(target, self._brief())
            assert structure["style"]["render"]

    def test_empty_style_fields_never_reach_the_structure(self):
        """顶层那个空值过滤够不着嵌套字段，逐键过滤才拦得住。"""
        bare = ip.StylePreset(key="_bare", label="裸风格", hint="", render="ink wash")
        structure = ip.build_structure(ip.get_target("free"), bare, self._brief(), size="1024x1024")
        assert structure["style"] == {"render": "ink wash"}

    def test_category_tabs_exclude_none_but_the_preset_list_keeps_it(self):
        """不对称是刻意的：只有一项的分类页签是噪声，而 key→名字的反查表缺了它，
        前端就只能把画风显示成裸键 "none"。"""
        assert ip.NO_STYLE_KEY not in {row["key"] for row in ip.style_category_view()}
        assert ip.NO_STYLE_KEY in {row["key"] for row in ip.preset_view()}


class TestCleanBrief:
    def test_tolerates_garbage(self):
        for bad in (None, [], "text", 42):
            out = ip.clean_brief(bad)
            assert out["focal"] == ""
            assert out["supporting"] == []

    def test_caps_list_length(self):
        out = ip.clean_brief({"supporting": [f"thing {i}" for i in range(20)]})
        assert len(out["supporting"]) == 4

    def test_squashes_whitespace(self):
        out = ip.clean_brief({"focal": "a   cafe\n\ncounter"})
        assert out["focal"] == "a cafe counter"

    def test_flattens_list_valued_text_fields(self):
        """模型常把 mood/palette 答成数组（实测「咖啡馆点单」那次就是）。
        直接 str() 会把 Python 字面量的方括号与引号漏进提示词。"""
        out = ip.clean_brief({"mood": ["warm", "busy", "casual"]})
        assert out["mood"] == "warm, busy, casual"
        assert "[" not in out["mood"] and "'" not in out["mood"]


class TestTargets:
    def test_deck_cover_matches_card_geometry(self):
        """.deck-cover 固定 92px 高、网格 minmax(196px,1fr) → 显示比 2.1:1~2.8:1。
        生成比取中段，两端裁切都最少。"""
        w, h = ip.parse_size(ip.get_target("deck_cover").size)
        assert 2.1 < w / h < 2.8

    def test_book_cover_is_exactly_two_thirds(self):
        """书架 .cover 锁 aspect-ratio: 2/3，生成即展示不裁切。"""
        w, h = ip.parse_size(ip.get_target("book_cover").size)
        assert w / h == pytest.approx(2 / 3, abs=0.01)

    def test_every_target_default_size_is_valid(self):
        for target in ip.TARGETS.values():
            assert ip.validate_size(target.size)
            assert target.size in target.sizes

    def test_every_target_default_style_exists(self):
        for target in ip.TARGETS.values():
            assert target.default_style in ip.STYLE_PRESETS


class TestAssetProbe:
    """体检判据。别照抄 fetch_covers.py 的 0.45——那条判的是「下半部分」且专治
    Gutenberg 占位封面，扁平风生成图的下半本来就常是大色块，会被误杀。"""

    def _png(self, size, color):
        from PIL import Image

        buf = io.BytesIO()
        Image.new("RGB", size, color).save(buf, format="PNG")
        return buf.getvalue()

    def _flat_bottom_png(self, size=(512, 256)):
        """上半有内容、下半整块纯色——典型的扁平插画构图，必须判为合格。"""
        from PIL import Image, ImageDraw

        im = Image.new("RGB", size, (240, 235, 225))
        draw = ImageDraw.Draw(im)
        for i in range(0, size[0], 8):
            draw.line([(i, 0), (i, size[1] // 2)], fill=(60 + i % 150, 90, 140), width=3)
        draw.rectangle([0, size[1] // 2, size[0], size[1]], fill=(210, 195, 170))
        buf = io.BytesIO()
        im.save(buf, format="PNG")
        return buf.getvalue()

    def test_reads_dimensions(self):
        from domain import image_assets

        info = image_assets.probe(self._flat_bottom_png((640, 256)))
        assert (info.width, info.height) == (640, 256)
        assert info.mime == "image/png"

    def test_rejects_non_image(self):
        from domain import image_assets

        with pytest.raises(image_assets.ImageAssetError):
            image_assets.probe(b"not an image at all")

    def test_rejects_solid_colour(self):
        from domain import image_assets

        with pytest.raises(image_assets.ImageAssetError, match="纯色"):
            image_assets.check(self._png((512, 512), (12, 34, 56)))

    def test_accepts_flat_illustration_with_solid_bottom_half(self):
        from domain import image_assets

        info = image_assets.check(self._flat_bottom_png())
        assert info.flat_ratio < image_assets.MAX_FLAT_RATIO

    def test_rejects_tiny(self):
        from domain import image_assets

        with pytest.raises(image_assets.ImageAssetError, match="过小"):
            image_assets.probe(self._png((32, 32), (10, 200, 90)))

    def test_derives_smaller_webp_and_skips_upscale(self):
        from domain import image_assets

        big = self._flat_bottom_png((1536, 608))
        thumb = image_assets._resize_webp(big, image_assets.THUMB_WIDTH)
        assert thumb is not None and len(thumb) < len(big)
        # 原图比目标还窄时不放大，返回 None 让调用方回落原图
        assert image_assets._resize_webp(self._flat_bottom_png((160, 80)), 768) is None

    def test_key_layout(self):
        from domain import image_assets

        sha = "a" * 64
        key = image_assets.build_key(sha, "image/png")
        assert key.startswith("images/") and key.endswith(f"{sha}.png")
        assert image_assets.build_key(sha, "image/webp", suffix=".t").endswith(".t.webp")


class TestAssetUrl:
    def test_carries_api_prefix_and_version(self):
        """<img src> 不走 fetch 助手：没有 /api 前缀会被 SPA 回落吞掉；
        没有 ?v= 则换了图一周内看不到（媒体响应是一周强缓存）。"""
        from domain import image_assets

        url = image_assets.asset_url(7, "thumb", 1234)
        assert url.startswith("/api/images/assets/7/thumb")
        assert "?v=1234" in url


class TestEnsureCanvas:
    """实测（gpt 中转 + gpt-image-2）：`size` 参数不决定出图比例，提示词里写的画布才决定。

    同样请求 1536x608——自动提示词带 canvas 的回 1994x789（2.527:1），
    手写提示词没带的回 1536x1024（1.500:1）。所以手写路径必须补这一句。
    """

    def test_appends_when_missing(self):
        out = ip.ensure_canvas("a brass desk bell", "1536x608")
        assert "1536x608" in out
        assert "2.53:1" in out
        assert out.startswith("a brass desk bell")

    def test_leaves_prompt_alone_when_already_stated(self):
        for existing in (
            '{"layout": {"canvas": "1536x608 (2.53:1)"}}',
            "wide banner, aspect ratio 2.5:1",
        ):
            assert ip.ensure_canvas(existing, "1536x608") == existing

    def test_auto_prompt_already_carries_canvas(self):
        """自动路径不该被重复追加——render_prompt 的 layout.canvas 已经写了。"""
        target = ip.get_target("deck_cover")
        prompt, _ = ip.render_prompt(target, ip.clean_brief({"focal": "a bell"}))
        assert ip.ensure_canvas(prompt, target.size) == prompt

    def test_rejects_bad_size(self):
        with pytest.raises(ip.PromptError):
            ip.ensure_canvas("anything", "1000x600")


class TestTunableChoices:
    """select 的中文标签（模块 16）：soft-flat / clean-isometric 这种裸键
    摆在下拉里没人看得懂，重跑弹窗要显示中文。"""

    def test_labels_pair_with_options(self):
        from domain.pipeline import Tunable

        t = Tunable("style", "风格", "select", "a", ("a", "b"), option_labels=("甲", "乙"))
        assert t.labeled_options() == [
            {"value": "a", "label": "甲"},
            {"value": "b", "label": "乙"},
        ]

    def test_falls_back_to_raw_values(self):
        from domain.pipeline import Tunable

        t = Tunable("engine", "引擎", "select", "auto", ("auto", "llm"))
        assert [c["label"] for c in t.labeled_options()] == ["auto", "llm"]

    def test_tolerates_short_label_tuple(self):
        """标签少给了不能炸，缺的那几个退回显示原值。"""
        from domain.pipeline import Tunable

        t = Tunable("q", "质量", "select", "low", ("low", "mid", "high"), option_labels=("低",))
        assert [c["label"] for c in t.labeled_options()] == ["低", "mid", "high"]

    def test_cover_node_labels_every_select(self):
        """场景本封面节点的每个 select 都必须配齐中文标签。"""
        # scenario_deck 这条管线是 domain.scenario_decks 的 import 副作用注册进去的。
        # 不显式 import，单独跑这个文件时注册表里根本没有 cover 节点——
        # 全量跑绿、单文件跑红，比一直红更难查
        from domain import scenario_decks  # noqa: F401
        from domain.pipeline import get_pipeline

        cover = get_pipeline("scenario_deck").by_name["cover"]
        selects = [t for t in cover.tunables if t.type == "select"]
        assert selects, "cover 节点应有 select 参数"
        for tunable in selects:
            assert len(tunable.option_labels) == len(tunable.options)


class TestAspectChoice:
    """「不指定比例」时由立意挑画幅（FR-451）。

    画幅是画面的一部分——手机整屏就是竖的、横幅就是宽的。与其让用户在八个比例里
    猜哪个配得上自己的想法，不如让想画面的那一步一起定，再把它选了什么显示出来。
    """

    def test_choices_cover_every_ratio_without_leaking_numbers(self):
        """候选清单要给全比例，但不能带尺寸数字——那会让模型去纠结分辨率。"""
        from domain import image_sizes

        choices = image_sizes.aspect_choices()
        assert {c["key"] for c in choices} == set(image_sizes.RATIOS)
        for c in choices:
            assert c["label"] and c["good_for"]
            assert "x" not in c["good_for"].lower() or "×" not in c["good_for"]
            assert not any(ch.isdigit() and ch in "0123456789" for ch in c["good_for"][:0])

    def test_resolves_chosen_aspect_at_the_asked_tier(self):
        from domain import image_sizes

        assert image_sizes.size_for_aspect("16:9", "1k") == "1024x576"
        assert image_sizes.size_for_aspect("16:9", "2k") == "2048x1152"

    def test_unknown_aspect_returns_none_instead_of_raising(self):
        """模型答错一个 key 不该让整张图出不来，兜底由调用方决定。"""
        from domain import image_sizes

        assert image_sizes.size_for_aspect("21:9", "1k") is None
        assert image_sizes.size_for_aspect("", "1k") is None
        assert image_sizes.size_for_aspect("  ", "1k") is None

    def test_unknown_tier_falls_back_to_1k(self):
        from domain import image_sizes

        assert image_sizes.size_for_aspect("1:1", "8k") == image_sizes.RATIOS["1:1"].sizes["1k"]

    def test_brief_prompt_asks_for_aspect_only_when_choices_given(self):
        from domain import image_prompts

        target = image_prompts.get_target("free")
        plain_system, plain_user = image_prompts.build_brief_prompt(target, {}, "一只猫")
        assert "aspect" not in plain_system
        assert "aspect_choices" not in plain_user

        from domain import image_sizes

        sys_text, user_text = image_prompts.build_brief_prompt(
            target, {}, "一只猫", aspects=image_sizes.aspect_choices()
        )
        assert "aspect" in sys_text
        assert "aspect_choices" in user_text
        assert "9:16" in user_text

    def test_clean_brief_keeps_aspect_but_does_not_validate_it(self):
        """形态收敛归 image_prompts，比例是否存在归调用方——目录在 image_sizes，
        这里 import 回去就成环了。"""
        from domain import image_prompts

        assert image_prompts.clean_brief({"aspect": " 9:16 "})["aspect"] == "9:16"
        # 不存在的比例照样带出来，由调用方核对后兜底
        assert image_prompts.clean_brief({"aspect": "21:9"})["aspect"] == "21:9"
        assert image_prompts.clean_brief({})["aspect"] == ""
        assert image_prompts.clean_brief({"aspect": None})["aspect"] == ""
        # 答成数组也不能把 Python 字面量漏进去
        assert "[" not in image_prompts.clean_brief({"aspect": ["16:9"]})["aspect"]


class TestGatewayClient:
    """本机上游一律不走系统代理（踩过的坑：所有 LLM 调用静默退化）。"""

    def test_loopback_hosts_are_recognised(self):
        from domain import gateway

        for url in (
            "http://localhost:4000",
            "http://127.0.0.1:4000",
            "http://127.13.2.9:4000",
            "http://[::1]:4000",
        ):
            assert gateway.is_local(url), url

    def test_remote_hosts_keep_env_proxy(self):
        from domain import gateway

        for url in ("https://llm.example.com", "http://10.0.0.5:4000", "http://relay:4000"):
            assert not gateway.is_local(url), url

    def test_local_target_disables_env_proxy(self):
        """这条是本坑的直接守卫：本机上游的 httpx 必须 trust_env=False。

        httpx 默认读 macOS 系统代理，把 127.0.0.1 也送进代理，代理回一个空 body 的
        502；而 plan_brief 吞掉异常退回原文，图照出、状态照样成功，只有提示词悄悄
        变差——从界面上完全看不出来。
        """
        from domain import gateway

        client = gateway.http_client(5.0, "http://127.0.0.1:11434/v1")
        assert client is not None
        assert client.trust_env is False

    async def test_remote_target_uses_explicit_routing(self):
        """远端上游返回 None，照旧尊重环境代理：企业网里那是唯一出口。"""
        from domain import gateway

        client = gateway.http_client(5.0, "https://llm.example.com/v1")
        assert client._trust_env is False
        await client.aclose()

    def test_target_url_is_required(self):
        """没有默认目标可兜底：漏传 target 直接 TypeError，不许静默按别处的地址判。"""
        import inspect

        from domain import gateway

        param = inspect.signature(gateway.http_client).parameters["target_url"]
        assert param.default is inspect.Parameter.empty

    def test_every_gateway_client_passes_http_client(self):
        """只有 Provider/专用 adapter 可建 AsyncOpenAI，且必须传受控 client。"""
        import pathlib

        root = pathlib.Path(__file__).resolve().parents[1] / "domain"
        for name in ("model_runtime", "imagegen", "image_describe"):
            src = (root / f"{name}.py").read_text(encoding="utf-8")
            assert "AsyncOpenAI(" in src, name
            assert "http_client=gateway.http_client(" in src, f"{name} 漏了 http_client"

        image_stream = (root / "image_stream.py").read_text(encoding="utf-8")
        assert "prepare_image_route(" in image_stream
        assert "open_stream_client(" in image_stream
        assert "AsyncOpenAI(" not in image_stream

        # Chat 消费者不再自建协议客户端，必须经一次性 Provider call。
        for name in ("llm", "studio_gpt"):
            src = (root / f"{name}.py").read_text(encoding="utf-8")
            assert "prepare_call(" in src, name
            assert "AsyncOpenAI(" not in src, name

        # 翻译不再自建客户端：它必须委托统一 LLM 路由，否则会绕开能力绑定。
        translate = (root / "translate.py").read_text(encoding="utf-8")
        assert "AsyncOpenAI(" not in translate
        assert "complete_text(" in translate and "stream_text(" in translate


class TestAutoSize:
    """画幅「自动」是一等选项，不是"缺了个值"。

    与画风的 `NO_STYLE` 完全同构，坑也是同一个：空串/None 一路被
    `size or 默认` 吞掉，回落到 Tunable 的 `1536x608`（给单词卡横幅调的数）。
    实测后果——画布上选着「画幅自动」写「出一个移动端 app 的登录页面」，
    实际发出去的是 `…… Canvas: 1536x608, aspect ratio 2.53:1.`，
    模型只能把三个手机屏并排塞进超宽 banner。
    """

    def test_auto_passes_validation_unchanged(self) -> None:
        assert ip.validate_size("auto") == ip.AUTO_SIZE
        assert ip.validate_size(" AUTO ") == ip.AUTO_SIZE

    def test_empty_is_not_auto(self) -> None:
        """空串是"没说"，不是"明确不要"——两者必须分开，否则又回到原来的坑。"""
        assert ip.is_auto_size("") is False
        assert ip.is_auto_size(None) is False
        assert ip.is_auto_size("auto") is True

    def test_ensure_canvas_adds_nothing_for_auto(self) -> None:
        """补一句画布就等于把「自动」翻译成某个具体比例，而那正是用户要避开的。"""
        prompt = "出一个移动端 app 的登录页面，场景是语聊房"
        assert ip.ensure_canvas(prompt, "auto") == prompt

    def test_ensure_canvas_still_adds_for_a_real_size(self) -> None:
        got = ip.ensure_canvas("x", "1024x1536")
        assert "1024x1536" in got and "0.67:1" in got

    def test_parse_size_refuses_auto_loudly(self) -> None:
        """auto 没有具体尺寸。静默返回一个数字的话，调用方会拿它去算比例。"""
        with pytest.raises(ip.PromptError):
            ip.parse_size("auto")

    def test_is_experimental_does_not_blow_up_on_auto(self) -> None:
        # 这个函数被 UI 直接调；让它抛等于点开尺寸选择器就白屏
        assert ip.is_experimental("auto") is False

    def test_structure_omits_canvas_for_auto(self) -> None:
        """`layout.canvas` 正是决定出图比例的那一条，自动时整条不写。"""
        target = ip.get_target("free")
        brief = {"focal": "a phone login screen"}
        text, structure = ip.render_prompt(target, brief, style_key="none", size="auto")
        assert structure["layout"].get("canvas", "") == ""
        assert "aspect ratio" not in text.lower()

    def test_structure_keeps_canvas_for_a_real_size(self) -> None:
        target = ip.get_target("free")
        _text, structure = ip.render_prompt(
            target, {"focal": "x"}, style_key="none", size="1024x1536"
        )
        assert "1024x1536" in structure["layout"]["canvas"]


class TestAutoSizeReachesTheWire:
    """「自动」必须真的传到请求体上——不传 size，而不是传字面量 "auto"。

    只在提示词层做对是不够的：`size` 参数虽然不决定比例，但传一个上游不认识的
    字符串只会换回一个看不懂的 400。
    """

    def test_generate_omits_size(self, monkeypatch: pytest.MonkeyPatch) -> None:
        seen = _capture_generate(monkeypatch)
        _run_render("auto")
        assert "size" not in seen[0]

    def test_generate_keeps_a_real_size(self, monkeypatch: pytest.MonkeyPatch) -> None:
        seen = _capture_generate(monkeypatch)
        _run_render("1024x1536")
        assert seen[0]["size"] == "1024x1536"

    async def test_generate_persists_sanitized_invocation(
        self, session, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        from sqlalchemy import select

        from domain import imagegen
        from domain.models import ModelInvocation

        _capture_generate(monkeypatch)
        await imagegen.render_images(
            "a phone login screen",
            alias="image-free",
            size="1024x1536",
            quality="high",
            n=1,
            route=_direct_route(),
        )
        invocation = (await session.execute(select(ModelInvocation))).scalar_one()
        assert invocation.plugin_id == "openai"
        assert invocation.operation == "image.generate"
        assert invocation.runtime_generation is not None
        assert invocation.status == "succeeded"
        assert invocation.request["prompt"] == "a phone login screen"
        assert invocation.request["route"]["runtime_generation"] == invocation.runtime_generation
        assert invocation.response["image_count"] == 1


# ---- 上面那组用到的替身 ----


def _capture_generate(monkeypatch: pytest.MonkeyPatch) -> list[dict]:
    """把 images.generate 换成只记参数的假实现，返回收到的 kwargs 列表。"""
    import base64
    import types

    seen: list[dict] = []

    # 回一张真的 1x1 png：返回空 data 会被下游正当地拒（"上游返回了空结果"），
    # 那样测试失败的原因就与它要守的东西无关了
    one_px = base64.b64encode(
        bytes.fromhex(
            "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4"
            "890000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082"
        )
    ).decode()

    class _Images:
        async def generate(self, **kwargs):
            seen.append(kwargs)
            return types.SimpleNamespace(
                data=[types.SimpleNamespace(b64_json=one_px, url=None, revised_prompt=None)],
                usage=None,
            )

    class _Client:
        images = _Images()

        async def close(self):
            return None

    from domain import imagegen

    monkeypatch.setattr(imagegen, "route_client", lambda route: (_Client(), "fake-model"))
    return seen


def _direct_route():
    """一条直连 openai 部署的路由。

    能力没绑定部署时 render_images 会直接抛「未绑定」，所以这组测「参数怎么进请求体」
    的用例必须自带路由。
    """
    from domain.model_catalog import ResolvedModelRoute

    return ResolvedModelRoute(
        deployment_id=1,
        adapter_type="openai",
        upstream_model_id="fake-model",
        provider_type="openai_compatible",
        credential_config={"api_base": "https://direct.example/v1", "api_key": "sk-x"},
        protocol_options={},
    )


def _run_render(size: str) -> None:
    import asyncio

    from domain import imagegen

    asyncio.run(
        imagegen.render_images(
            "x", alias="image-free", size=size, quality="high", n=1, route=_direct_route()
        )
    )


class TestExamDeckCover:
    """考纲本封面与场景本封面必须是两个用途。

    合并成一个的代价实测过：`deck_cover` 的 subject_kind 问的是
    「这本讲哪个真实生活场景」，考纲本没有这个答案（中考、GRE 都不是一个地点），
    模型对八本一律回答「书桌 + 单词卡 + 台灯」，传进去的场景关键词全程没参与——
    八张封面长得一模一样，从图上分不出哪本是哪本，而且不报错。
    """

    def test_two_distinct_targets(self):
        exam = ip.get_target("exam_deck_cover")
        scene = ip.get_target("deck_cover")
        assert exam.subject_kind != scene.subject_kind

    def test_subject_kind_points_at_the_keywords(self):
        # 主体必须从 subject.keywords（该本词数最多的几个场景名）长出来，
        # 否则 build_deck_covers.py 里那个 top_scenes 查询白写
        assert "keywords" in ip.get_target("exam_deck_cover").subject_kind

    def test_generic_exam_prep_imagery_is_forbidden(self):
        avoid = " ".join(ip.get_target("exam_deck_cover").extra_avoid).lower()
        for banned in ("study desk", "flashcard", "notebook", "textbook"):
            assert banned in avoid, f"{banned} 没进 extra_avoid"

    def test_same_geometry_as_the_scenario_cover(self):
        # 两者铺在同一块卡片上（.deck-cover 高度锁死 92px），画幅与安全区必须一致
        exam = ip.get_target("exam_deck_cover")
        scene = ip.get_target("deck_cover")
        assert exam.size == scene.size == ip.DECK_COVER_SIZE
        assert exam.safe_areas == scene.safe_areas
