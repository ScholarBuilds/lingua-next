/* 滚动链路守卫：抓「声明了 overflow 却滚不动」这一类无报错故障。

   起因是真实反馈「很多地方列表或内容溢出都滚不下去」。逐个排查下来，
   坏的从来不是那条 `overflow-y: auto`，而是它上面的 flex 链：

     .wrap  { display: flex; flex-direction: column; }
     .list  { flex: 1; overflow-y: auto; }   ← 少了 min-height: 0

   CSS 给 flex/grid 子项的 min-height 默认值是 `auto`，意思是「不许比内容矮」。
   于是链上那一层被内容撑到全高，滚动条永远不出现，多出来的内容把父容器顶开，
   父容器再被 `.app { overflow: hidden }` 裁掉——用户看到的就是「滚不下去」。
   全程零报错，测试也测不出来，只能靠扫描。

   有个规范细节必须先说清，否则会满屏误报：`min-height: auto` 只在**该盒子自身
   overflow 是 visible** 时才解析成「内容高度」（flexbox §4.5 / css-sizing）。
   滚动容器自己写了 `overflow-y: auto`，它的自动最小尺寸就是 0，
   所以 `.list { flex: 1; overflow-y: auto }` 不补 min-height:0 也能滚。
   真正会坏的是**中间那层 overflow 还是 visible 的包裹盒**——它撑开了，
   里面的滚动容器拿到的可用高度就是被撑开后的高度，等于没上限。

   判据（对每个滚动容器 E 自下而上走祖先链）：
   - E 自己有 height / max-height → 自带高度上限，不依赖祖先，直接放行；
   - 链上每一层子项，若其父是「列向 flex」或「含 1fr 行的 grid」，
     且该子项 overflow 仍是 visible、又没有 min-height:0 / height / max-height
     → 它就是撑破链路的那一层，报错；
   - 走到有确定高度 / 定位兜底的祖先就停（链被兜住）；
   - 走出本文件根节点还没兜住 → 记成 unresolved，只在 --verbose 里列，不拦。

   横向同理：overflow-x 滚动容器在行向 flex 链上要 min-width:0。

   用法：
     node scripts/check-scroll.mjs            仅报错
     node scripts/check-scroll.mjs --verbose  连同 unresolved / ok 一起列
     node scripts/check-scroll.mjs --table    输出普查表（Markdown） */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SRC = join(ROOT, 'src')

/* 明确核过、确认不会坏的滚动容器。写进来必须给理由。 */
const ALLOW = new Map([
  // key 形如 `文件相对路径:行号:类名`
])

/* ---------------------------------------------------------------- CSS 索引 */

/** 关心的属性。别的一律丢掉，省得索引膨胀。 */
const TRACKED = new Set([
  'display',
  'flex-direction',
  'flex',
  'flex-grow',
  'flex-basis',
  'min-height',
  'min-width',
  'height',
  'max-height',
  'max-width',
  'overflow',
  'overflow-y',
  'overflow-x',
  'position',
  'grid-template-rows',
  'grid-template-columns',
])

function walkFiles(dir, ext, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) walkFiles(full, ext, out)
    else if (ext.some((e) => name.endsWith(e))) out.push(full)
  }
  return out
}

/** 注释换成等量换行，保住行号。 */
function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, (b) => '\n'.repeat((b.match(/\n/g) ?? []).length))
}

/** 逐字符扫全部层级的规则（含 @media 内），返回 { head, body, line }。 */
function parseRules(rawText) {
  const text = stripComments(rawText)
  const rules = []
  const stack = []
  let head = ''
  let headLine = 1
  let line = 1
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]
    if (ch === '\n') line += 1
    if (ch === '{') {
      stack.push({ head: head.trim(), line: headLine, start: i + 1 })
      head = ''
      headLine = line
      continue
    }
    if (ch === '}') {
      const frame = stack.pop()
      if (!frame) continue
      // @media / @supports 等是嵌套块，本身不是规则；跳过头以 @ 开头的
      if (frame.head && !frame.head.startsWith('@')) {
        const body = text.slice(frame.start, i)
        // 只收叶子规则（body 里不再有 `{`），避免把 @media 块当规则
        if (!body.includes('{')) rules.push({ head: frame.head, body, line: frame.line })
      }
      head = ''
      headLine = line
      continue
    }
    if (head === '' && (ch === ' ' || ch === '\n' || ch === '\t')) {
      headLine = line
      continue
    }
    head += ch
  }
  return rules
}

function parseDecls(body) {
  const out = {}
  for (const chunk of body.split(';')) {
    const idx = chunk.indexOf(':')
    if (idx < 0) continue
    const prop = chunk.slice(0, idx).trim().toLowerCase()
    if (!TRACKED.has(prop)) continue
    out[prop] = chunk
      .slice(idx + 1)
      .replace(/!important/gi, '')
      .trim()
      .toLowerCase()
  }
  return out
}

/** 按层叠顺序合并一条规则的声明。

    `overflow` 简写会重置 overflow-x/y 两个长写，不清掉的话
    `.page{overflow-y:auto}` + `.sal-page{overflow:hidden}` 会合出
    「既 hidden 又 auto」，页面被误判成还在滚。 */
function mergeStyle(target, decls) {
  if (decls.overflow) {
    delete target['overflow-x']
    delete target['overflow-y']
  }
  Object.assign(target, decls)
  return target
}

/** 取选择器最右侧复合项里的类名。`.a .b.c:hover` → ['b','c'] */
function keyClasses(selector) {
  const last = selector.trim().split(/[\s>+~]+/).filter(Boolean).pop() ?? ''
  return [...last.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)].map((m) => m[1])
}

/** 合并 CSS：类名 → 属性表。同名多规则按出现顺序覆盖，近似层叠。

    @media 里的规则也照收。窄屏才生效的声明被当成一直生效，
    方向上是「多兜一层」——只会让判定更保守，不会凭空造出报错。 */
export function buildCssIndex(sources) {
  const index = new Map()
  for (const { text } of sources) {
    for (const rule of parseRules(text)) {
      const decls = parseDecls(rule.body)
      if (Object.keys(decls).length === 0) continue
      for (const sel of rule.head.split(',')) {
        // 伪元素规则描述的是生成盒，不是元素本身
        if (/::/.test(sel)) continue
        for (const cls of keyClasses(sel)) {
          const cur = index.get(cls) ?? {}
          mergeStyle(cur, decls)
          index.set(cls, cur)
        }
      }
    }
  }
  return { index }
}

/* ------------------------------------------------------- Tailwind 最小支持 */

/* 仓里 Tailwind 只在 shadcn 组件和少量弹窗上用，覆盖实际出现的那几个就够。 */
function tailwindDecls(token) {
  if (token === 'flex') return { display: 'flex' }
  if (token === 'grid') return { display: 'grid' }
  if (token === 'inline-flex') return { display: 'inline-flex' }
  if (token === 'flex-col' || token === 'flex-col-reverse') return { 'flex-direction': 'column' }
  if (token === 'flex-1') return { flex: '1 1 0%' }
  if (token === 'min-h-0') return { 'min-height': '0' }
  if (token === 'min-w-0') return { 'min-width': '0' }
  if (token === 'h-full') return { height: '100%' }
  if (token === 'overflow-y-auto' || token === 'overflow-y-scroll') return { 'overflow-y': 'auto' }
  if (token === 'overflow-auto' || token === 'overflow-scroll') return { overflow: 'auto' }
  if (token === 'overflow-hidden') return { overflow: 'hidden' }
  if (token === 'fixed') return { position: 'fixed' }
  if (token === 'absolute') return { position: 'absolute' }
  if (token === 'relative') return { position: 'relative' }
  const maxH = /^max-h-(?:\[(.+)\]|(.+))$/.exec(token)
  if (maxH) return { 'max-height': maxH[1] ?? maxH[2] }
  const h = /^h-\[(.+)\]$/.exec(token)
  if (h) return { height: h[1] }
  const gridRows = /^grid-rows-\[(.+)\]$/.exec(token)
  if (gridRows) return { 'grid-template-rows': gridRows[1].replace(/_/g, ' ') }
  return null
}

/* -------------------------------------------------------------- JSX 元素树 */

/** className 表达式里所有字符串字面量的 token 并集。

    `className={bodyClass}` 这种指向变量的写法要先解析出变量的字面量，
    否则元素会被当成「没有任何样式」，在链上冒充撑破布局的那一层——
    生图控制台的 `.imgc-body` 明明写了 min-height:0，第一版就是这么误报的。
    解析不出来的（函数返回值、props 传入）标记 unknown，判定退成 unresolved，
    宁可漏报也不能让 CI 报一个不存在的问题。 */
function collectTokens(node, locals, out, seen) {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    for (const t of node.text.split(/\s+/)) if (t) out.tokens.push(t)
    return
  }
  if (ts.isTemplateExpression(node)) {
    for (const t of node.head.text.split(/\s+/)) if (t) out.tokens.push(t)
    for (const span of node.templateSpans) {
      for (const t of span.literal.text.split(/\s+/)) if (t) out.tokens.push(t)
      collectTokens(span.expression, locals, out, seen)
    }
    return
  }
  if (ts.isIdentifier(node)) {
    const init = locals.get(node.text)
    if (!init || seen.has(node.text)) {
      out.unknown = true
      return
    }
    seen.add(node.text)
    collectTokens(init, locals, out, seen)
    return
  }
  if (ts.isCallExpression(node)) {
    // cn(...) / clsx(...) 只看实参，函数名本身不是类名
    for (const arg of node.arguments) collectTokens(arg, locals, out, seen)
    return
  }
  /* 条件表达式只看两个分支，条件本身不是类名。
     不排掉的话 `open ? '' : ' collapsed'` 里的 `open` 会被当成解析不了的类名变量，
     整个元素退成 unknown，链路判定跟着失效。`cond && 'x'` 同理只看右边。 */
  if (ts.isConditionalExpression(node)) {
    collectTokens(node.whenTrue, locals, out, seen)
    collectTokens(node.whenFalse, locals, out, seen)
    return
  }
  if (ts.isBinaryExpression(node)) {
    const op = node.operatorToken.kind
    if (
      op === ts.SyntaxKind.AmpersandAmpersandToken ||
      op === ts.SyntaxKind.BarBarToken ||
      op === ts.SyntaxKind.QuestionQuestionToken
    ) {
      collectTokens(node.right, locals, out, seen)
      return
    }
  }
  if (ts.isParenthesizedExpression(node)) {
    collectTokens(node.expression, locals, out, seen)
    return
  }
  if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
    out.unknown = true
    return
  }
  node.forEachChild((c) => collectTokens(c, locals, out, seen))
}

/** 文件内 `const x = '…'` / 模板串的字面量表，用于回填 className 变量。 */
function localClassVars(sf) {
  const locals = new Map()
  const visit = (node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      locals.set(node.name.text, node.initializer)
    }
    node.forEachChild(visit)
  }
  visit(sf)
  return locals
}

function tagOf(node) {
  const open = ts.isJsxSelfClosingElement(node) ? node : node.openingElement
  return open.tagName.getText()
}

function attrsOf(node, locals) {
  const open = ts.isJsxSelfClosingElement(node) ? node : node.openingElement
  const out = { classes: [], unknown: false, hasStyle: false }
  let sawClassName = false
  for (const a of open.attributes.properties) {
    if (ts.isJsxSpreadAttribute(a)) {
      // {...props} 可能带 className / style 进来，判不了
      out.unknown = true
      continue
    }
    const name = a.name.getText()
    if (name === 'className') {
      sawClassName = true
      if (!a.initializer) continue
      const bag = { tokens: [], unknown: false }
      collectTokens(a.initializer, locals, bag, new Set())
      out.classes.push(...bag.tokens)
      if (bag.unknown) out.unknown = true
    } else if (name === 'style') {
      // 内联 style 可能写了 height / overflow，静态判不了
      out.hasStyle = true
    }
  }
  if (!sawClassName && !out.hasStyle) out.bare = true
  return out
}

/** 收集一个文件里的 JSX 元素，带 parent 指针。 */
export function buildJsxTree(name, text) {
  const sf = ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const locals = localClassVars(sf)
  const nodes = []
  const visit = (node, parent) => {
    let self = parent
    if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) {
      const tag = tagOf(node)
      const info = {
        tag,
        ...attrsOf(node, locals),
        // 大写开头是组件：它渲染出什么 DOM（甚至是不是 portal 出去了）静态看不见
        component: /^[A-Z]/.test(tag) || tag.includes('.'),
        line: sf.getLineAndCharacterOfPosition(node.getStart()).line + 1,
        parent,
      }
      nodes.push(info)
      self = info
    }
    node.forEachChild((c) => visit(c, self))
  }
  visit(sf, null)
  return nodes
}

/* ------------------------------------------------------------------ 判定 */

/* 页面组件的根节点，其父级在别的文件（App 外壳）里。这两个落点是固定的，
   写进来才能把「整页滚不动」这类问题判到底，而不是一律记成 unresolved。
   外壳结构见 styles/app.css：
   `.app`（height:100vh; overflow:hidden; flex 行）→ `.main`（flex 列）→ 这里。 */
const SHELL_CHAIN = [
  { tag: 'div', classes: ['main'], synthetic: true },
  { tag: 'div', classes: ['app'], synthetic: true },
]
const SHELL_ROOTS = new Set(['page', 'content'])

/** 走到文件根之后，接上外壳的合成父链。 */
function shellParentOf(el) {
  if (el.synthetic) {
    const i = SHELL_CHAIN.indexOf(el)
    return SHELL_CHAIN[i + 1] ?? null
  }
  return el.classes.some((c) => SHELL_ROOTS.has(c)) ? SHELL_CHAIN[0] : null
}

const isLen = (v) => Boolean(v) && v !== 'auto' && v !== 'none' && v !== 'initial'
const isZero = (v) => /^0(?:px|%|rem|em)?$/.test(v ?? '')

/** overflow 简写可以写两个值（`overflow: hidden auto`），拆开取轴向。 */
function overflowAxis(s, axis) {
  const long = axis === 'y' ? s['overflow-y'] : s['overflow-x']
  if (long) return long
  if (!s.overflow) return 'visible'
  const parts = s.overflow.split(/\s+/)
  return parts.length > 1 ? (axis === 'x' ? parts[0] : parts[1]) : parts[0]
}

const SCROLLY = ['auto', 'scroll', 'overlay']
const scrollsY = (s) => SCROLLY.includes(overflowAxis(s, 'y'))
const scrollsX = (s) => SCROLLY.includes(overflowAxis(s, 'x'))

/** 一个轴非 visible，另一个轴的计算值也会变成 auto（css-overflow §3）。
    两轴都 visible 时 min-height:auto 才解析成内容高度。 */
const overflowVisible = (s) => overflowAxis(s, 'y') === 'visible' && overflowAxis(s, 'x') === 'visible'

const isFlex = (s) => ['flex', 'inline-flex'].includes(s.display)
const isColumn = (s) => (s['flex-direction'] ?? 'row').startsWith('column')
const isGrid = (s) => ['grid', 'inline-grid'].includes(s.display)
/** grid 只在有 1fr 行（且没写 minmax(0）时才会因子项 min-height:auto 撑破 */
const gridRowsFr = (s) => {
  const v = s['grid-template-rows']
  return Boolean(v) && /\bfr\b/.test(v) && !/minmax\(\s*0/.test(v)
}
const gridColsFr = (s) => {
  const v = s['grid-template-columns']
  return Boolean(v) && /\bfr\b/.test(v) && !/minmax\(\s*0/.test(v)
}

/** 这一层是否兜住了高度（链可以停在这里）。 */
const boundsHeight = (s) =>
  isLen(s.height) || isLen(s['max-height']) || ['fixed', 'absolute'].includes(s.position)

/** 子项在列向 flex / fr grid 里是否被允许收缩到比内容矮。
    overflow 非 visible 时自动最小尺寸本来就是 0，不用写 min-height。 */
const canShrinkY = (s) =>
  isZero(s['min-height']) || isLen(s.height) || isLen(s['max-height']) || !overflowVisible(s)
const canShrinkX = (s) =>
  isZero(s['min-width']) || isLen(s.width) || isLen(s['max-width']) || !overflowVisible(s)

/** 绑定一份 CSS 索引，返回判定器。测试可以喂合成的 CSS + TSX。 */
export function createAuditor(cssIndex) {
  const labelOf = (el) => `${el.tag}.${el.classes.filter((c) => cssIndex.index.has(c)).join('.')}`

  const styleOf = (el) => {
    const merged = {}
    for (const token of el.classes) {
      const fromCss = cssIndex.index.get(token)
      if (fromCss) mergeStyle(merged, fromCss)
      const fromTw = tailwindDecls(token)
      if (fromTw) mergeStyle(merged, fromTw)
    }
    return merged
  }

  function analyze(el) {
  const self = styleOf(el)
  if (!scrollsY(self) && !scrollsX(self)) return null

  const axisY = scrollsY(self)
  // 自带高度上限的滚动容器不依赖祖先链
  if (axisY && (isLen(self.height) || isLen(self['max-height']))) {
    return { verdict: 'ok', reason: '自带 height/max-height', el }
  }

  const offenders = []
  let cur = el
  let parent = el.parent ?? shellParentOf(el)
  let hops = 0
  while (parent && hops < 30) {
    // 判不了的层就此打住：组件的真实 DOM、来路不明的 className、内联 style
    // 都可能自带高度。宁可什么都不说，也不能报一个不存在的问题。
    if (parent.component || parent.unknown || parent.hasStyle) {
      return offenders.length
        ? { verdict: 'broken', offenders, el }
        : { verdict: 'unresolved', reason: `祖先 ${parent.tag} 的盒模型静态判不了`, el }
    }
    const ps = styleOf(parent)
    const cs = styleOf(cur)
    const curKnown = !cur.unknown && !cur.hasStyle && !cur.component
    if (curKnown && axisY && ((isFlex(ps) && isColumn(ps)) || (isGrid(ps) && gridRowsFr(ps)))) {
      if (!canShrinkY(cs)) {
        offenders.push({
          el: cur,
          parent,
          axis: 'y',
          kind: isGrid(ps) ? 'grid-1fr' : 'flex-column',
        })
      }
    }
    if (curKnown && !axisY && isFlex(ps) && !isColumn(ps)) {
      if (!canShrinkX(cs)) offenders.push({ el: cur, parent, axis: 'x', kind: 'flex-row' })
    }
    if (curKnown && !axisY && isGrid(ps) && gridColsFr(ps)) {
      if (!canShrinkX(cs)) offenders.push({ el: cur, parent, axis: 'x', kind: 'grid-1fr' })
    }
    if (boundsHeight(ps)) {
      return offenders.length
        ? { verdict: 'broken', offenders, el }
        : { verdict: 'ok', reason: '祖先链已兜住高度', el }
    }
    /* 祖先自己也声明了滚动。这里判不下去，只能停：
       祖先若是被 flex 拉伸兜住高度的（`.panel` 就是），内层滚动完全正常；
       祖先若真的随内容长，内层滚动条才永不出现。两者静态区分不了。
       而且索引里混进了 @media 里的 overflow（窄屏才生效），
       按「祖先在滚」下判定会一路误报——PromptStudio、循环配置都是这么中的。 */
    if (axisY && scrollsY(ps) && !isLen(ps.height) && !isLen(ps['max-height'])) {
      return offenders.length
        ? { verdict: 'broken', offenders, el }
        : { verdict: 'unresolved', reason: `祖先 ${labelOf(parent)} 也声明了滚动，嵌套滚动判不了`, el }
    }
    cur = parent
    parent = parent.parent ?? shellParentOf(parent)
    hops += 1
  }
  if (offenders.length) return { verdict: 'broken', offenders, el }
  return { verdict: 'unresolved', reason: '祖先链走出本文件', el }
  }

  return { analyze, styleOf, labelOf }
}

/** 对给定的 CSS / TSX 源码跑一遍判定。sources 形如 `[{ name, text }]`。 */
export function audit({ css, tsx }) {
  const cssIndex = buildCssIndex(css)
  const { analyze, labelOf } = createAuditor(cssIndex)
  const results = []
  for (const { name, text } of tsx) {
    for (const el of buildJsxTree(name, text)) {
      if (el.classes.length === 0) continue
      const r = analyze(el)
      if (r) results.push({ ...r, file: name })
    }
  }
  return { results, labelOf }
}

/** 读全仓源码跑一遍。 */
export function auditRepo() {
  const read = (exts) =>
    walkFiles(SRC, exts).map((f) => ({ name: relative(ROOT, f), text: readFileSync(f, 'utf8') }))
  return audit({ css: read(['.css']), tsx: read(['.tsx']) })
}

/* ------------------------------------------------------------------ 主流程 */

function main() {
const args = new Set(process.argv.slice(2))
const verbose = args.has('--verbose')
const asTable = args.has('--table')

const { results, labelOf: label } = auditRepo()

const broken = results.filter(
  (r) => r.verdict === 'broken' && !ALLOW.has(`${r.file}:${r.el.line}:${r.el.classes.join('.')}`),
)
const unresolved = results.filter((r) => r.verdict === 'unresolved')
const ok = results.filter((r) => r.verdict === 'ok')

if (asTable) {
  console.log('| 文件:行 | 滚动容器 | 判定 | 说明 |')
  console.log('| --- | --- | --- | --- |')
  for (const r of results) {
    const note =
      r.verdict === 'broken'
        ? r.offenders.map((o) => `${label(o.el)} 在 ${label(o.parent)}(${o.kind}) 里缺 min-${o.axis === 'y' ? 'height' : 'width'}:0`).join('；')
        : (r.reason ?? '')
    console.log(`| ${r.file}:${r.el.line} | ${label(r.el)} | ${r.verdict} | ${note} |`)
  }
  process.exit(0)
}

for (const r of broken) {
  console.error(`\n✗ ${r.file}:${r.el.line}  ${label(r.el)} 声明了滚动但滚不动`)
  for (const o of r.offenders) {
    const prop = o.axis === 'y' ? 'min-height' : 'min-width'
    console.error(
      `  └ ${label(o.el)} 是 ${label(o.parent)}（${o.kind}）的子项，缺 ${prop}: 0`,
    )
  }
}

if (verbose) {
  for (const r of unresolved) {
    console.log(`? ${r.file}:${r.el.line}  ${label(r.el)} — ${r.reason}`)
  }
}

const total = results.length
if (broken.length > 0) {
  console.error(
    `\n滚动链路守卫：${total} 个滚动容器，${broken.length} 个滚不动。` +
      `给报错里指名的元素补 min-height: 0（横向 min-width: 0），别写死高度。\n`,
  )
  process.exit(1)
}

console.log(
  `滚动链路守卫通过：${total} 个滚动容器（${ok.length} 条链已兜住，` +
    `${unresolved.length} 条祖先链走出组件、静态判不了${verbose ? '' : '，--verbose 可列'}）。`,
)
}

// 被 import 时只导出函数，直接执行才跑全仓扫描
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
