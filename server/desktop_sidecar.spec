from pathlib import Path

from PyInstaller.utils.hooks import collect_data_files, copy_metadata

project_root = Path(SPECPATH)

datas = [(str(project_root / "migrations"), "migrations"), (str(project_root / "domain" / "data"), "domain/data")]
# 带数据文件的包一个个点名：PyInstaller 只跟 import，不跟 open()。漏一个就是安装包里某个功能
# 静默报错——spaCy 模型（语法概念的依存分析）、faster-whisper 的 VAD 模型（视频转写）、
# errant 的规则资源（写作纠错）、yt-dlp 的 JS 解题脚本（YouTube）都是这么漏过的
for package in (
    "spacy",
    "en_core_web_sm",
    "pysbd",
    "trafilatura",
    "edge_tts",
    "faster_whisper",
    "errant",
    "yt_dlp_ejs",
    "ctc_forced_aligner",
):
    datas.extend(collect_data_files(package))
for distribution in ("pydantic-ai-slim", "genai-prices", "fastmcp-slim", "en_core_web_sm"):
    datas.extend(copy_metadata(distribution, recursive=True))

a = Analysis(
    [str(project_root / "app" / "desktop_runtime.py")],
    pathex=[str(project_root)],
    binaries=[],
    datas=datas,
    # en_core_web_sm 是 spacy.load 按名字动态 import 的包，只收数据文件不收模块的话，
    # 打包后 `module has no attribute load`（句子解构 503）
    hiddenimports=["aiosqlite", "worker.main", "en_core_web_sm"],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=["tkinter", "matplotlib", "IPython", "jupyter", "keyring"],
    noarchive=True,
    optimize=1,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    name="nexus-sidecar",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=True,
    argv_emulation=False,
    target_arch="arm64",
    codesign_identity=None,
    entitlements_file=None,
    exclude_binaries=True,
)

coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=False,
    name="sidecar",
)
