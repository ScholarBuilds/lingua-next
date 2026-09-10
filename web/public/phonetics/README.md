# 口腔剖面图资产

来源：[drammock/phonetics-teaching-assets](https://github.com/drammock/phonetics-teaching-assets)

许可：**CC0-1.0**（公共领域奉献，无署名义务）。这里仍然写明出处是为了可追溯，不是许可要求。

## 文件对照

原库文件名含 IPA 字符，URL 里不好用，落盘时改成 ASCII：

| 本地文件 | 原库路径 | 用在 |
| --- | --- | --- |
| `p/b/t/d/k/g.svg` | `consonants/svg/*.svg` | 六个塞音 |
| `f/v.svg` | 同上 | 唇齿擦音 |
| `theta.svg` / `eth.svg` | `θ.svg` / `eth.svg` | /θ/ /ð/ |
| `s/z.svg` | `s_apical.svg` / `z_apical.svg` | 齿龈擦音（取舌尖版） |
| `esh.svg` / `ezh.svg` | `ʃ_apical.svg` / `ʒ_apical.svg` | 龈后擦音；塞擦音的第二帧也用它 |
| `m/n.svg`、`eng.svg` | `m/n/ŋ.svg` | 三个鼻音；`/l/` 借用 `n.svg` |
| `r.svg` | `r_retroflex.svg` | /r/ |
| `neutral.svg` | `neutral.svg` | /h/ 与多数元音的中性舌位 |
| `vowel-i.svg` / `vowel-u.svg` | `vowels/svg/i.svg` / `u.svg` | /j/ 与 /w/ 的起始姿势 |
| `glottis-open.svg` | `glottis/svg/glottis_voiceless_wide.svg` | 声门张开（备用） |

## 缺图的六个音位怎么处理

原库缺 `/l/ /w/ /tʃ/ /dʒ/ /h/ /j/`。**不自绘**——自绘的比例与线条跟这 51 张对不上，
看起来比缺图更糟。改用同库里发音姿势等价的图组合表达，对照关系写在
`server/domain/phoneme_cards.py` 的 `SVG_NOTES` 里，前端会把说明显示给用户。

塞擦音配两帧做离散切换（`/t/` → `/ʃ/`），这是需求 §9 明确的做法：
Höffler & Leutner 的 d=0.37 来自表征性动画而非补间平滑度，两张图切换就吃到了这个效应。
