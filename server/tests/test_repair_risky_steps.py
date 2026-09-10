"""修复代理的高危确认门（BR-25）。

这一层的错不会报异常：门漏了一个步骤，代理就自己把用户的学习记录删了，
界面上只显示「已重跑」。所以拦截清单与确认文案都要钉在单测里。

背景：`build_sentence_layer` 的第一句是 `delete(SubtitleSentence)`，而
`study_unit_state`（已学✓/收藏/旗标/听写成绩）与 `shadow_recording`
（录音 + AI 点评）都挂 ondelete=CASCADE，重建一次全没。重跑 scope 是
downstream，所以句层上游的 punctuate/align 同样会连带重建。
"""

from __future__ import annotations

import pytest

from domain.pipeline import STEP_BY_NAME
from domain.repair_agent import (
    COSTLY_STEPS,
    DESTRUCTIVE_STEPS,
    RISKY_STEPS,
    confirm_reason,
)


def test_destructive_steps_are_gated():
    """凡是会重建句层的步骤都必须在门内——漏一个就是静默删用户数据。"""
    for step in ("punctuate", "align", "sentences"):
        assert step in RISKY_STEPS, f"{step} 会重建句层，必须过确认门"


def test_costly_steps_still_gated():
    """原有的开销门不能因为加了破坏性门就丢掉。"""
    for step in ("download", "transcribe"):
        assert step in RISKY_STEPS


def test_risky_steps_are_real_pipeline_steps():
    """写错名字的话门形同虚设，且不会报错。"""
    for step in RISKY_STEPS:
        assert step in STEP_BY_NAME, f"{step} 不是管线步骤名"


def test_two_reason_kinds_do_not_overlap():
    assert not set(COSTLY_STEPS) & set(DESTRUCTIVE_STEPS)


def test_destructive_reason_names_what_is_lost():
    """确认卡必须说清会发生什么。拿「开销大」去描述重建句层，
    等于给了错的说明——比不说更坏。

    口径随 sentence_migration 上线改过一次：学习记录现在会尽量迁移，
    所以不能再说「无法恢复」（说重了同样是错的，用户会从此不敢调断句），
    但译文与词组确实会清空，门要留着。
    """
    reason = confirm_reason("sentences")
    for word in ("译文", "听懂了", "跟读录音", "问题清单"):
        assert word in reason, f"确认文案没提到「{word}」：{reason}"
    assert "开销" not in reason
    # 迁移已就位，别再吓唬用户说全丢
    assert "无法恢复" not in reason


def test_costly_reason_talks_about_cost():
    reason = confirm_reason("transcribe")
    assert "开销" in reason
    assert "跟读录音" not in reason


@pytest.mark.parametrize("step", RISKY_STEPS)
def test_every_risky_step_has_a_reason(step: str):
    reason = confirm_reason(step)
    assert reason.strip() != ""
    assert STEP_BY_NAME[step].label in reason
