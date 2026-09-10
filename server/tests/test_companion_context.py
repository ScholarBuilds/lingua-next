"""陪读上下文单测：全文直用 / 超长截断（窗口 + 首尾摘要），纯函数不触库。"""

from domain.companion import (
    MAX_CONTEXT_CHARS,
    TRUNCATE_MARK,
    assemble_context,
    build_companion_realtime_role,
    build_companion_system_prompt,
)


def test_short_article_no_truncation() -> None:
    paragraphs = [(0, "First paragraph."), (1, "Second paragraph.")]
    content, truncated = assemble_context(paragraphs)
    assert truncated is False
    assert content == "First paragraph.\n\nSecond paragraph."


def test_long_article_truncated_with_window() -> None:
    # 40 段 × 400 字符 = 16000 > 8000，必然截断
    paragraphs = [(i, f"P{i:02d} " + "x" * 400) for i in range(40)]
    content, truncated = assemble_context(paragraphs, paragraph_ordinal=20)
    assert truncated is True
    assert TRUNCATE_MARK in content
    assert "P20" in content  # 当前段落必须在窗口里
    assert "[文章开头]" in content and "P00" in content
    assert "[文章结尾]" in content and "P39" in content
    # 拼出的上下文应控制在上限之内（窗口 + 首尾 + 标记）
    assert len(content) < MAX_CONTEXT_CHARS


def test_window_at_article_head_skips_head_summary() -> None:
    paragraphs = [(i, f"P{i:02d} " + "y" * 400) for i in range(40)]
    content, truncated = assemble_context(paragraphs, paragraph_ordinal=0)
    assert truncated is True
    # 窗口顶到文章开头时不再重复输出开头摘要
    assert "[文章开头]" not in content
    assert "P00" in content
    assert "[文章结尾]" in content


def test_unknown_ordinal_falls_back_to_head() -> None:
    paragraphs = [(i, f"P{i:02d} " + "z" * 400) for i in range(40)]
    content, truncated = assemble_context(paragraphs, paragraph_ordinal=999)
    assert truncated is True
    assert "P00" in content  # 找不到指定段落时从开头展开


def test_companion_prompts() -> None:
    prompt = build_companion_system_prompt("Chapter I.", "It is a truth...", False)
    assert "英语私教" in prompt
    assert "Chapter I." in prompt
    assert "It is a truth..." in prompt
    assert "中文" in prompt
    truncated_prompt = build_companion_system_prompt("T", "C", True)
    assert "节选" in truncated_prompt
    realtime_role = build_companion_realtime_role("T", "C", False)
    assert "口语化" in realtime_role and "英语私教" in realtime_role
