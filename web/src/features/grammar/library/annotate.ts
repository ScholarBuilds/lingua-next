/* 批注锚定：把「选中的一段原文」重新定位到当前正文，并标成高亮。

   > [!danger] 锚点不能只存字符偏移
   >
   > 讲义可以被 AI 改写并写回，偏移当场全错。存的是**引文 + 前后文**
   > （TextQuoteSelector 的老办法）：先按 前文+引文+后文 精确命中，
   > 命中不了退到只找引文、取离原偏移最近的那次出现，再找不到就认输
   > ——认输好过标在错的地方。

   高亮同样做成 hast 变换而不是改 DOM：改 React 管的 DOM 会在下一次
   协调时撞上被替换的文本节点，整页白屏（word-click 那条老账）。
   顺序必须排在切词之前，否则引文早被拆成一串 span，接不上了。 */

export interface AnchorInput {
  quote: string
  prefix: string
  suffix: string
  startHint: number
}

export interface AnnotationMark extends AnchorInput {
  id: number
  color: string
}

/** 锚点在整篇纯文本里的落点；找不到返回 null */
export function locateQuote(text: string, a: AnchorInput): { start: number; end: number } | null {
  const quote = a.quote
  if (quote === '') return null

  // 一档：前文 + 引文 + 后文 精确命中，多次出现也能分辨是哪一处
  if (a.prefix !== '' || a.suffix !== '') {
    const whole = `${a.prefix}${quote}${a.suffix}`
    const at = text.indexOf(whole)
    if (at >= 0) return { start: at + a.prefix.length, end: at + a.prefix.length + quote.length }
  }

  // 二档：只找引文，取离原偏移最近的一次——同一句话在文中出现多次时，
  // 位置是唯一还能用的线索
  const spots: number[] = []
  for (let i = text.indexOf(quote); i >= 0; i = text.indexOf(quote, i + 1)) spots.push(i)
  if (spots.length === 0) return null
  let best = spots[0]
  for (const s of spots) {
    if (Math.abs(s - a.startHint) < Math.abs(best - a.startHint)) best = s
  }
  return { start: best, end: best + quote.length }
}

/* ---- hast 变换 ---- */

interface HastText {
  type: 'text'
  value: string
}

interface HastElement {
  type: 'element'
  tagName: string
  properties?: Record<string, unknown>
  children: HastChild[]
}

export type HastChild = HastText | HastElement | { type: string; children?: HastChild[] }

/* 这些容器里的文字不算正文：批注锚在它们身上没有意义，
   而且把它们算进偏移会让整篇的位置全体错开 */
const SKIP = new Set(['svg', 'script', 'style'])

interface Piece {
  node: HastText
  parent: { children: HastChild[] }
  index: number
  start: number
}

/** 按文档顺序摊平所有文本节点，并记下各自在整篇纯文本里的起点 */
export function flattenText(root: HastChild): { text: string; pieces: Piece[] } {
  const pieces: Piece[] = []
  let text = ''
  const walk = (node: HastChild): void => {
    if (!('children' in node) || node.children === undefined) return
    if (node.type === 'element' && SKIP.has((node as HastElement).tagName)) return
    node.children.forEach((child, index) => {
      if (child.type === 'text') {
        const t = child as HastText
        pieces.push({ node: t, parent: node as { children: HastChild[] }, index, start: text.length })
        text += t.value
        return
      }
      walk(child)
    })
  }
  walk(root)
  return { text, pieces }
}

function mark(value: string, ann: AnnotationMark): HastElement {
  return {
    type: 'element',
    tagName: 'mark',
    properties: {
      className: ['glib-ann', `glib-ann-${ann.color}`],
      'data-ann': String(ann.id),
    },
    children: [{ type: 'text', value }],
  }
}

/** rehype 插件：把批注区间包成 `<mark>`。排在切词之前。 */
export function rehypeAnnotations(annotations: AnnotationMark[]) {
  return (tree: HastChild) => {
    if (annotations.length === 0) return
    const { text, pieces } = flattenText(tree)

    /* 逐条批注独立处理，且**从后往前**改：先改前面的会让后面的偏移失效。
       同一个文本节点被多条命中时，后处理的那条落在已经切细的片段上，
       所以每轮都重新摊平——151 篇里单篇批注量是个位数，重摊不值得优化。 */
    const located = annotations
      .map((ann) => ({ ann, at: locateQuote(text, ann) }))
      .filter((x): x is { ann: AnnotationMark; at: { start: number; end: number } } => x.at !== null)
      .sort((a, b) => b.at.start - a.at.start)

    for (const { ann, at } of located) {
      for (let i = pieces.length - 1; i >= 0; i--) {
        const piece = pieces[i]
        const pStart = piece.start
        const pEnd = pStart + piece.node.value.length
        if (pEnd <= at.start || pStart >= at.end) continue
        const from = Math.max(0, at.start - pStart)
        const to = Math.min(piece.node.value.length, at.end - pStart)
        const value = piece.node.value
        const replacement: HastChild[] = []
        if (from > 0) replacement.push({ type: 'text', value: value.slice(0, from) })
        replacement.push(mark(value.slice(from, to), ann))
        if (to < value.length) replacement.push({ type: 'text', value: value.slice(to) })
        piece.parent.children.splice(piece.index, 1, ...replacement)
      }
      // 结构变了，重新摊平供下一条使用
      const next = flattenText(tree)
      pieces.length = 0
      pieces.push(...next.pieces)
    }
  }
}

/* ---- 从浏览器选区取锚点 ---- */

export const CONTEXT_CHARS = 32

/** 选区 → 锚点。取所在块的纯文本算前后文，跨块选择时以选区自身为准。 */
export function anchorFromSelection(
  root: Element,
  selection: Selection,
): AnchorInput | null {
  const quote = selection.toString().trim()
  if (quote === '' || selection.rangeCount === 0) return null
  const full = root.textContent ?? ''
  // 选区在整篇纯文本里的起点：用选区前半段的长度算，比逐节点累加稳
  const range = selection.getRangeAt(0).cloneRange()
  range.setStart(root, 0)
  const startHint = range.toString().length - selection.toString().length
  const safeHint = startHint >= 0 ? startHint : Math.max(0, full.indexOf(quote))
  return {
    quote,
    prefix: full.slice(Math.max(0, safeHint - CONTEXT_CHARS), safeHint),
    suffix: full.slice(safeHint + quote.length, safeHint + quote.length + CONTEXT_CHARS),
    startHint: safeHint,
  }
}
