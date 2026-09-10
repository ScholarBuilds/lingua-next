/* @提及 token 输入（模块 17 · FR-465，M1 遗留补齐）。

   提示词框里打 `@` 弹候选层，选中的图插成一个不可编辑的 token。构建请求时
   token 编号成「图N」，正文前面拼一张映射表——模型才知道「图1」指的是哪张，
   参考图本身仍按 `ref_asset_ids` 直引资产（BR-144），这里只负责措辞。

   自洽的受控组件：不认识画布、不认识创作台，`upstream` 候选由调用方给，
   资产库候选自己查。接进哪个框由调用方决定。

   > [!warning] 受控 contenteditable 的光标陷阱
   >
   > 每次 props.value.html 变化就重设 innerHTML，光标会被打回开头——打一个字
   > 跳一次，等于不能用。所以要区分「这次变化是不是自己刚 emit 出去的」：
   > 存住最后一次 emit 的 html 比对，是自己的就不动 DOM。
   > 判据是**值有没有真的变过**而不是「是不是首帧」，StrictMode 双挂载下
   > 后者会失效（CLAUDE.md 已记档）。

   几处照实说明的行为（STD-UI-006）：
   - 外部真的改了 html（换草稿、清空、撤销）时会重设 DOM，光标落到末尾，
     不保留原来在正文中间的位置；
   - 引用上限 20 个按**去重后的资产数**算，插已经引用过的图不占额度；
   - 资产库候选走 `/images/assets?q=`，服务端搜的是提示词与摘要，
     搜不到就是真没有，不做前端二次过滤。 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { useQuery } from '@tanstack/react-query'
import { toast } from 'sonner'

import { useEscapeClose } from '../../components/Overlay'
import { apiImage } from '../../lib/api-image'
import type { ImageAsset } from '../../lib/api-image'
import { MAX_REFS } from './canvasStore'
import './mention-input.css'

/** 被引用的资产 */
export interface MentionRef {
  asset_id: number
  /** 展示名，插进正文里的 @xxx */
  label: string
  thumb_url: string
}

export interface MentionValue {
  /** 富文本 HTML（含 token span），存进节点草稿用它才能还原 */
  html: string
  /** 纯文本正文，token 位置写成「图N」 */
  text: string
  /** 按出现顺序去重后的引用 */
  refs: MentionRef[]
}

/** 空值常量。调用方建草稿时直接用它，省得各处各写一份字面量 */
export const EMPTY_MENTION: MentionValue = { html: '', text: '', refs: [] }

/** 引用上限。轮数直接乘钱，参考图也一样——超了拒绝再插而不是静默丢 */
/** 插入上限。**与 canvasStore 的 MAX_REFS 同源**——两边各写一个数的话，
 *  多出来的芯片能插进去却不会上送，正文里的「图N」指向一张不存在的图。 */
export const MAX_MENTION_REFS = MAX_REFS

const TOKEN_CLASS = 'smi-token'
/** 候选层尺寸，定位夹取要用 */
const MENU_W = 300
const MENU_H = 320

/* ==================== 值的读写 ==================== */

type Part = { kind: 'text'; text: string } | { kind: 'token'; ref: MentionRef }

function escapeHtml(raw: string): string {
  return raw
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** 是不是一个提及 token。不写成类型谓词：调用点已经是 HTMLElement，
    否定分支会被窄化成 never，后面读 tagName 就编译不过 */
function isToken(node: Node | null): boolean {
  return node instanceof HTMLElement && node.classList.contains(TOKEN_CLASS)
}

/** 缩略图丢了也别让 token 变成空白方块：资产的缩略图端点按 id 就能拼出来，
    只是少了 `?v=` 缓存版本号。html 是存起来的东西，解析时按边界数据对待 */
function tokenRef(el: HTMLElement): MentionRef {
  const id = Number(el.dataset.assetId ?? '0')
  const label = el.dataset.label ?? el.textContent?.replace(/^@/, '') ?? `资产 ${id}`
  const thumb = el.dataset.thumb ?? `/api/images/assets/${id}/thumb`
  return { asset_id: id, label, thumb_url: thumb }
}

function tokenHtml(ref: MentionRef): string {
  return (
    `<span class="${TOKEN_CLASS}" contenteditable="false"` +
    ` data-asset-id="${ref.asset_id}"` +
    ` data-label="${escapeHtml(ref.label)}"` +
    ` data-thumb="${escapeHtml(ref.thumb_url)}">@${escapeHtml(ref.label)}</span>`
  )
}

/** 敲回车时浏览器会包一层块级元素（Chrome 是 div，Firefox 直接给 br），
    读的时候统一还原成换行 */
const BLOCK_TAGS = new Set(['DIV', 'P', 'LI', 'H1', 'H2', 'H3', 'H4', 'BLOCKQUOTE', 'PRE'])

/** 块末尾那个 br 是浏览器塞的占位符，不是真换行——跟着算会多出一行 */
function isFillerBr(el: HTMLElement): boolean {
  return el.tagName === 'BR' && el.nextSibling === null
}

function readParts(root: HTMLElement): Part[] {
  const parts: Part[] = []
  const pushText = (text: string): void => {
    if (text === '') return
    const last = parts[parts.length - 1]
    if (last !== undefined && last.kind === 'text') last.text += text
    else parts.push({ kind: 'text', text })
  }

  const walk = (node: Node): void => {
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === Node.TEXT_NODE) {
        pushText(child.nodeValue ?? '')
        continue
      }
      if (!(child instanceof HTMLElement)) continue
      if (isToken(child)) {
        parts.push({ kind: 'token', ref: tokenRef(child) })
        continue
      }
      if (child.tagName === 'BR') {
        if (!isFillerBr(child)) pushText('\n')
        continue
      }
      if (BLOCK_TAGS.has(child.tagName)) {
        if (parts.length > 0) pushText('\n')
        walk(child)
        continue
      }
      walk(child)
    }
  }

  walk(root)
  return parts
}

/** 进 innerHTML 之前的最后一道闸。
 *
 *  正常路径下 `value.html` 都由 `partsToValue` 生成，里面的文本段已经 escapeHtml 过。
 *  但调用方一旦把**纯文本**当 html 传进来（历史上就发生过：`prompt_draft_html ?? draft`），
 *  `a < b` 会变形、词库条目里的 `<img onerror>` 会直接执行。
 *
 *  判据是「看起来像不像我们自己生成的」：我们生成的 html 要么不含 `<`，
 *  要么含 token 的标记类名。两条都不满足就整段转义——宁可把真 html 显示成文字，
 *  也不执行来路不明的标签。 */
function safeHtml(html: string): string {
  if (!html.includes('<')) return html
  if (html.includes(TOKEN_CLASS) || /^(?:[^<]|<br\s*\/?>)*$/i.test(html)) return html
  return escapeHtml(html).replace(/\n/g, '<br>')
}

function partsToValue(parts: Part[]): MentionValue {
  const refs: MentionRef[] = []
  const numberOf = new Map<number, number>()
  for (const part of parts) {
    if (part.kind !== 'token' || numberOf.has(part.ref.asset_id)) continue
    numberOf.set(part.ref.asset_id, refs.length + 1)
    refs.push(part.ref)
  }
  const html = parts
    .map((p) =>
      p.kind === 'token' ? tokenHtml(p.ref) : escapeHtml(p.text).replace(/\n/g, '<br>'),
    )
    .join('')
  const text = parts
    .map((p) => (p.kind === 'token' ? `图${numberOf.get(p.ref.asset_id)}` : p.text))
    .join('')
  return { html, text, refs }
}

/** 已有的纯文本草稿升级成 MentionValue。接入时老数据得有条路进来 */
export function mentionFromText(text: string): MentionValue {
  if (text === '') return EMPTY_MENTION
  return partsToValue([{ kind: 'text', text }])
}

/** 在末尾追加一段纯文本，**保留已有的 @ 芯片**。

    套词库原来走 `mentionFromText(旧正文 + 新条目)`：旧正文里的芯片在 `text` 里
    早就退化成「图1」三个字，再升格一次就把映射表整个丢了——正文上还写着「图1」，
    refs 却空了，下一次出图时那个「图1」指向的是另一张图（或者干脆没有）。
    追加是纯字符串活，html 与 text 两边同步走一步即可，不必碰 DOM。 */
export function mentionAppendText(value: MentionValue, text: string): MentionValue {
  const add = text.trim()
  if (add === '') return value
  // 空草稿不补换行，否则套第一条词库就先空出一行
  const gap = value.text === '' ? '' : '\n'
  return {
    html: value.html + (gap === '' ? '' : '<br>') + escapeHtml(add).replace(/\n/g, '<br>'),
    text: value.text + gap + add,
    refs: value.refs,
  }
}

/** 这一下键是不是「提交」。

    ⌘（mac）与 Ctrl（其它平台）都收：同一台机器上外接键盘换来换去是常事，
    只认一个的话另一半用户按了没反应。裸 Enter **不是**提交——提示词经常要分段写，
    在这种框里把 Enter 抢成提交是最招人恨的交互之一。 */
export function isSubmitChord(e: {
  key: string
  metaKey: boolean
  ctrlKey: boolean
  altKey?: boolean
  shiftKey?: boolean
}): boolean {
  if (e.key !== 'Enter') return false
  if (e.altKey === true || e.shiftKey === true) return false
  return e.metaKey || e.ctrlKey
}

/** 存下来的 html 还原成 MentionValue。画布/创作台加载草稿时走它——
    refs 从 token span 上重建，不必另存一份引用清单 */
export function mentionFromHtml(html: string): MentionValue {
  if (html === '') return EMPTY_MENTION
  const host = document.createElement('div')
  host.innerHTML = html
  return partsToValue(readParts(host))
}

/** 把 MentionValue 拼成最终 prompt：正文前加一段「图N：说明」的映射表。
    没有引用时直接返回正文，不加空映射表 */
export function buildMentionPrompt(value: MentionValue): string {
  const body = value.text.trim()
  if (value.refs.length === 0) return body
  const table = value.refs
    .map((ref, i) => `图${i + 1}：${ref.label}（asset ${ref.asset_id}）`)
    .join('\n')
  return `${table}\n\n用户需求：${body}`
}

/* ==================== 选区助手 ==================== */

function selectionRange(root: HTMLElement): Range | null {
  const sel = window.getSelection()
  if (sel === null || sel.rangeCount === 0) return null
  const range = sel.getRangeAt(0)
  return root.contains(range.startContainer) ? range : null
}

function putCaret(node: Node, offset: number): void {
  const range = document.createRange()
  range.setStart(node, offset)
  range.collapse(true)
  const sel = window.getSelection()
  sel?.removeAllRanges()
  sel?.addRange(range)
}

function caretToEnd(root: HTMLElement): void {
  const range = document.createRange()
  range.selectNodeContents(root)
  range.collapse(false)
  const sel = window.getSelection()
  sel?.removeAllRanges()
  sel?.addRange(range)
}

/** 光标紧邻的前一个节点。返回 null = 前面还有字符，删除交给浏览器逐字处理 */
function nodeBeforeCaret(range: Range, root: HTMLElement): Node | null {
  let node: Node = range.startContainer
  const offset = range.startOffset
  if (node.nodeType === Node.TEXT_NODE) {
    if (offset > 0) return null
  } else if (offset > 0) {
    return node.childNodes[offset - 1] ?? null
  }
  while (node !== root) {
    const prev: Node | null = node.previousSibling
    if (prev !== null) return prev
    const parent: Node | null = node.parentNode
    if (parent === null) return null
    node = parent
  }
  return null
}

/** 光标紧邻的后一个节点，Delete 键用 */
function nodeAfterCaret(range: Range, root: HTMLElement): Node | null {
  let node: Node = range.startContainer
  const offset = range.startOffset
  if (node.nodeType === Node.TEXT_NODE) {
    if (offset < (node.nodeValue ?? '').length) return null
  } else {
    return node.childNodes[offset] ?? null
  }
  while (node !== root) {
    const next: Node | null = node.nextSibling
    if (next !== null) return next
    const parent: Node | null = node.parentNode
    if (parent === null) return null
    node = parent
  }
  return null
}

/* ==================== 触发检测 ==================== */

interface Trigger {
  query: string
  /** 候选层锚点：触发用的那个 `@` 所占矩形 */
  left: number
  below: number
  above: number
}

/** `@` 前面必须是行首或这些字符，否则 `a@b` 这种邮箱写法会被误当提及 */
const TRIGGER_HEAD = /[\s(（【[「，。、:：;；!！?？]/

function readTrigger(root: HTMLElement): Trigger | null {
  const range = selectionRange(root)
  if (range === null || !range.collapsed) return null
  const node = range.startContainer
  if (node.nodeType !== Node.TEXT_NODE) return null
  const head = (node.nodeValue ?? '').slice(0, range.startOffset)
  const at = head.lastIndexOf('@')
  if (at < 0) return null
  const query = head.slice(at + 1)
  // 空白进了关键词就说明这一段已经不是在提及了；20 字是随手打的上限，防止整段正文当查询发出去
  if (query.length > 20 || /\s/.test(query)) return null
  const before = at > 0 ? head[at - 1] : ''
  if (before !== '' && !TRIGGER_HEAD.test(before)) return null
  const probe = document.createRange()
  probe.setStart(node, at)
  probe.setEnd(node, range.startOffset)
  const rect = probe.getBoundingClientRect()
  return { query, left: rect.left, below: rect.bottom, above: rect.top }
}

/* ==================== 候选来源 ==================== */

function clip(text: string, max = 14): string {
  return text.length > max ? `${text.slice(0, max)}…` : text
}

/** 结构化提示词是一整块 JSON，截头只会得到「{」开头的碎片，那还不如报编号 */
function assetToRef(asset: ImageAsset): MentionRef {
  const caption = asset.caption?.trim() ?? ''
  const firstLine = asset.prompt.trim().split('\n')[0]?.trim() ?? ''
  const label =
    caption !== ''
      ? clip(caption)
      : firstLine !== '' && !firstLine.startsWith('{')
        ? clip(firstLine)
        : `资产 ${asset.id}`
  return { asset_id: asset.id, label, thumb_url: asset.thumb_url }
}

/* ==================== 组件 ==================== */

type Tab = 'upstream' | 'assets'

export function MentionInput(props: {
  value: MentionValue
  onChange: (next: MentionValue) => void
  /** @ 弹层的候选来源：上游链路图 + 资产库。上游为空时只给资产库 */
  upstream?: MentionRef[]
  placeholder?: string
  disabled?: boolean
  /** 粘贴或拖进来的文件。不给 = 这个输入框不收文件（粘贴仍按纯文本走） */
  onFiles?: (files: File[]) => void
  /** ⌘/Ctrl + Enter 提交。不给 = 这个框没有提交语义，那个组合键交回浏览器。
   *
   *  与画布上的 ⌘Enter（跑整条链）不冲突：全局快捷键判到焦点在可编辑元素里
   *  就整套让路（`canvas-core/shortcuts.ts` 的 isEditable），所以同一个组合键
   *  在框里是「出图」、在画布上是「跑链」，两者永远不会同时命中。 */
  onSubmit?: () => void
}): JSX.Element {
  const {
    value,
    onChange,
    upstream,
    placeholder = '',
    disabled = false,
    onFiles,
    onSubmit,
  } = props

  const boxRef = useRef<HTMLDivElement | null>(null)
  /** 最后一次自己 emit 出去的 html。props 回来的是这一份就别动 DOM */
  const emittedRef = useRef<string | null>(null)
  const composingRef = useRef(false)
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange

  const [trigger, setTrigger] = useState<Trigger | null>(null)
  const [tab, setTab] = useState<Tab>('upstream')
  const [active, setActive] = useState(0)
  const [debounced, setDebounced] = useState('')

  const upstreamAll = upstream ?? []
  const hasUpstream = upstreamAll.length > 0
  const openTab: Tab = hasUpstream ? tab : 'assets'
  const open = trigger !== null && !disabled

  const emit = useCallback((): void => {
    const el = boxRef.current
    if (el === null) return
    const next = partsToValue(readParts(el))
    emittedRef.current = next.html
    onChangeRef.current(next)
  }, [])

  // 只有外部真的换了内容才重设 DOM；自己刚发出去的那份原样回来时不动，否则光标每敲一个字就回到开头
  useLayoutEffect(() => {
    const el = boxRef.current
    if (el === null || value.html === emittedRef.current) return
    el.innerHTML = safeHtml(value.html)
    emittedRef.current = value.html
    if (document.activeElement === el) caretToEnd(el)
  }, [value.html])

  // 关掉候选层时顺手复位，免得下次打开还停在上次的选中项
  useEffect(() => {
    if (open) return
    setActive(0)
  }, [open])

  useEffect(() => {
    const id = window.setTimeout(() => setDebounced(trigger?.query ?? ''), 180)
    return () => window.clearTimeout(id)
  }, [trigger?.query])

  // 候选层是浮层，入全局 Esc 栈才不会和外层面板抢（STD-UI-002a）
  useEscapeClose(() => setTrigger(null), open)

  const assets = useQuery({
    queryKey: ['smi-assets', debounced],
    queryFn: () => apiImage.assets({ q: debounced === '' ? undefined : debounced, limit: 40 }),
    enabled: open && openTab === 'assets',
    staleTime: 30_000,
  })

  const query = trigger?.query ?? ''
  const items: MentionRef[] =
    openTab === 'upstream'
      ? upstreamAll.filter(
          (r) => query === '' || r.label.toLowerCase().includes(query.toLowerCase()),
        )
      : (assets.data?.items ?? []).map(assetToRef)
  const activeIndex = items.length === 0 ? -1 : Math.min(active, items.length - 1)

  const syncTrigger = useCallback((): void => {
    const el = boxRef.current
    if (el === null || disabled) return
    if (composingRef.current) return
    const next = readTrigger(el)
    setTrigger(next)
    if (next !== null) setActive(0)
  }, [disabled])

  const insertRef = (ref: MentionRef): void => {
    const el = boxRef.current
    if (el === null) return
    const current = partsToValue(readParts(el)).refs
    const known = current.some((r) => r.asset_id === ref.asset_id)
    if (!known && current.length >= MAX_MENTION_REFS) {
      toast.error(`一条提示词最多引用 ${MAX_MENTION_REFS} 张图，当前已有 ${current.length} 张`)
      return
    }
    const range = selectionRange(el)
    if (range === null) return

    // 候选层是异步渲染的，插入时重新按当前光标定位那个触发用的 `@`，不留旧 DOM 引用
    const node = range.startContainer
    if (node.nodeType === Node.TEXT_NODE) {
      const head = (node.nodeValue ?? '').slice(0, range.startOffset)
      const at = head.lastIndexOf('@')
      if (at >= 0) range.setStart(node, at)
    }
    range.deleteContents()

    const span = document.createElement('span')
    span.className = TOKEN_CLASS
    span.contentEditable = 'false'
    span.dataset.assetId = String(ref.asset_id)
    span.dataset.label = ref.label
    span.dataset.thumb = ref.thumb_url
    span.textContent = `@${ref.label}`
    // token 后面留一个空格：光标要有落脚点，否则 token 在末尾时插不进字
    const tail = document.createTextNode(' ')
    const frag = document.createDocumentFragment()
    frag.append(span, tail)
    range.insertNode(frag)
    putCaret(tail, 1)

    setTrigger(null)
    emit()
  }

  const removeAdjacentToken = (
    e: ReactKeyboardEvent<HTMLDivElement>,
    dir: 'back' | 'forward',
  ): void => {
    const el = boxRef.current
    if (el === null) return
    const range = selectionRange(el)
    if (range === null || !range.collapsed) return
    const target = dir === 'back' ? nodeBeforeCaret(range, el) : nodeAfterCaret(range, el)
    if (!(target instanceof HTMLElement) || !isToken(target)) return
    // 浏览器对 contenteditable=false 的删除行为各家不一（有的先选中、有的切半截），自己整体删掉
    e.preventDefault()
    target.remove()
    emit()
  }

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>): void => {
    // 中文输入法选词期间的回车/方向键是给候选词用的，不能截
    if (e.nativeEvent.isComposing) return
    /* 提交优先于候选层：⌘Enter 的意思一直是「就这样，发」，
       候选层恰好开着时也不该改成「插入候选」——那是裸 Enter 的活。 */
    if (onSubmit !== undefined && isSubmitChord(e)) {
      e.preventDefault()
      setTrigger(null)
      onSubmit()
      return
    }
    if (open) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        if (items.length === 0) return
        const step = e.key === 'ArrowDown' ? 1 : items.length - 1
        setActive((i) => (Math.min(i, items.length - 1) + step) % items.length)
        return
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        if (activeIndex < 0) return
        e.preventDefault()
        insertRef(items[activeIndex])
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        setTrigger(null)
        return
      }
    }
    if (e.key === 'Escape') {
      const el = boxRef.current
      // 两段式（STD-UI-002b）：有草稿时第一下 Esc 只失焦，第二下才让外层浮层关
      if (el !== null && readParts(el).length > 0) {
        e.preventDefault()
        e.stopPropagation()
        el.blur()
      }
      return
    }
    if (e.key === 'Backspace') removeAdjacentToken(e, 'back')
    else if (e.key === 'Delete') removeAdjacentToken(e, 'forward')
  }

  const onKeyUp = (e: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) syncTrigger()
  }

  const isEmpty = value.html === ''
  const menuLeft = Math.max(8, Math.min(trigger?.left ?? 0, window.innerWidth - MENU_W - 8))
  // 下面放不下才翻上去，且上面得比下面宽敞——否则矮视口里翻上去反而顶出屏幕外
  const spaceBelow = window.innerHeight - (trigger?.below ?? 0)
  const spaceAbove = trigger?.above ?? 0
  const flipUp = spaceBelow < MENU_H && spaceAbove > spaceBelow
  // 真实可用高度盖掉 css 里的 max-height，两头都不会跑出视口
  const menuMaxH = Math.max(140, Math.min(MENU_H, (flipUp ? spaceAbove : spaceBelow) - 12))
  const menuStyle = flipUp
    ? { left: menuLeft, bottom: window.innerHeight - spaceAbove + 6, maxHeight: menuMaxH }
    : { left: menuLeft, top: (trigger?.below ?? 0) + 6, maxHeight: menuMaxH }

  return (
    <div className="smi-wrap">
      <div
        ref={boxRef}
        className="smi-editor"
        contentEditable={!disabled}
        role="textbox"
        aria-multiline="true"
        aria-label={placeholder === '' ? '提示词' : placeholder}
        data-empty={isEmpty ? 'true' : 'false'}
        data-placeholder={placeholder}
        suppressContentEditableWarning
        onInput={() => {
          emit()
          syncTrigger()
        }}
        onKeyDown={onKeyDown}
        onKeyUp={onKeyUp}
        onClick={syncTrigger}
        onBlur={() => setTrigger(null)}
        onCompositionStart={() => {
          composingRef.current = true
        }}
        onCompositionEnd={() => {
          composingRef.current = false
          emit()
          syncTrigger()
        }}
        onPaste={(e) => {
          /* 先看有没有文件：截图、从访达复制的文件、从别的应用拖来的图，
             都走附件那条路（与 Claude / Codex 的输入框同款）。
             判在文本之前——很多来源会**同时**给 files 和一段 text/plain
             （比如访达复制的文件带着文件名），先读文本的话文件就丢了。 */
          const files = Array.from(e.clipboardData.files ?? [])
          if (files.length > 0 && onFiles !== undefined) {
            e.preventDefault()
            onFiles(files)
            return
          }
          // 只收纯文本：外部 HTML 粘进来会把样式和标签一起带进草稿
          e.preventDefault()
          const text = e.clipboardData.getData('text/plain')
          if (text !== '') document.execCommand('insertText', false, text)
        }}
        onDragOver={(e) => {
          if (onFiles === undefined) return
          if (!Array.from(e.dataTransfer.types).includes('Files')) return
          // 拦下来别让它冒泡到画布——画布的 drop 会把文件建成节点，
          // 而用户是拖进输入框的，意思是"带上它"不是"放到画布上"
          e.preventDefault()
          e.stopPropagation()
          e.dataTransfer.dropEffect = 'copy'
        }}
        onDrop={(e) => {
          if (onFiles === undefined) return
          const files = Array.from(e.dataTransfer.files ?? [])
          if (files.length === 0) return
          e.preventDefault()
          e.stopPropagation()
          onFiles(files)
        }}
      />

      {open &&
        createPortal(
          <div
            className="smi-menu"
            style={menuStyle}
            role="listbox"
            aria-label="提及候选"
            // 点候选不能让输入框失焦，否则光标丢了就插不回原位
            onMouseDown={(e) => e.preventDefault()}
          >
            <div className="smi-menu-head">
              {hasUpstream && (
                <button
                  type="button"
                  className={openTab === 'upstream' ? 'smi-tab smi-tab-on' : 'smi-tab'}
                  onClick={() => setTab('upstream')}
                >
                  上游 {upstreamAll.length}
                </button>
              )}
              <button
                type="button"
                className={openTab === 'assets' ? 'smi-tab smi-tab-on' : 'smi-tab'}
                onClick={() => setTab('assets')}
              >
                资产库
              </button>
              <span className="smi-query">{query === '' ? '打字筛选' : `@${query}`}</span>
            </div>

            <div className="smi-list">
              {openTab === 'assets' && assets.isLoading && (
                <p className="smi-note">搜索资产库…</p>
              )}
              {openTab === 'assets' && assets.isError && (
                <p className="smi-note">
                  资产库搜索失败：
                  {assets.error instanceof Error ? assets.error.message : '未知错误'}
                </p>
              )}
              {items.length === 0 && !(openTab === 'assets' && assets.isLoading) && (
                <p className="smi-note">
                  {openTab === 'upstream' ? '上游链路上没有匹配的图' : '资产库里没搜到匹配的图'}
                </p>
              )}
              {items.map((ref, i) => (
                <button
                  type="button"
                  key={`${ref.asset_id}-${i}`}
                  className={i === activeIndex ? 'smi-opt smi-opt-on' : 'smi-opt'}
                  role="option"
                  aria-selected={i === activeIndex}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => insertRef(ref)}
                >
                  <img src={ref.thumb_url} alt="" loading="lazy" />
                  <span className="smi-opt-label">{ref.label}</span>
                  <span className="smi-opt-id">#{ref.asset_id}</span>
                </button>
              ))}
            </div>

            <p className="smi-foot">
              ↑↓ 选 · Enter 插入 · Esc 关
              <span className="smi-count">
                已引用 {value.refs.length}/{MAX_MENTION_REFS}
              </span>
            </p>
          </div>,
          document.body,
        )}
    </div>
  )
}
