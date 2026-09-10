"""应用注册表的守卫测试（模块 16 FR-427）。

这里测的不是「代码能不能跑」，是几条**会静默出错**的约束：注册表指向了不存在的
用途、worker 的导入链看不到新用途、锁定参数被写错。它们都不抛异常，只会在真正
下单之后炸在后台——网页上能下单、任务却失败，这种不对称最难查。
"""

from __future__ import annotations

import importlib
import subprocess
import sys
from pathlib import Path

import pytest

from domain import image_apps, image_defaults, image_prompts, image_sizes


def test_every_app_target_exists() -> None:
    """应用指向的用途必须都注册过。写错一个字母只在下单时才炸。"""
    for app in image_apps.APPS.values():
        assert app.target_key in image_prompts.TARGETS, f"{app.key} 指向了不存在的用途"


def test_every_locked_ratio_is_known() -> None:
    for app in image_apps.APPS.values():
        if app.ratio is not None:
            assert app.ratio in image_sizes.RATIOS, f"{app.key} 锁了不认识的比例"


def test_locked_ratio_matches_target_size() -> None:
    """锁定比例要和用途自己的画幅对得上，否则「锁比例」等于悄悄改画幅。"""
    for app in image_apps.APPS.values():
        if app.ratio is None:
            continue
        expected = image_sizes.nearest_ratio(app.target.size)
        assert app.ratio == expected, (
            f"{app.key} 锁 {app.ratio}，但用途尺寸 {app.target.size} 最接近 {expected}"
        )


def test_learning_apps_lock_their_ratio() -> None:
    """学习资产的画幅由展示它的那块 UI 决定，不是用户偏好（FR-432）。"""
    for app in image_apps.APPS.values():
        if app.category == "learning":
            assert app.ratio is not None, f"{app.key} 是学习资产，必须锁比例"


def test_free_form_apps_do_not_default_to_an_illustration_style() -> None:
    """自由出图那一支不该被平台替用户选画风。

    这些格子的画面完全由用户那句话决定。预设画风等于替他做了个他没做的选择——
    表现是「文生图出来的全是柔和扁平插画」，而界面上找不到原因。
    """
    for app in image_apps.APPS.values():
        if app.target_key != "free" or app.style_key is not None:
            continue
        assert app.target.default_style == image_prompts.NO_STYLE_KEY, (
            f"{app.key} 走自由出图却预设了画风 {app.target.default_style}"
        )


def test_learning_apps_keep_a_real_style() -> None:
    """反向守：学习资产要摆在同一个列表里，画风必须统一，不能被顺手改成不指定。"""
    for app in image_apps.APPS.values():
        if app.category != "learning":
            continue
        preset = image_prompts.STYLE_PRESETS[app.style_key or app.target.default_style]
        assert preset.render, f"{app.key} 是学习资产却没有画风"


def test_portrait_apps_lock_high_fidelity() -> None:
    """低保真档会把脸重画成另一个人，这条是人像能不能用的分水岭（BR-121）。"""
    for app in image_apps.APPS.values():
        if app.category == "portrait":
            assert app.fixed.get("input_fidelity") == "high", f"{app.key} 没锁高保真"


def test_consistency_edit_locks_high_fidelity() -> None:
    app = image_apps.get_app("consistent_edit")
    assert app.engine == "edit"
    assert app.fixed.get("input_fidelity") == "high"


def test_consistency_edit_wraps_user_change_without_rewriting_other_apps() -> None:
    request = "只把表情改成微笑"
    prompt = image_apps.prepare_edit_prompt(
        image_apps.get_app("consistent_edit"), request
    )
    assert "Preserve identity" in prompt
    assert prompt.endswith(request)
    assert image_apps.prepare_edit_prompt(
        image_apps.get_app("image_to_image"), request
    ) == request


def test_mask_apps_take_an_image() -> None:
    for app in image_apps.APPS.values():
        if app.needs_mask:
            assert app.needs_image, f"{app.key} 要蒙版却不收图"


def test_only_local_engine_is_free() -> None:
    for app in image_apps.APPS.values():
        assert app.costs_money == (app.engine != "local")


def test_app_view_groups_categories_and_puts_learning_first() -> None:
    view = image_apps.app_view()
    assert len(view) == len(image_apps.APPS)
    order = [row["category"] for row in view]
    # 分类必须成段出现不能交错——选择器左栏靠这个分组
    first_seen = {c: order.index(c) for c in dict.fromkeys(order)}
    assert order == sorted(order, key=lambda c: first_seen[c])
    assert view[0]["category"] == "learning", "学习资产要排第一，这是本平台的主场景"


def test_worker_import_path_sees_every_app_target() -> None:
    """worker 经 `image_pipeline` 进来，必须能看到全部用途。

    用途是在 `image_apps` 导入时注册进 `TARGETS` 的。worker 不导入那个模块的话，
    API 进程一切正常而后台任务会报「未知生图用途」。这里开一个干净的子进程复刻
    worker 的导入顺序，别让这条依赖再悄悄断掉。
    """
    code = (
        "import worker.tasks;"
        "from domain.image_pipeline import DOMAIN;"  # worker 里就是这么导的
        "from domain.image_prompts import TARGETS;"
        "print(','.join(sorted(TARGETS)))"
    )
    root = Path(__file__).resolve().parents[1]
    out = subprocess.run(
        [sys.executable, "-c", code], cwd=root, capture_output=True, text=True, timeout=180
    )
    assert out.returncode == 0, out.stderr[-800:]
    seen = set(out.stdout.strip().splitlines()[-1].split(","))
    missing = {a.target_key for a in image_apps.APPS.values()} - seen
    assert not missing, f"worker 的导入链看不到这些用途：{sorted(missing)}"


def test_registering_an_app_needs_no_other_change() -> None:
    """AC-109：加应用只加一条记录。这里真加一条，再看它有没有出现在目录里。"""
    image_prompts.register_target(
        image_prompts.ImageTarget(
            key="_probe_target",
            label="探针用途",
            goal="a probe",
            size="1024x1024",
            sizes=("1024x1024",),
        )
    )
    image_apps.register_app(
        image_apps.ImageApp(
            key="_probe_app", label="探针应用", category="create", engine="generate",
            target_key="_probe_target", hint="只在测试里存在",
        )
    )
    try:
        assert "_probe_app" in [row["key"] for row in image_apps.app_view()]
        assert image_apps.get_app("_probe_app").label == "探针应用"
    finally:
        image_apps.APPS.pop("_probe_app", None)
        image_prompts.TARGETS.pop("_probe_target", None)


def test_bad_app_definition_fails_loudly() -> None:
    for kwargs in (
        {"engine": "teleport"},
        {"category": "nowhere"},
        {"inputs": ("prompt", "telepathy")},
    ):
        base = dict(
            key="_bad", label="坏应用", category="create", engine="generate",
            target_key="free", hint="",
        )
        base.update(kwargs)
        with pytest.raises(ValueError):
            image_apps.ImageApp(**base)  # type: ignore[arg-type]


def test_unknown_app_raises_a_readable_error() -> None:
    with pytest.raises(image_prompts.PromptError) as exc:
        image_apps.get_app("no_such_app")
    assert "no_such_app" in str(exc.value)


def test_module_reimport_is_idempotent() -> None:
    """重复导入不该把用途注册两遍或改变数量。"""
    before = len(image_prompts.TARGETS)
    importlib.reload(image_apps)
    assert len(image_prompts.TARGETS) == before


def test_batch_max_n_matches_imagegen() -> None:
    """`image_batch` 为了不拖 openai 依赖链自己写了一份 MAX_N，两处必须一致。

    不一致的后果是：策划台放出 5 张的选项，真下单时被 `render_images` 拒。
    这条测试就是那份重复常量的看门人。
    """
    from domain import image_batch, imagegen

    assert image_batch.MAX_N == imagegen.MAX_N, (
        f"image_batch.MAX_N={image_batch.MAX_N} 与 imagegen.MAX_N={imagegen.MAX_N} 对不上"
    )


def test_usage_carries_latency() -> None:
    """耗时要跟着资产落库，否则资产详情里永远显示不出「画了多久」。"""
    from domain.imagegen import RenderResult, usage_with_latency

    merged = usage_with_latency(
        RenderResult(images=[b""], usage={"total_tokens": 12}, latency_ms=8300)
    )
    assert merged == {"total_tokens": 12, "latency_ms": 8300}
    # 上游没给 usage 也要留下耗时
    assert usage_with_latency(RenderResult(images=[b""], latency_ms=500)) == {"latency_ms": 500}
    # 两者都没有就别写一个空壳进去
    assert usage_with_latency(RenderResult(images=[b""])) is None


class TestNodeParamPrecedence:
    """节点参数的取值优先级：**重跑覆盖 > 主体上存的用户选择 > Tunable 默认值**。

    中间那一层曾经漏掉过，而且两边都不报错：`image_job` 行里存的是用户在控制台选的
    尺寸与风格，但取值走的是 `cfg()`，Tunable 的静态默认排在主体之前——于是任务行里
    是 4K 16:9 + 剪影摄影风，实际出的却是 1994x789 的柔和扁平插画。
    实测复现过一次，这组测试就是那次的看门人。
    """

    def _recorder(self, overrides: dict | None = None):
        from domain import image_pipeline
        from domain.pipeline import PipelineRecorder

        # spec 是按 domain 派生的只读属性，所以走真实构造；这里不写库，
        # session_factory 给个占位就行
        return PipelineRecorder(
            run_id=0,
            subject_id=0,
            session_factory=None,
            config_override=overrides,
            domain=image_pipeline.DOMAIN,
        )

    def test_stored_choice_beats_tunable_default(self) -> None:
        recorder = self._recorder()
        assert recorder.chosen("prompt", "size", "3840x2160") == "3840x2160"
        assert recorder.chosen("prompt", "style", "photo-silhouette") == "photo-silhouette"
        assert recorder.chosen("render", "quality", "high") == "high"
        assert recorder.chosen("render", "n", 3) == 3

    def test_falls_back_to_tunable_default_when_nothing_stored(self) -> None:
        recorder = self._recorder()
        # 比的是「回落到 Tunable 默认」这条链路，不是某个具体档位——
        # 写死字面量的话，改一次全局默认就要来改一次这条与它无关的测试。
        # size 那条原来就写死着 "1536x608"，于是改默认值时它是唯一挡路的东西。
        assert recorder.chosen("prompt", "size", None) == _tunable_default("prompt", "size")
        assert recorder.chosen("render", "quality", None) == image_defaults.FALLBACK_QUALITY

    def test_size_default_is_empty_so_the_brief_can_pick_an_aspect(self) -> None:
        """尺寸的 Tunable 默认必须留空。

        非空的话 `pinned_size` 恒为真，`aspects=None if pinned_size else …`
        就把立意挑画幅那条路整个堵死——而代码注释与需求文档都把"不指定时
        由立意按画面内容挑"当既定行为。实测后果：所有没显式选尺寸的图
        都被按 2.53:1 超宽幅构图（那个数当初是给单词卡横幅调的）。
        """
        assert _tunable_default("prompt", "size") == ""

    def test_rerun_override_beats_everything(self) -> None:
        recorder = self._recorder({"prompt": {"size": "1024x1024"}})
        assert recorder.chosen("prompt", "size", "3840x2160") == "1024x1024"

    def test_blank_override_is_not_an_override(self) -> None:
        """重跑表单里留空 = 不覆盖，不能当成「显式选了空字符串」。"""
        recorder = self._recorder({"prompt": {"size": ""}})
        assert recorder.chosen("prompt", "size", "3840x2160") == "3840x2160"

    def test_cfg_keeps_its_old_semantics(self) -> None:
        """`cfg()` 给主体上没有该参数的域用（视频域），行为不能被这次改动带偏。

        差别就在中间那一层：`cfg` 里 Tunable 默认排在调用方给的值**之前**，
        所以哪怕调用方传了 3840x2160，拿到的仍是 Tunable 声明的那个默认。
        """
        recorder = self._recorder()
        assert recorder.cfg("prompt", "size", "3840x2160") == _tunable_default("prompt", "size")
        assert recorder.cfg("prompt", "size", "3840x2160") != "3840x2160"

    def test_image_pipeline_reads_params_through_chosen(self) -> None:
        """源码级不变式：生图管线取参数一律走 chosen，别有人改回 cfg。"""
        from pathlib import Path

        source = (
            Path(__file__).resolve().parents[1] / "domain" / "image_pipeline.py"
        ).read_text(encoding="utf-8")
        for key in ('"style"', '"size"', '"quality"', '"n"', '"idea"', '"prompt"'):
            assert f'recorder.cfg("prompt", {key}' not in source
            assert f'recorder.cfg("render", {key}' not in source
            assert f'recorder.cfg("brief", {key}' not in source


def _tunable_default(step: str, key: str) -> object:
    """从 IMAGE_STEPS 里读某个 Tunable 声明的默认值。

    测试里再抄一份字面量的话，改默认值要同时改两处，而漏改的那一处
    会以"断言失败"的形式挡住一个正当的改动（这条测试就发生过）。
    """
    from domain.image_pipeline import IMAGE_STEPS

    for spec in IMAGE_STEPS:
        if spec.name != step:
            continue
        for tunable in spec.tunables:
            if tunable.name == key:
                return tunable.default
    raise AssertionError(f"IMAGE_STEPS 里没有 {step}.{key}")
