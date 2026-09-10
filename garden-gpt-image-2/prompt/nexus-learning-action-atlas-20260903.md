# NEXUS 学习动作图集

```json
{
  "type": "anime cel-shaded learning action icon atlas",
  "goal": "a production sprite sheet for NEXUS learning controls",
  "layout": {
    "grid": "exactly 4 columns by 4 rows",
    "cell_count": 16,
    "cell_rule": "all cells are equal square regions with generous transparent padding; one centered icon per cell; no dividers and no overlap",
    "background": "fully transparent"
  },
  "order": [
    ["play media: cobalt blue triangular play crystal", "pause media: two upright cyan pause bars", "previous sentence: small speech card with a leftward arrow", "next sentence: small speech card with a rightward arrow"],
    ["playback speed: compact speedometer with motion tick", "voice and volume: friendly speaker with two sound waves", "bilingual captions: two stacked speech strips with tiny abstract marks, not readable text", "focus current sentence: sentence strip inside a targeting frame"],
    ["restart from beginning: circular rewind arrow with a starting spark", "A-B loop: two endpoint pins connected by a looping ribbon", "repeat one sentence: sentence strip wrapped by one circular arrow", "interval pause: two sentence strips separated by a small clock"],
    ["translate: two overlapping speech bubbles with opposing arrows", "reply suggestions: three short dialogue cards fanning forward", "word dictionary card: open mini book with a highlighted word token", "collect vocabulary: bookmark star entering a small word card"]
  ],
  "style": {
    "direction": "young Japanese anime UI, clean cel shading, playful but functional",
    "palette": "deep ink navy outlines, cobalt blue, clear cyan, warm yellow accents, tiny coral accents",
    "rendering": "bold readable silhouettes, smooth rounded corners, limited highlights, subtle dimensional edge, no photorealism",
    "consistency": "same stroke weight, light direction, saturation and visual scale across every icon"
  },
  "constraints": {
    "must_keep": ["exact 4x4 order", "transparent background", "each icon recognizable at 24 pixels", "icons separated cleanly"],
    "avoid": ["letters", "numbers", "words", "labels", "people", "faces", "app tiles", "background cards", "drop shadows outside cells", "traditional enterprise line icons", "realistic objects", "extra symbols"]
  }
}
```
