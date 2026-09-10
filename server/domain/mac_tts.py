"""macOS 已安装语音，经本机合成后复用统一音频缓存。"""

import re
import shutil
import subprocess
import sys
import tempfile
from functools import lru_cache
from pathlib import Path


@lru_cache(maxsize=1)
def voices() -> list[dict]:
    if sys.platform != "darwin" or not shutil.which("ffmpeg"):
        return []
    result = subprocess.run(
        ["/usr/bin/say", "-v", "?"], capture_output=True, text=True, timeout=10, check=True
    )
    items = []
    for line in result.stdout.splitlines():
        match = re.match(r"(.+?)\s+([a-z]{2}_[A-Z]{2})\s+#", line)
        if match:
            name, locale = match.groups()
            items.append(
                {
                    "name": f"mac:{name.strip()}",
                    "label": name.strip(),
                    "locale": locale.replace("_", "-"),
                }
            )
    return list({item["name"]: item for item in items}.values())


def synthesize(text: str, voice: str, rate: int, path: Path) -> Path:
    if voice not in {item["name"] for item in voices()}:
        raise ValueError("本机声音不可用，请选择已安装的声音")
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=path.parent) as directory:
        source = Path(directory) / "speech.aiff"
        output = Path(directory) / "speech.mp3"
        subprocess.run(
            [
                "/usr/bin/say",
                "-v",
                voice[4:],
                "-r",
                str(max(80, min(450, round(180 * (1 + rate / 100))))),
                "-o",
                str(source),
            ],
            input=text,
            text=True,
            capture_output=True,
            timeout=30,
            check=True,
        )
        subprocess.run(
            ["ffmpeg", "-nostdin", "-v", "error", "-i", str(source), str(output)],
            capture_output=True,
            timeout=30,
            check=True,
        )
        output.replace(path)
    return path
