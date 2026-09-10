import pytest

from domain.imports import (
    ScannedPdfError,
    parse_md,
    parse_pdf,
    parse_txt,
    parse_wordlist,
    pdf_page_paragraphs,
)

# ---------------------------------------------------------------- txt


def test_parse_txt_chapters_and_paragraphs() -> None:
    text = (
        "Front matter intro.\n\n"
        "Chapter 1 The Beginning\n\n"
        "First paragraph line one.\nstill first paragraph.\n\n"
        "Second paragraph.\n\n"
        "第二章 转折\n\n"
        "中文段落一。\n\n"
        "中文段落二。\n"
    )
    book = parse_txt(text, "fallback")
    titles = [c.title for c in book.chapters]
    assert titles == ["fallback", "Chapter 1 The Beginning", "第二章 转折"]
    ch1 = book.chapters[1]
    assert ch1.paragraphs[0].kind == "heading"
    assert [p.text for p in ch1.paragraphs[1:]] == [
        "First paragraph line one. still first paragraph.",
        "Second paragraph.",
    ]
    assert [p.text for p in book.chapters[2].paragraphs[1:]] == ["中文段落一。", "中文段落二。"]


def test_parse_txt_single_newline_fallback() -> None:
    # 整体无空行：单换行即分段
    book = parse_txt("Para one.\nPara two.\nPara three.", "t")
    assert len(book.chapters) == 1
    assert [p.text for p in book.chapters[0].paragraphs] == [
        "Para one.",
        "Para two.",
        "Para three.",
    ]


def test_parse_txt_long_single_chapter_chunked() -> None:
    text = "\n\n".join(f"Paragraph number {i}." for i in range(450))
    book = parse_txt(text, "big")
    assert len(book.chapters) == 3  # 450 段 → 200/200/50
    assert [len(c.paragraphs) for c in book.chapters] == [200, 200, 50]
    assert book.chapters[0].title == "big · Part 1"


# ---------------------------------------------------------------- markdown


def test_parse_md_chapters_and_inline_strip() -> None:
    text = (
        "# My Doc\n\n"
        "Intro with **bold**, *italic* and [a link](https://x.com) plus `code`.\n\n"
        "## Section Two\n\n"
        "### Subsection\n\n"
        "Content of section two.\n\n"
        "- item **one**\n"
        "- item two\n\n"
        "> a famous quote\n"
    )
    book = parse_md(text, "fb")
    assert [c.title for c in book.chapters] == ["My Doc", "Section Two"]
    ch1 = book.chapters[0]
    assert ch1.paragraphs[1].text == "Intro with bold, italic and a link plus code."
    ch2 = book.chapters[1]
    kinds = [(p.kind, p.text) for p in ch2.paragraphs]
    assert ("heading", "Subsection") in kinds
    assert ("text", "item one") in kinds
    assert ("text", "item two") in kinds
    assert ("quote", "a famous quote") in kinds


def test_parse_md_code_fence_preserved() -> None:
    text = "# T\n\nBefore.\n\n```python\nprint('hi')  # **not bold**\n```\n\nAfter.\n"
    book = parse_md(text, "fb")
    paras = book.chapters[0].paragraphs
    code = [p for p in paras if p.kind == "code"]
    assert len(code) == 1
    assert code[0].text == "print('hi')  # **not bold**"  # 围栏内不做语法剥离
    assert [p.text for p in paras if p.kind == "text"] == ["Before.", "After."]


def test_parse_md_no_heading_falls_back() -> None:
    book = parse_md("Just a paragraph.\n\nAnother one.\n", "fallback")
    assert len(book.chapters) == 1
    assert book.chapters[0].title == "fallback"
    assert len(book.chapters[0].paragraphs) == 2


# ---------------------------------------------------------------- pdf


def test_pdf_page_paragraphs_heuristics() -> None:
    page = (
        "First paragraph line one\n"
        "continues on second line.\n"
        "\n"
        "Second paragraph after blank line with hy-\n"
        "phenated word joined.\n"
        "   Indented line starts third paragraph\n"
        "and continues.\n"
    )
    paras = pdf_page_paragraphs(page)
    assert [p.text for p in paras] == [
        "First paragraph line one continues on second line.",
        "Second paragraph after blank line with hyphenated word joined.",
        "Indented line starts third paragraph and continues.",
    ]


def _minimal_pdf(lines: list[str], with_text: bool = True) -> bytes:
    """手工构造单页 PDF（Helvetica + Tj），供 pypdf 抽取文本层。"""
    content = b""
    if with_text and lines:
        parts = [b"BT /F1 12 Tf 72 720 Td"]
        for i, line in enumerate(lines):
            if i:
                parts.append(b"0 -16 Td")
            parts.append(b"(" + line.encode("latin-1") + b") Tj")
        parts.append(b"ET")
        content = b" ".join(parts)
    objs = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] "
        b"/Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
        b"<< /Length " + str(len(content)).encode() + b" >>\nstream\n" + content + b"\nendstream",
    ]
    out = b"%PDF-1.4\n"
    offsets = []
    for i, obj in enumerate(objs, start=1):
        offsets.append(len(out))
        out += f"{i} 0 obj\n".encode() + obj + b"\nendobj\n"
    xref_pos = len(out)
    out += b"xref\n0 " + str(len(objs) + 1).encode() + b"\n0000000000 65535 f \n"
    for off in offsets:
        out += f"{off:010d} 00000 n \n".encode()
    out += (
        b"trailer\n<< /Size " + str(len(objs) + 1).encode() + b" /Root 1 0 R >>\n"
        b"startxref\n" + str(xref_pos).encode() + b"\n%%EOF\n"
    )
    return out


def test_parse_pdf_text_layer(tmp_path) -> None:
    path = tmp_path / "sample.pdf"
    path.write_bytes(_minimal_pdf(["Hello world from a pdf.", "Second line of text."]))
    book = parse_pdf(path, "sample")
    assert book.title == "sample"
    text = " ".join(p.text for c in book.chapters for p in c.paragraphs)
    assert "Hello world from a pdf." in text
    assert "Second line of text." in text


def test_parse_pdf_scanned_raises(tmp_path) -> None:
    path = tmp_path / "scan.pdf"
    path.write_bytes(_minimal_pdf([], with_text=False))
    with pytest.raises(ScannedPdfError, match="扫描版 PDF"):
        parse_pdf(path, "scan")


# ---------------------------------------------------------------- 词表解析


def test_parse_wordlist_csv_header_dup_invalid() -> None:
    content = "word,translation\napple,苹果\nBanana,\napple,重复\n,空词\ncherry,樱桃\n"
    items, dup, invalid = parse_wordlist(content, "csv")
    assert items == [("apple", "苹果"), ("banana", None), ("cherry", "樱桃")]
    assert dup == 1
    assert len(invalid) == 1
    assert invalid[0]["reason"].startswith("空词条")


def test_parse_wordlist_tsv() -> None:
    items, dup, invalid = parse_wordlist("alpha\t希腊字母\nbeta\n", "tsv")
    assert items == [("alpha", "希腊字母"), ("beta", None)]
    assert (dup, invalid) == (0, [])


def test_parse_wordlist_json_objects_and_strings() -> None:
    content = '[{"word": "Apple", "translation": "苹果"}, "banana", {"word": ""}, 42]'
    items, dup, invalid = parse_wordlist(content, "json")
    assert items == [("apple", "苹果"), ("banana", None)]
    assert dup == 0
    assert [e["line"] for e in invalid] == [3, 4]


def test_parse_wordlist_bad_json_raises() -> None:
    with pytest.raises(ValueError, match="JSON"):
        parse_wordlist("not json at all", "json")
    with pytest.raises(ValueError, match="数组"):
        parse_wordlist('{"word": "a"}', "json")


def test_parse_wordlist_word_too_long() -> None:
    items, dup, invalid = parse_wordlist("a" * 200 + ",x\nok,好\n", "csv")
    assert items == [("ok", "好")]
    assert invalid[0]["reason"].startswith("词条超长")
