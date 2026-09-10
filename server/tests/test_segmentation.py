from domain.segmentation import split_sentences, tokenize


def test_split_handles_abbreviations() -> None:
    text = "Mr. Bennet replied that he had not. But it is, returned she."
    spans = split_sentences(text)
    assert len(spans) == 2
    assert text[spans[0][0] : spans[0][1]] == "Mr. Bennet replied that he had not."


def test_tokenize_offsets_and_apostrophe() -> None:
    text = "It's a truth universally acknowledged."
    tokens = tokenize(text)
    surfaces = [t[2] for t in tokens]
    assert surfaces == ["it's", "a", "truth", "universally", "acknowledged"]
    start, end = tokens[3][0], tokens[3][1]
    assert text[start:end] == "universally"


def test_utf16_offsets_with_astral_chars() -> None:
    # 增补平面字符（emoji）占 2 个 UTF-16 码元，后续词偏移必须右移
    text = "wow 😀 great"
    tokens = tokenize(text)
    great = tokens[-1]
    # JS 口径："wow "=4, emoji=2, " "=1 → great 从 7 开始
    assert great[0] == 7 and great[2] == "great"


def test_short_paragraph_preserved() -> None:
    assert split_sentences("In vain.") == [(0, 8)]
