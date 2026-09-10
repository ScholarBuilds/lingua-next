/* 讲义文档的纯逻辑层：callout 规整与大纲提取。

   抽成纯函数是因为仓库没有 jsdom——凡是想被单测覆盖的判断，
   都必须能脱离 DOM 跑（见 grammar-page-host.test 时期的同一约定）。 */

/* ---- callout 规整 ----

   remark-obsidian-callout 对「标题行与正文同段落」的 callout 会把正文当
   **原始 HTML 字符串**塞回去，内联 Markdown（粗体、行内码）全部失效。
   语料里有 39 处这种写法。在标题行后补一个 `>` 空行，正文就成了独立段落，
   走插件的安全路径，格式一点不丢。 */

const CALLOUT_HEAD = /^(\s*)> \[!\w+\][+-]?( .*)?$/
const QUOTE_CONTENT = /^\s*>\s*\S/

export function normalizeCallouts(md: string): string {
  const lines = md.split('\n')
  const out: string[] = []
  for (let i = 0; i < lines.length; i++) {
    out.push(lines[i])
    const head = CALLOUT_HEAD.exec(lines[i])
    if (head !== null && i + 1 < lines.length && QUOTE_CONTENT.test(lines[i + 1])) {
      out.push(`${head[1]}>`)
    }
  }
  return out.join('\n')
}

/* ---- 大纲提取 ----

   从 Markdown 文本而不是渲染后的 DOM 里取标题：一来可单测，二来
   react-markdown 渲染出的标题顺序与文本一致，用序号即可对上 DOM。
   围栏代码块里的 `# 注释` 不是标题，必须跳过。 */

export interface TocEntry {
  level: number
  text: string
  /** 全文标题序号，用来定位渲染后的第 N 个 h1-h6 */
  index: number
  /** 标题行号（0 起），节段切片按它算偏移 */
  line: number
}

/* 围栏不能用「见到 ```/~~~ 就开关」：~~~ 栏里的 ``` 是内容不是闭栏，
   ````markdown 教学示例里内嵌的 ``` 同理。开关式解析会在这两种写法上反转，
   把代码块里的 # 认成标题——大纲错位事小，节段切片跟着错位、写回会把
   围栏切掉半个，整篇后续内容被吞进未闭合代码块。按 CommonMark：闭栏必须
   同字符、长度不小于开栏、且后面只有空白。 */
const FENCE_OPEN = /^\s*(`{3,}|~{3,})/
const HEADING = /^(#{1,6})\s+(.+?)\s*#*\s*$/

export function tocFromMarkdown(md: string): TocEntry[] {
  const entries: TocEntry[] = []
  let fence: { char: string; len: number } | null = null
  let index = 0
  const lines = md.split('\n')
  for (let ln = 0; ln < lines.length; ln++) {
    const line = lines[ln]
    const f = FENCE_OPEN.exec(line)
    if (f !== null) {
      const marker = f[1]
      if (fence === null) {
        fence = { char: marker[0], len: marker.length }
        continue
      }
      const closes =
        marker[0] === fence.char &&
        marker.length >= fence.len &&
        line.trim() === marker[0].repeat(line.trim().length)
      if (closes) fence = null
      continue
    }
    if (fence !== null) continue
    const m = HEADING.exec(line)
    if (m === null) continue
    entries.push({ level: m[1].length, text: stripInline(m[2]), index, line: ln })
    index++
  }
  return entries
}

/* ---- 节段切片 ----

   「AI 完善」按大纲节段送稿：节段是**精确的源码区间**，改完写回就是
   无歧义的字符偏移拼接。不能用右键选区当稿——选区是渲染后的 DOM 文本，
   Markdown 标记已经被剥掉，拿去替换源文件必然错位。

   节段 = 该标题行起，到下一个同级或更高级标题行前（不含）。 */

export interface SectionSlice {
  start: number
  end: number
  text: string
}

export function sectionSlice(md: string, toc: TocEntry[], index: number): SectionSlice | null {
  const entry = toc.find((e) => e.index === index)
  if (entry === undefined) return null
  const lines = md.split('\n')
  const nextEntry = toc.find((e) => e.index > index && e.level <= entry.level)
  const endLine = nextEntry === undefined ? lines.length : nextEntry.line
  let start = 0
  for (let i = 0; i < entry.line; i++) start += lines[i].length + 1
  let end = start
  for (let i = entry.line; i < endLine; i++) end += lines[i].length + 1
  end = Math.min(end, md.length)
  return { start, end, text: md.slice(start, end) }
}

/** 标题里的内联标记（粗体/行内码/链接）在大纲里只留文字 */
function stripInline(text: string): string {
  return text
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .trim()
}

/* ---- 行高亮 meta 解析 ----

   语料的代码块写法是 Obsidian 风格的 ```text {1-3}（第 1-3 行高亮）。
   react-markdown 会把 `language-text` 之外的 meta 留在 node 上，
   这里解析成行号集合。非法输入一律返回空集，渲染层就当没有高亮。 */

export function highlightLines(meta: string | undefined): Set<number> {
  const out = new Set<number>()
  const m = /\{([\d,\s-]+)\}/.exec(meta ?? '')
  if (m === null) return out
  for (const part of m[1].split(',')) {
    const range = part.trim()
    if (range === '') continue
    const span = /^(\d+)(?:-(\d+))?$/.exec(range)
    if (span === null) continue
    const from = Number(span[1])
    const to = span[2] === undefined ? from : Number(span[2])
    for (let i = from; i <= to && i - from < 400; i++) out.add(i)
  }
  return out
}

/* ---- 尾换行对齐 ----

   LLM 层的收尾会把产文 .strip() 掉，而非末节的节段切片恒以换行结尾——
   直接拼接会把下一个标题行粘进上一段正文（「## B」变成正文的一部分，
   100% 触发不是概率问题）。写回前把改进稿的结尾换行数对齐到原切片。 */

export function matchTrailingNewlines(source: string, improved: string): string {
  const tail = /\n*$/.exec(source)?.[0] ?? ''
  return improved.replace(/\n*$/, '') + tail
}

/* ---- 文内搜索（块级） ----

   词点击增强会把英文词各自包进 span，字符级跨节点匹配成本高；
   先做块级命中：正文里每个可数块（段落/列表项/表格行/标题）的纯文本
   包含关键词即算命中。返回命中的块序号，由渲染层滚动定位。 */

export function searchBlocks(texts: string[], q: string): number[] {
  const needle = q.trim().toLowerCase()
  if (needle === '') return []
  const out: number[] = []
  for (let i = 0; i < texts.length; i++) {
    if (texts[i].toLowerCase().includes(needle)) out.push(i)
  }
  return out
}

/* ---- 大纲跟随（读到哪一节） ----

   > [!info] 判定是纯算术，不该去量 DOM
   >
   > 原来的实现每收到一次 scroll 事件，就 `querySelectorAll` 一遍标题、
   > 再对每个标题调 `getBoundingClientRect()`。25 个标题 × 每秒上百次事件
   > = 每秒几千次强制同步重排，滚动因此一顿一顿。
   >
   > 标题相对文档顶部的位置（`offsetTop`）不随滚动改变，量一次就够；
   > 之后每帧只需在有序数组里二分一次。这里就是那个二分。 */

/** 在升序的标题位置表里找最后一个 <= line 的下标；都比 line 大时返回 0。 */
export function activeHeadingAt(tops: number[], line: number): number {
  if (tops.length === 0) return 0
  let lo = 0
  let hi = tops.length - 1
  let current = 0
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (tops[mid] <= line) {
      current = mid
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  return current
}
