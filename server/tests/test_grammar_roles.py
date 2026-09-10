"""语法成分角色枚举：Python 与 TypeScript 两处必须一致。

prompt 里限定模型只能吐这八个角色，前端按同一套枚举上色。两处各写一份，
改一处漏一处的话，模型吐出来的新角色在前端会落到「其他」（灰色），
而且不会报任何错——这类静默失配只能靠测试守。
"""

import re
from pathlib import Path

from domain.llm import GRAMMAR_ROLES

ROLE_TS = (
    Path(__file__).resolve().parents[2] / "web/src/features/reader/grammarRole.ts"
)


def _ts_roles() -> list[str]:
    src = ROLE_TS.read_text(encoding="utf-8")
    block = re.search(r"export const GRAM_ROLES = \[(.*?)\] as const", src, re.S)
    assert block is not None, "grammarRole.ts 里找不到 GRAM_ROLES 定义"
    return re.findall(r"'([^']+)'", block.group(1))


def test_ts_role_file_exists() -> None:
    assert ROLE_TS.exists(), f"前端角色表不在预期位置：{ROLE_TS}"


def test_enum_matches_frontend() -> None:
    ts = _ts_roles()
    # 前端多一个「其他」作兜底桶，模型不该主动吐它，所以 prompt 侧不列
    assert ts[-1] == "其他", "前端枚举最后一项应是兜底的「其他」"
    assert list(GRAMMAR_ROLES) == ts[:-1]


def test_prompt_lists_every_role() -> None:
    from domain.llm import grammar_prompt

    system, _ = grammar_prompt("He rode a horse.")
    for role in GRAMMAR_ROLES:
        assert role in system, f"prompt 里没列出角色 {role}"
