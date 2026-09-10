"""比例 × 分辨率档（模块 16 FR-432）。

首版让用户直接填 `宽x高`，两个问题：

1. `1536x608` 这种数字看不出是干嘛用的；
2. **上游根本不按给的尺寸出图**——实测请求 1536x608 返回 1994x789
   （`需求说明` §14.1）。让用户精确填一个不被遵守的数字是幻觉。

所以对外只暴露「比例」和「分辨率档」两个选项，具体像素由这里换算。档位表是
**可标定的**：`calibrate()` 把实测返回尺寸写回 `measured`，之后 UI 显示实测值，
不再显示我们请求的那个数。照抄官方文档的档位表会再踩一次上面那个坑。
"""

from __future__ import annotations

from dataclasses import dataclass

from sqlalchemy.ext.asyncio import AsyncSession

from domain.image_prompts import SIZE_STEP, PromptError, is_experimental, parse_size
from domain.models import UserPref

# 分辨率档。
#
# CR-001 当时不开 4K，理由是「没有超分模型，只能靠上游直出，贵且未验证」。前一条
# 已被用户推翻——自有账号 token 充足，成本不是约束；后一条仍然成立，所以 4K 保持
# **显式选择 + 标定后以实测为准**，不做默认。
#
# 4K 档一律把长边定在 3840：上游文档给的最大边就是 3840，且宽高必须是 16 的倍数。
TIERS: tuple[str, ...] = ("1k", "2k", "4k")

TIER_LABELS: dict[str, str] = {
    "1k": "1K · 默认，最快",
    "2k": "2K · 更清晰，慢一些",
    "4k": "4K · 长边 3840，最慢",
}

TIER_HINTS: dict[str, str] = {
    "1k": "屏幕上看、做封面缩略都够；改构图试风格用这档最划算",
    "2k": "要放大看细节或者印出来时用",
    "4k": "上游标注 2560×1440 以上属实验性，实际返回尺寸以标定结果为准",
}


@dataclass(frozen=True)
class Ratio:
    """一个可选比例。`sizes` 按档位给出请求尺寸，全部是 16 的倍数。"""

    key: str
    label: str
    sizes: dict[str, str]
    hint: str = ""

    @property
    def value(self) -> float:
        w, h = parse_size(self.sizes["1k"])
        return w / h


RATIOS: dict[str, Ratio] = {
    "1:1": Ratio("1:1", "正方形", {"1k": "1024x1024", "2k": "2048x2048", "4k": "3840x3840"},
                 "头像、助记图、商品主图"),
    "3:2": Ratio("3:2", "横版 3:2", {"1k": "1536x1024", "2k": "2016x1344", "4k": "3840x2560"},
                 "通用横图"),
    "2:3": Ratio("2:3", "竖版 2:3", {"1k": "1024x1536", "2k": "1344x2016", "4k": "2560x3840"},
                 "书封、海报"),
    "4:3": Ratio("4:3", "横版 4:3", {"1k": "1024x768", "2k": "2048x1536", "4k": "3840x2880"}),
    "3:4": Ratio("3:4", "竖版 3:4", {"1k": "768x1024", "2k": "1536x2048", "4k": "2880x3840"}),
    "16:9": Ratio("16:9", "宽屏 16:9", {"1k": "1024x576", "2k": "2048x1152", "4k": "3840x2160"},
                  "场景卡、配图、横幅"),
    "9:16": Ratio("9:16", "竖屏 9:16", {"1k": "576x1024", "2k": "1152x2048", "4k": "2160x3840"},
                  "手机端整屏"),
    "2.5:1": Ratio("2.5:1", "宽幅封面", {"1k": "1536x608", "2k": "2048x816", "4k": "3840x1536"},
                   "单词本卡片封面，两端裁切最少"),
}

# 实测标定结果：{(ratio_key, tier): "实际返回的 WxH"}。空表示还没标定过。
# 只在**每档实发一张最低质量图**之后才有值，由 `record_measured()` 写入。
MEASURED: dict[tuple[str, str], str] = {}


def resolve(ratio_key: str, tier: str) -> str:
    """比例 + 档位 → 请求尺寸。"""
    ratio = RATIOS.get(ratio_key)
    if ratio is None:
        raise PromptError(f"未知比例：{ratio_key}")
    if tier not in TIERS:
        raise PromptError(f"未知分辨率档：{tier}（可选 {'/'.join(TIERS)}）")
    return ratio.sizes[tier]


def classify(size: str) -> tuple[str, str] | None:
    """反查一个尺寸属于哪个「比例 × 档位」。查不到返回 None（自定义尺寸）。"""
    for ratio in RATIOS.values():
        for tier, value in ratio.sizes.items():
            if value == size:
                return ratio.key, tier
    return None


def nearest_ratio(size: str) -> str:
    """给任意尺寸找最接近的比例 key。用于把既有 target 的固定尺寸映射到 UI 选项。"""
    w, h = parse_size(size)
    target = w / h
    return min(RATIOS.values(), key=lambda r: abs(r.value - target)).key


def aspect_choices() -> list[dict]:
    """给立意步骤看的比例候选清单（FR-451）。

    只给 key、中文名、适合画什么——尺寸数字对「该选哪个画幅」这个判断毫无帮助，
    给了反而让模型去纠结分辨率。
    """
    return [
        {"key": r.key, "label": r.label, "good_for": r.hint or "通用"}
        for r in RATIOS.values()
    ]


def size_for_aspect(aspect: str, tier: str) -> str | None:
    """立意选的比例 → 请求尺寸。选了个不存在的比例就返回 None，由调用方兜底。

    不抛异常：模型答错一个 key 不该让整张图出不来。
    """
    ratio = RATIOS.get((aspect or "").strip())
    if ratio is None:
        return None
    return ratio.sizes.get(tier if tier in TIERS else "1k")


def record_measured(ratio_key: str, tier: str, actual: str) -> None:
    """把实测返回尺寸记下来。与请求值不一致时以它为准展示。"""
    MEASURED[(ratio_key, tier)] = actual


PREF_KEY = "image_size_calibration"


async def load_measured(session: AsyncSession) -> int:
    """从库里读回标定结果。

    只放内存是不够的：API 与 worker 是两个进程，各自一份空 dict，而且重启一次
    二十几次真实调用换来的测量就没了。
    """
    row = await session.get(UserPref, PREF_KEY)
    if row is None:
        return 0
    for key, actual in (row.value or {}).items():
        ratio, _, tier = key.rpartition("|")
        if ratio and tier:
            MEASURED[(ratio, tier)] = str(actual)
    return len(MEASURED)


async def save_measured(session: AsyncSession) -> None:
    payload = {f"{ratio}|{tier}": actual for (ratio, tier), actual in MEASURED.items()}
    row = await session.get(UserPref, PREF_KEY)
    if row is None:
        session.add(UserPref(key=PREF_KEY, value=payload))
    else:
        row.value = payload
    await session.commit()


# 换档位后像素量至少要差这么多，才算「档位真的起作用」。
# 定 1.2 是因为实测见过同一比例三档返回 1994x789 / 1986x792 / 1983x793——
# 数值不同，但像素量只差 0.1%，那是取整噪声不是分辨率差异。按字符串比会误判成有效。
TIER_EFFECT_RATIO = 1.2


def tiers_effective() -> bool | None:
    """标定数据说明「换档位到底改不改像素」。没标定过、或数据不足以判断时返回 None。

    实测过一次：某中转对 1K/2K/4K 返回的**像素量完全一样**（都是约 1.57MP），
    它固定按一个像素预算出图，只认比例不认分辨率。这种情况下再让用户挑档位就是
    让人白挑，UI 要照实说出来（不伪造）。
    """
    if not MEASURED:
        return None
    per_ratio: dict[str, list[int]] = {}
    for (ratio, _tier), actual in MEASURED.items():
        try:
            w, h = parse_size(actual)
        except PromptError:
            continue
        per_ratio.setdefault(ratio, []).append(w * h)
    # 只有一个档位的数据说明不了问题
    comparable = [pixels for pixels in per_ratio.values() if len(pixels) > 1]
    if not comparable:
        return None
    return any(max(px) / max(min(px), 1) >= TIER_EFFECT_RATIO for px in comparable)


def view() -> dict:
    """给前端的档位表。`measured` 有值时前端显示实测值并标注。"""
    return {
        "ratios": [
            {
                "key": r.key,
                "label": r.label,
                "hint": r.hint,
                "sizes": dict(r.sizes),
                "measured": {
                    tier: MEASURED[(r.key, tier)]
                    for tier in TIERS
                    if (r.key, tier) in MEASURED
                },
                # 上游把 2560x1440 以上标为实验性。不拦人，但要照实标出来
                "experimental": {
                    tier: is_experimental(size) for tier, size in r.sizes.items()
                },
                "value": round(r.value, 4),
            }
            for r in RATIOS.values()
        ],
        "tiers": [
            {"key": t, "label": TIER_LABELS[t], "hint": TIER_HINTS.get(t, "")}
            for t in TIERS
        ],
        "step": SIZE_STEP,
        "calibrated": len(MEASURED) > 0,
        # None = 还没标定；False = 实测证明换档位不改像素，只有比例生效
        "tiers_effective": tiers_effective(),
    }
