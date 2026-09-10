"""管线节点图、重跑范围与体检门禁的纯函数覆盖（需求 09 v6）。"""

import pytest

from domain.pipeline import (
    ENRICH_STEP_NAMES,
    PIPELINE_VERSION,
    STEP_BY_NAME,
    STEP_ORDER,
    STEPS,
    PipelineRecorder,
    catalog,
    descendants,
    resolve_scope,
)
from domain.pipeline_health import gate_status
from domain.subtitle_review import _clean


def test_dag_is_acyclic_and_fully_connected() -> None:
    """每个节点的依赖都得先于它出现，否则重跑范围算出来就是错的。"""
    for spec in STEPS:
        for dep in spec.depends_on:
            assert dep in STEP_BY_NAME, f"{spec.name} 依赖了不存在的 {dep}"
            assert STEP_ORDER[dep] < STEP_ORDER[spec.name], f"{spec.name} 依赖了后置的 {dep}"
    # 除起点外都要有上游，孤立节点画不进 DAG
    roots = [s.name for s in STEPS if not s.depends_on]
    assert roots == ["download"]


def test_descendants_covers_transitive_downstream() -> None:
    downstream = descendants("transcribe")
    assert "punctuate" in downstream and "align" in downstream
    assert "sentences" in downstream and "translate" in downstream
    assert set(ENRICH_STEP_NAMES).issubset(downstream)
    assert "verify" in downstream
    # 上游不该被算进去
    assert "download" not in downstream and "transcribe" not in downstream


def test_descendants_of_leaf_is_empty() -> None:
    assert descendants("verify") == []


def test_resolve_scope_single_vs_downstream() -> None:
    """single 只跑本节点，downstream 连同全部下游——语义弄反会白跑几十分钟转写。"""
    assert resolve_scope("sentences", "single") == ["sentences"]
    got = resolve_scope("sentences", "downstream")
    assert got[0] == "sentences"
    assert "translate" in got and "verify" in got
    assert "transcribe" not in got  # 不该往上游跑


def test_resolve_scope_failed_unions_each_failure_subtree() -> None:
    got = resolve_scope("", "failed", ["punctuate", "enrich.vocab"])
    assert "punctuate" in got and "align" in got  # punctuate 的下游
    assert "enrich.vocab" in got and "verify" in got
    assert "download" not in got
    # 结果按管线顺序，执行顺序才不会乱
    assert got == sorted(got, key=lambda n: STEP_ORDER[n])


def test_resolve_scope_failed_with_nothing_failed() -> None:
    assert resolve_scope("", "failed", []) == []


def test_catalog_exposes_tunables_for_the_steps_users_tweak() -> None:
    by_name = {c["name"]: c for c in catalog()}
    assert {t["name"] for t in by_name["transcribe"]["tunables"]} >= {"whisper_model"}
    assert {t["name"] for t in by_name["sentences"]["tunables"]} >= {
        "max_unit_s", "max_unit_chars",
    }
    assert {t["name"] for t in by_name["translate"]["tunables"]} >= {"engine", "refresh"}


def test_recorder_cfg_prefers_override_then_default() -> None:
    rec = PipelineRecorder(1, 1, None, {"sentences": {"max_unit_s": 3.5}})
    assert rec.cfg("sentences", "max_unit_s") == 3.5
    # 没覆盖时落到 Tunable 默认值
    assert rec.cfg("sentences", "max_unit_chars") == 84
    # 空串视为没填，不能把默认值冲掉
    rec2 = PipelineRecorder(1, 1, None, {"transcribe": {"whisper_model": ""}})
    assert rec2.cfg("transcribe", "whisper_model", "fallback") == "fallback"


def test_gate_blocks_on_error_and_on_empty_sentences() -> None:
    """v6 触发故障的直接放行者就是"跑完即 ready"，这条断言守住新判据。"""
    assert gate_status({"sentences": 10}, []) == "ready"
    assert gate_status({"sentences": 0}, []) == "degraded"
    assert (
        gate_status({"sentences": 10}, [{"level": "error", "message": "译文缺"}]) == "degraded"
    )
    # warn / info 不拦
    assert gate_status({"sentences": 10}, [{"level": "warn", "message": "对齐降级"}]) == "ready"


@pytest.mark.parametrize(
    "raw",
    [None, "not a list", [{"ordinal": 1}], [{"kind": "wrong_word", "detail": "x"}]],
)
def test_review_clean_rejects_malformed(raw: object) -> None:
    assert _clean(raw, {1, 2}) == []


def test_review_clean_drops_hallucinated_ordinals() -> None:
    """裁判爱编句号，落到送审范围外的一律丢掉，否则采纳会改错句子。"""
    items = [
        {"ordinal": 1, "kind": "wrong_word", "detail": "听错", "suggestion": "Except."},
        {"ordinal": 99, "kind": "wrong_word", "detail": "越界", "suggestion": "x"},
        {"ordinal": 2, "kind": "made_up_kind", "detail": "野类型"},
    ]
    got = _clean(items, {1, 2})
    assert [i["ordinal"] for i in got] == [1]
    assert got[0]["severity"] == "warn"  # 缺省补 warn
    assert got[0]["suggestion"] == "Except."


def test_pipeline_version_is_set() -> None:
    assert PIPELINE_VERSION and PIPELINE_VERSION[0].isdigit()


def test_single_scope_only_where_it_does_not_wreck_downstream() -> None:
    """重建句层会把挂在句上的译文与词组一起清掉，这类节点不能只跑一步（实测踩过）。"""
    for name in ("transcribe", "punctuate", "align", "sentences", "translate"):
        assert STEP_BY_NAME[name].single_ok is False, f"{name} 不该允许 single"
    for name in (*ENRICH_STEP_NAMES, "verify"):
        assert STEP_BY_NAME[name].single_ok is True, f"{name} 应允许 single"


def test_rebuild_units_placeholder_ordinals_are_unique() -> None:
    """占位序号若不唯一，autoflush 会撞 uq_study_unit_pos（实测踩过）。"""
    ids = [-(2179 * 100 + i + 1) for i in range(8)] + [-(2180 * 100 + i + 1) for i in range(8)]
    assert len(ids) == len(set(ids))
    assert all(i < 0 for i in ids)


def test_locate_tolerates_rewritten_punctuation() -> None:
    """修复代理常引用自己改写过标点/大小写的文本，定位必须按词序列兜底（实测踩过）。"""
    from domain.sentence_ops import _locate

    text = "we were going to do a little and that means that in every room there were children"
    # 代理引用的是加了标点大写的版本
    assert _locate(text, "And that means that in every room,") == text.index("and that means")
    # 精确子串仍然直接命中
    assert _locate(text, "every room") == text.index("every room")
    # 找不到返回 None 而不是乱切
    assert _locate(text, "completely different words here") is None
