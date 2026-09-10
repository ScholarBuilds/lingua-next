def _needs_space(left: str, right: str) -> bool:
    return bool(left) and bool(right) and left[-1].isascii() and right[0].isascii()


def _join_segments(parts: list[str]) -> str:
    out = ""
    for part in parts:
        if not part:
            continue
        out = f"{out} {part}" if _needs_space(out, part) else out + part
    return out.strip()


class UtteranceCollector:
    """拼接 ASR 终稿，并用最新中间稿补齐显示文本。"""

    def __init__(self) -> None:
        self._finals: list[str] = []
        self._partial = ""

    def on_partial(self, text: str) -> None:
        self._partial = text.strip()

    def on_final(self, text: str) -> None:
        self._partial = ""
        text = text.strip()
        if not text:
            return
        joined = _join_segments(self._finals)
        if joined and text.startswith(joined):
            self._finals = [text]
        else:
            self._finals.append(text)

    @property
    def display(self) -> str:
        return _join_segments(self._finals + ([self._partial] if self._partial else []))

    @property
    def final_text(self) -> str:
        return _join_segments(self._finals)

    def flush(self) -> str:
        text = self.final_text
        self._finals = []
        self._partial = ""
        return text
