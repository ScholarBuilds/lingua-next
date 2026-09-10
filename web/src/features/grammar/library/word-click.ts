/* 英文词切分：rehype 插件，把文本节点里的英文词包成可点 span。

   **必须做在树上而不是渲染后的 DOM 上**。首版渲染完用 TreeWalker 改
   React 管理的 DOM，父组件一重渲染 React 就对着被替换掉的文本节点
   insertBefore，整页白屏（NotFoundError）。改成 hast 变换后 React
   全程拥有 DOM，顺带让切词逻辑可以脱离浏览器单测。

   跳过规则分两档：控件/SVG/script 永远不切（切了毁交互，或那根本不是正文），
   代码块与引用**默认照切**——讲义的例句大量住在 ```text 例句块和 callout 里，
   那正是最想查的词；只想切散文时把 scope 传 'prose'（顶部开关控制）。 */

const WORD_RE = /[A-Za-z][A-Za-z'’-]*/g
/* 永远不切：控件（切了毁掉交互）、SVG（mermaid 图里的文字不是正文）、
   script/style（不是给人读的） */
const NEVER = new Set(['button', 'input', 'textarea', 'select', 'svg', 'script', 'style'])

/* scope='prose' 时额外跳过的：代码块看的是形态不是词义 */
const CODE_LIKE = new Set(['code', 'pre', 'kbd', 'samp'])

export const WORD_CLASS = 'glib-w'

export type WordScope = 'all' | 'prose'

export interface HastText {
  type: 'text'
  value: string
}

export interface HastElement {
  type: 'element'
  tagName: string
  properties?: Record<string, unknown>
  children: HastChild[]
}

export type HastChild = HastText | HastElement | { type: string; children?: HastChild[] }

function classList(node: HastElement): string[] {
  const cls = node.properties?.className
  if (Array.isArray(cls)) return cls.map(String)
  return typeof cls === 'string' ? cls.split(/\s+/) : []
}

function hasNoWordsClass(node: HastElement): boolean {
  const cls = classList(node)
  // mermaid 的源码要原样交给解析器，切成 span 会连图都画不出来
  return cls.includes('glib-nowords') || cls.includes('language-mermaid')
}

/** 一个文本节点 → 词 span 与普通文本交错的序列；没有英文词返回 null */
export function splitWords(value: string): HastChild[] | null {
  WORD_RE.lastIndex = 0
  if (!WORD_RE.test(value)) return null
  const out: HastChild[] = []
  let last = 0
  WORD_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = WORD_RE.exec(value)) !== null) {
    if (m.index > last) out.push({ type: 'text', value: value.slice(last, m.index) })
    out.push({
      type: 'element',
      tagName: 'span',
      properties: { className: [WORD_CLASS], role: 'button' },
      children: [{ type: 'text', value: m[0] }],
    })
    last = m.index + m[0].length
  }
  if (last < value.length) out.push({ type: 'text', value: value.slice(last) })
  return out
}

export function transformTree(node: HastChild, scope: WordScope = 'all'): void {
  if (!('children' in node) || node.children === undefined) return
  if (node.type === 'element') {
    const el = node as HastElement
    if (NEVER.has(el.tagName) || hasNoWordsClass(el)) return
    if (scope === 'prose' && CODE_LIKE.has(el.tagName)) return
  }
  const next: HastChild[] = []
  for (const child of node.children) {
    if (child.type === 'text') {
      const parts = splitWords((child as HastText).value)
      if (parts !== null) {
        next.push(...parts)
        continue
      }
      next.push(child)
      continue
    }
    transformTree(child, scope)
    next.push(child)
  }
  node.children = next
}

/** rehype 插件入口。放在 rehype-raw 之后，讲义里手写的 HTML 一并切词 */
export function rehypeClickableWords(scope: WordScope = 'all') {
  return (tree: HastChild) => transformTree(tree, scope)
}

/** 词所在句子当语境：AI 语境释义靠它，给整篇会把提示词撑爆。
    往上找到一个文本量够一句话的祖先，截 220 字符封顶。 */
export function sentenceContext(node: Node): string {
  let el: Element | null = node.parentElement ?? (node as Element)
  while (el !== null && (el.textContent ?? '').length < 12) el = el.parentElement
  const raw = (el?.textContent ?? '').replace(/\s+/g, ' ').trim()
  return raw.length > 220 ? raw.slice(0, 220) : raw
}
