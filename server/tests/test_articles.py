import pytest

from domain.articles import ExtractError, extract_html_article, split_plain_text

ARTICLE_HTML = """
<!doctype html>
<html>
<head><title>How to Do Great Work</title></head>
<body>
<nav><a href="/">Home</a><a href="/about">About</a></nav>
<article>
<h1>How to Do Great Work</h1>
<p>If you collected lists of techniques for doing great work in a lot of different
fields, what would the intersection look like? I decided to find out by making it.</p>
<p>Partly my goal was to create a guide that could be used by someone working in any
field. But I was also curious about the shape of the intersection. And one thing this
exercise shows is that it does have a definite shape; it is not just a point.</p>
<p>The first step is to decide what to work on. The work you choose needs to have
three qualities: it has to be something you have a natural aptitude for, that you have
a deep interest in, and that offers scope to do great work.</p>
</article>
<footer>Copyright 2023</footer>
</body>
</html>
"""

EMPTY_HTML = "<html><body><nav><a href='/'>Home</a></nav><script>var x=1;</script></body></html>"


def test_extract_html_article() -> None:
    title, text = extract_html_article(ARTICLE_HTML, url="https://example.com/greatwork")
    assert title == "How to Do Great Work"
    assert "intersection look like" in text
    assert "natural aptitude" in text
    # 导航与页脚噪音不进正文
    assert "Copyright" not in text
    assert "Home" not in text


def test_extract_html_article_empty_raises() -> None:
    with pytest.raises(ExtractError):
        extract_html_article(EMPTY_HTML)


BR_HTML = """
<html><head><title>Essay</title></head><body><table><tr><td>
<font size="2">July 2023<br><br>If you collected lists of techniques for doing great
work in a lot of different fields, what would the intersection look like? I decided
to find out by making it.<br><br>Partly my goal was to create a guide that could be
used by someone working in any field. The <br> single line break stays inline.
</font></td></tr></table></body></html>
"""


def test_extract_html_article_br_paragraphs() -> None:
    # 老式 <br><br> 分段页面（paulgraham.com 式）：双 br 还原为空行，单 br 不拆段
    _title, text = extract_html_article(BR_HTML)
    paragraphs = text.split("\n\n")
    assert len(paragraphs) == 3
    assert paragraphs[0].strip() == "July 2023"
    assert "intersection look like" in paragraphs[1]
    assert "single line break stays inline" in paragraphs[2]


def test_split_plain_text_blank_lines() -> None:
    text = "First paragraph line one.\nStill first paragraph.\n\nSecond paragraph.\n\n\nThird."
    paragraphs = split_plain_text(text)
    assert [p.text for p in paragraphs] == [
        "First paragraph line one. Still first paragraph.",
        "Second paragraph.",
        "Third.",
    ]
    assert all(p.kind == "text" for p in paragraphs)


def test_split_plain_text_single_newline_fallback() -> None:
    # trafilatura txt 输出块间只有单换行：整体无空行时按行切
    text = "Paragraph one.\nParagraph two.\nParagraph three."
    assert [p.text for p in split_plain_text(text)] == [
        "Paragraph one.",
        "Paragraph two.",
        "Paragraph three.",
    ]


def test_split_plain_text_windows_newlines_and_blank() -> None:
    assert [p.text for p in split_plain_text("A one.\r\n\r\nB two.")] == ["A one.", "B two."]
    assert split_plain_text("   \n\n  ") == []


async def test_article_list_uses_sqlite_json_functions(client) -> None:
    created = await client.post(
        "/articles",
        json={"kind": "paste", "title": "Desktop article", "text": "One two three."},
    )
    assert created.status_code == 201

    response = await client.get("/articles")

    assert response.status_code == 200
    assert response.json()[0]["title"] == "Desktop article"
    assert response.json()[0]["word_count"] == 3
