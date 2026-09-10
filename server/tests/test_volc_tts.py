import base64
import json

import pytest

from domain.volc_tts import VOLC_VOICES, VolcTTSError, iter_ndjson_lines, parse_chunk


def _frame(**kwargs) -> bytes:
    return json.dumps(kwargs).encode()


def test_parse_chunk_audio_frame() -> None:
    audio = b"\xff\xf3audio-bytes"
    line = _frame(code=0, message="", data=base64.b64encode(audio).decode())
    assert parse_chunk(line) == (audio, False)


def test_parse_chunk_sentence_frame_no_audio() -> None:
    line = _frame(code=0, message="", data=None, sentence={"text": "hi", "words": []})
    assert parse_chunk(line) == (b"", False)


def test_parse_chunk_end_frame() -> None:
    line = _frame(code=20000000, message="ok", data=None)
    assert parse_chunk(line) == (b"", True)


def test_parse_chunk_error_code_raises() -> None:
    line = _frame(code=45000000, message="speaker permission denied")
    with pytest.raises(VolcTTSError, match="45000000"):
        parse_chunk(line)


def test_parse_chunk_invalid_json_raises() -> None:
    with pytest.raises(VolcTTSError, match="非 JSON"):
        parse_chunk(b"<html>bad gateway</html>")


def test_parse_chunk_invalid_base64_raises() -> None:
    with pytest.raises(VolcTTSError, match="base64"):
        parse_chunk(_frame(code=0, data="!!!not-base64!!!"))


async def test_iter_ndjson_lines_reassembles_split_chunks() -> None:
    lines = [_frame(code=0, data="QQ=="), _frame(code=0, data="Qg=="), _frame(code=20000000)]
    raw = b"\n".join(lines) + b"\n"
    # 故意在行中间切块，验证跨 chunk 重组；末段不带换行也要吐出
    pieces = [raw[:10], raw[10:45], raw[45:46], raw[46:-1], raw[-1:]]

    async def chunks():
        for piece in pieces:
            yield piece

    out = [line async for line in iter_ndjson_lines(chunks())]
    assert out == lines


async def test_iter_ndjson_lines_skips_blank_lines() -> None:
    async def chunks():
        yield b"\n\n" + _frame(code=0, data="QQ==") + b"\n\n" + _frame(code=20000000)

    out = [line async for line in iter_ndjson_lines(chunks())]
    assert out == [_frame(code=0, data="QQ=="), _frame(code=20000000)]


async def test_stream_assembly_end_to_end() -> None:
    """流水线联测：NDJSON 字节流 → 行 → 音频块，遇结束帧停止。"""
    a, b = b"seg-one", b"seg-two"
    raw = b"".join(
        [
            _frame(code=0, data=base64.b64encode(a).decode()) + b"\n",
            _frame(code=0, data=None, sentence={"text": "x"}) + b"\n",
            _frame(code=0, data=base64.b64encode(b).decode()) + b"\n",
            _frame(code=20000000, message="ok") + b"\n",
        ]
    )

    async def chunks():
        for i in range(0, len(raw), 17):  # 非行边界切块
            yield raw[i : i + 17]

    audio: list[bytes] = []
    async for line in iter_ndjson_lines(chunks()):
        segment, ended = parse_chunk(line)
        if segment:
            audio.append(segment)
        if ended:
            break
    assert audio == [a, b]


def test_voice_catalog_shape() -> None:
    assert 4 <= len(VOLC_VOICES) <= 6
    for v in VOLC_VOICES:
        assert v["id"].endswith("_uranus_bigtts")  # 2.0 uranus 系列
        assert v["locale"].startswith("en-")
        assert v["gender"] in ("Male", "Female")
        assert v["label"]
