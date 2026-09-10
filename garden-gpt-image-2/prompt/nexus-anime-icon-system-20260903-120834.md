# NEXUS 年轻化二次元图标系统

## 通用方向

- 现代日系动画应用的 2D 赛璐璐图标，不使用角色头像或品牌 IP。
- 深墨蓝粗轮廓，钴蓝与清透青色为主色，少量蜜桃橙和柠檬黄作提示色。
- 轮廓有轻微手绘弹性，但几何含义必须准确；整体轻快、年轻、清爽，不幼儿化。
- 每个图标只使用 2 至 4 个纯色块，禁止摄影、拟物材质、3D 黏土、金属、木纹、玻璃拟态和复杂光影。
- 不生成文字、数字、字母、Logo、水印、格子边框或背景卡片。

## 操作图标图集

```json
{
  "type": "2D anime productivity action icon atlas",
  "goal": "a production-ready 6 by 6 sprite sheet whose icons remain immediately readable at 16 to 24 pixels",
  "canvas": {
    "aspect_ratio": "1:1",
    "background": "fully transparent",
    "grid": "exactly 6 columns by 6 rows, 36 equal square cells",
    "spacing": "each symbol centered in its cell with identical generous safe margins; nothing crosses a cell boundary"
  },
  "style": {
    "art_direction": "youthful Japanese anime app UI, flat cel-shaded vector-like pictograms",
    "line": "consistent bold dark navy outline with softly tapered ends and subtle hand-drawn energy",
    "palette": "cobalt blue and bright cyan, with restrained peach-orange and lemon-yellow accents",
    "detail": "simple bold silhouettes, two to four flat color areas per icon, no micro-detail, no cast shadows"
  },
  "cells_in_exact_reading_order": [
    ["back arrow", "forward arrow", "up arrow", "down arrow", "close x", "check mark"],
    ["plus", "minus", "magnifying glass search", "horizontal more dots", "refresh", "play"],
    ["pause", "download", "upload", "copy", "pencil edit", "trash delete"],
    ["save", "folder", "document", "image landscape", "video film", "audio waveform"],
    ["chain link", "settings sliders", "information", "warning", "lock", "key"],
    ["grid", "list", "crop", "magic wand", "cloud", "workflow nodes"]
  ],
  "constraints": {
    "must_keep": [
      "exact row and column order",
      "all 36 icons present exactly once",
      "uniform scale and stroke weight",
      "transparent negative space between every cell",
      "unambiguous UI meaning at small size"
    ],
    "avoid": [
      "text or labels",
      "characters, faces, hands or mascots",
      "background tiles or cell borders",
      "photorealism, skeuomorphism, clay, 3D, gradients, neon glow",
      "black background",
      "cropped, overlapping, duplicated or missing icons"
    ]
  }
}
```

## 业务领域图集

```json
{
  "type": "2D anime productivity domain icon atlas",
  "goal": "a cohesive 4 by 4 sprite sheet for the main navigation and page identity of a youthful learning and creative workbench",
  "canvas": {
    "aspect_ratio": "1:1",
    "background": "fully transparent",
    "grid": "exactly 4 columns by 4 rows, 16 equal square cells",
    "spacing": "each item centered and isolated with identical safe margins; no dividers and no background cards"
  },
  "style": {
    "art_direction": "polished Japanese anime school-life and creator-tool item icons, expressive but mature",
    "rendering": "clean 2D cel shading, crisp dark navy outline, simplified graphic forms",
    "palette": "cobalt blue and bright cyan with small peach-orange and lemon-yellow accents, off-white highlights",
    "personality": "playful asymmetry and one tiny sparkle or motion accent where useful, without faces or mascot characters"
  },
  "cells_in_exact_reading_order": [
    ["today calendar with sun sparkle", "open reading book with ribbon", "video player with play symbol", "vocabulary flashcards with speech mark"],
    ["grammar sentence blocks connected by brackets", "desktop microphone with two speech bubbles", "creator drawing tablet with stylus and small frame", "sealed mail envelope with paper plane accent"],
    ["account identity card with key charm", "extension puzzle plug", "quest checklist with small timer", "settings control sliders with star accent"],
    ["image canvas with mountain and sparkle", "workflow nodes connected by flowing arrows", "art canvas frame with crop corners and pencil", "organized asset box containing image video audio and document tabs"]
  ],
  "constraints": {
    "must_keep": [
      "exact row and column order",
      "all 16 concepts present exactly once",
      "uniform visual weight and consistent perspective",
      "recognizable at navigation-icon size",
      "transparent negative space around every item"
    ],
    "avoid": [
      "text, letters, numbers or labels",
      "characters, faces, hands or mascots",
      "photography, realistic desk scenes, 3D clay, wood, metal, glass, heavy shadows",
      "background tiles, cell borders, gradients or neon glow",
      "cropped, overlapping, duplicated or missing items"
    ]
  }
}
```
