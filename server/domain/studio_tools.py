"""工坊工具的服务端常量（模块 17 M2）：细节增强的强度档与那句实话。

提示词归服务端，和画风预设同一性质——它是提示词工程产物，放前端就没法版本化、
没法测、也没法在不发版的情况下改。**角度控制的机位指令不在这里**：那是拖滑杆时
实时拼出来的呈现逻辑，属于前端。

三档的差别只有一个变量：**允许模型偏离原图多远**。三条提示词都必须钉死「不改构图、
不改主体、不改配色、不改比例、不加原图没有的东西」——增强一旦改了构图就不是增强，
是重画，而用户是拿它跟原图做对比滑块看的。
"""

from __future__ import annotations

# 三条提示词共用的禁区。措辞被 tests/test_studio_m2.py 钉住，改词要一起改测试
_KEEP_RULE = (
    "Do not change the composition, the subject, the colour palette, or the aspect ratio. "
    "Do not add, remove, or move any element that is not already in the picture. "
    "The result must read as the same photograph, only cleaner."
)

ENHANCE_PRESETS: tuple[dict[str, str], ...] = (
    {
        "key": "light",
        "label": "轻微",
        "hint": "只补一点边缘锐度与表面纹理，几乎看不出重绘痕迹。原图本来就清楚、只差临门一脚时用",
        "prompt": (
            "Restore this image with a light touch: recover fine surface texture and "
            "micro-detail, sharpen edges slightly, and lift local contrast just enough "
            "for the detail that is already there to read clearly. Keep grain and "
            "material character natural. " + _KEEP_RULE
        ),
    },
    {
        "key": "standard",
        "label": "标准",
        "hint": "默认档，纹理与材质明显更实，边缘更干净。截图、老图、压缩过头的图用这档",
        "prompt": (
            "Restore this image: rebuild fine detail and material texture across the "
            "whole frame, clean up compression artefacts and edge halos, sharpen edges "
            "crisply, and raise local contrast so surfaces read with clear depth. "
            + _KEEP_RULE
        ),
    },
    {
        "key": "strong",
        "label": "强化",
        "hint": "最大幅度重建细节，颗粒与材质感最重；与原图的差异也最大，人脸和文字慎用",
        "prompt": (
            "Restore this image aggressively: rebuild fine detail, fabric weave, skin "
            "pore, hair strand and surface grain at maximum fidelity, remove all "
            "compression artefacts and blur, render edges razor sharp, and push local "
            "contrast and micro-contrast hard so every material reads distinctly. "
            + _KEEP_RULE
        ),
    },
)

# BR-150 的落点：这条通路做不到的事必须写在用户看得见的地方，不含糊过去。
# 本仓中转只有生图/改图模型，没有分辨率重建这一类模型，所以增强只能是重绘。
ENHANCE_NOTE = (
    "细节增强是重绘式的：模型照着原图重画一遍，让纹理、边缘与局部对比更清楚。"
    "输出像素与原图同一档，尺寸不变——想要更大的成片请在生成时直接选高画幅。"
)


def enhance_preset(key: str) -> dict[str, str] | None:
    return next((p for p in ENHANCE_PRESETS if p["key"] == key), None)


def catalog_view() -> dict:
    from domain.tool_plugins import catalog_view as plugin_catalog_view

    return {
        "enhance_presets": [dict(p) for p in ENHANCE_PRESETS],
        "enhance_note": ENHANCE_NOTE,
        **plugin_catalog_view(),
    }
