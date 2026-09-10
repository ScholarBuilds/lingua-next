/* 提示词面板（FR-478）：任何有提示词框的工具都能挂它——创作台、画布、对话生图。

   **从居中弹窗改成右侧面板**。挑提示词是「看着画布挑」的事：哪张图要重画、
   上一版的构图长什么样，都在画布中央摆着；一个居中弹窗把它们全盖住，用户只能
   关掉浮层看一眼再打开、再从头翻一遍列表。面板贴右侧滑入，宽度可拖也记得住，
   钳制规则保证画布至少留 `CANVAS_KEEP_W`（见 prompt-panel.ts）。

   **不做遮罩、不点外面关闭**：面板开着的时候画布仍然要能拖能点，那正是它存在的理由。
   关闭走右上角的按钮或 Esc，Esc 由 `useEscapeClose` 接进全局浮层栈，只关最上面
   那一层（STD-UI-002）。

   **增删查改一律复用提示词库页那一套**：编辑器（含 AI 写词）就是那边导出的
   `PromptEditor`，按需动态载入——静态 import 会与库页构成循环依赖（库页反过来引
   本文件的 `fetchPromptLibrary`），本仓在循环依赖 + TDZ 上吃过整页白屏而 vitest 全绿的亏。
   写库端点全走 `apiStudio`，AI 只走 `POST /studio/prompts/compose` 那一个端点，
   产出落编辑器不入库。

   放在这个文件而不是页面里，是为了让复用方只依赖这一个叶子模块：页面会拉进
   左栏、分组树、版本历史一整套，面板不需要那些。normalizePrompt 也在这里导出，
   页面反过来引它。 */

import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from 'react'
import { createPortal } from 'react-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'

import { Overlay, useEscapeClose } from '../../components/Overlay'
import { useFullscreenElement } from '../../components/FullscreenPortal'
import {
  IconAlert,
  IconArrowLeft,
  IconClose,
  IconEdit,
  IconFileText,
  IconPlus,
  IconSearch,
  IconSparkle,
  IconStar,
  IconTrash,
} from '../../components/icons'
import { Picker } from '@/components/ui/picker'
import { jsonBody, request } from '../../lib/api-image'
import { apiStudio } from '../../lib/api-studio'
import type { PromptGroup, PromptItem, PromptVariable } from '../../lib/api-studio'
import { SchemaForm, describeSchema, schemaDefaults, validateFields } from './SchemaForm'
import type { SchemaIssue } from './SchemaForm'
import { promptDigest, promptStats } from './prompt-digest'
import { toRenderValues, variableSchema } from './prompt-variables'
import {
  PANEL_MAX_W,
  PANEL_MIN_W,
  PANEL_QUERY_DEFAULTS,
  blankDraft,
  clampPanelWidth,
  editDraft,
  filterPrompts,
  loadPanelWidth,
  needsFill,
  savePanelWidth,
  scopeCounts,
} from './prompt-panel'
import type { GroupFilter, PanelQuery, PanelSort, PromptDraft, PromptScope } from './prompt-panel'
import './prompt-library.css'

/** 编辑器按需载入。**必须是动态 import**：库页静态引本文件的 `fetchPromptLibrary`，
    这边再静态引回去就成环。环在 ESM 里不报错，只在求值顺序不巧时变成 TDZ 白屏，
    而单测照样全绿（本仓在节点定义那里吃过一次）。

    这里换不来代码分割：库页同时被 main.tsx 的路由静态引着，rollup 会照直说
    「dynamic import will not move module into another chunk」。好处是 Suspense
    那一格几乎不会闪——模块已经在同一个 chunk 里，await 立刻就回。

    类型不受影响：TS 静态解析 `import()`，草稿形状与编辑器 `init` 对不上时
    下面那处 JSX 直接报错，不用等到用户点开编辑器才发现。 */
const LazyPromptEditor = lazy(async () => {
  const mod = await import('./PromptLibraryPage')
  return { default: mod.PromptEditor }
})

/** 负向拼在正文后面时插的那行分隔说明。模型读得懂中文说明，用户也一眼看得出
    哪段是自己要的、哪段是套进来的，改起来不用猜。 */
export const NEGATIVE_SEPARATOR = '—— 以下是要避开的内容（负向提示词） ——'

/** 「完整」= 正文 + 分隔行 + 负向。套用面板与提示词库共用这一个定义：
    两处各拼一遍的话，用户在库里复制走的那段和插进提示词框的那段会长得不一样。 */
export function fullPromptText(body: string, negative: string): string {
  const avoid = negative.trim()
  return avoid === '' ? body : `${body}\n\n${NEGATIVE_SEPARATOR}\n${avoid}`
}

/** 内置模板自带的分类（视角/分镜/角色/…）。顺序由服务端给，前端不再排一遍。 */
export interface PromptCategory {
  id: string
  name: string
}

/** 列表项。比 `PromptItem` 多三样服务端新给的字段：内置模板的分类、以及这一条是不是
    被收起来了。分类只有内置模板有——自建条目走 group_id 那一套，两者互不覆盖。 */
export interface PromptEntry extends PromptItem {
  hidden: boolean
  category: string | null
  category_name: string
  category_sort: number
}

export interface PromptLibraryData {
  items: PromptEntry[]
  categories: PromptCategory[]
}

/** 取列表。`includeHidden` 给提示词库与本面板：别处默认拿不到被隐藏的内置模板，
    否则每个消费方都要记得过滤一次，漏一处隐藏就等于没生效。 */
export async function fetchPromptLibrary(includeHidden = false): Promise<PromptLibraryData> {
  const raw = await request<{ items: PromptItem[]; categories?: PromptCategory[] }>(
    `/studio/prompts${includeHidden ? '?include_hidden=true' : ''}`,
  )
  return {
    items: (raw.items ?? []).map(normalizePrompt),
    categories: Array.isArray(raw.categories) ? raw.categories : [],
  }
}

/** 隐藏或恢复一条内置模板。内置模板不是一行数据，删不掉；隐藏可逆、内容不动。 */
export async function setPromptHidden(id: number, hidden: boolean): Promise<PromptEntry> {
  return normalizePrompt(
    await request<PromptItem>(`/studio/prompts/${id}`, jsonBody('PATCH', { hidden })),
  )
}

/** 接口边界的字段归一。

    后端与本页同一轮开发，字段没跟上时列表里少一个 negative 键，
    下面 `item.negative.trim()` 直接把整个面板炸掉。边界处补默认值，
    页面内部就不用到处写 `?.`。 */
export function normalizePrompt(raw: PromptItem): PromptEntry {
  const loose = raw as unknown as Record<string, unknown>
  return {
    id: typeof loose.id === 'number' ? loose.id : 0,
    group_id: typeof loose.group_id === 'number' ? loose.group_id : null,
    title: typeof loose.title === 'string' ? loose.title : '',
    body: typeof loose.body === 'string' ? loose.body : '',
    negative: typeof loose.negative === 'string' ? loose.negative : '',
    scene: typeof loose.scene === 'string' ? loose.scene : '',
    source: typeof loose.source === 'string' ? loose.source : null,
    source_ref: typeof loose.source_ref === 'string' ? loose.source_ref : null,
    builtin: loose.builtin === true,
    hidden: loose.hidden === true,
    category: typeof loose.category === 'string' && loose.category !== '' ? loose.category : null,
    category_name: typeof loose.category_name === 'string' ? loose.category_name : '',
    // 排在最后：认不出分类的条目沉底，而不是抢在「视角」前面
    category_sort: typeof loose.category_sort === 'number' ? loose.category_sort : 99,
    favorite: loose.favorite === true,
    used_count: typeof loose.used_count === 'number' ? loose.used_count : 0,
    variables: normalizeVariables(loose.variables),
    version: typeof loose.version === 'number' ? loose.version : null,
    updated_at: typeof loose.updated_at === 'string' ? loose.updated_at : null,
  }
}

/** 变量声明的边界归一。服务端按正文现算，字段齐全；旧缓存里可能整个键都没有。 */
function normalizeVariables(raw: unknown): PromptVariable[] {
  if (!Array.isArray(raw)) return []
  const out: PromptVariable[] = []
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue
    const spec = item as Record<string, unknown>
    const name = typeof spec.name === 'string' ? spec.name : ''
    if (name === '') continue
    out.push({
      name,
      label: typeof spec.label === 'string' ? spec.label : '',
      description: typeof spec.description === 'string' ? spec.description : '',
      default: typeof spec.default === 'string' ? spec.default : '',
      required: spec.required !== false,
    })
  }
  return out
}

/** 两级分组拍平成下拉选项，子文件夹用缩进表示层级 */
function groupOptions(groups: PromptGroup[]): { id: number; label: string }[] {
  const out: { id: number; label: string }[] = []
  for (const lib of groups.filter((g) => g.parent_id === null)) {
    out.push({ id: lib.id, label: lib.name })
    for (const sub of groups.filter((g) => g.parent_id === lib.id)) {
      out.push({ id: sub.id, label: `　└ ${sub.name}` })
    }
  }
  return out
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : '未知错误'
}

function titleOf(item: { title: string }): string {
  return item.title === '' ? '（无标题）' : item.title
}

/* ==================== 填变量 ==================== */

/** 带变量的条目在真正插进提示词框之前先过这一步。

    这是整条链路上唯一非走不可的关口：面板是画布、创作台、对话生图共用的入口，
    这里直接把带 `{{name}}` 的正文交出去，模型收到的就是一段带占位的乱码——
    它不会报错，只会照着乱出图。所以有变量就必须先填，填完由服务端渲染，
    前端不自己做字符串替换（服务端才是变量名单的事实源）。 */
function FillStep({
  item,
  onBack,
  onDone,
}: {
  item: PromptItem
  onBack: () => void
  onDone: (rendered: { body: string; negative: string }) => void
}): JSX.Element {
  const schema = useMemo(() => variableSchema(item.variables), [item.variables])
  const fields = useMemo(() => describeSchema(schema), [schema])
  const [values, setValues] = useState<Record<string, unknown>>(() => schemaDefaults(fields))
  const [issues, setIssues] = useState<SchemaIssue[]>([])
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const submit = async () => {
    if (busy) return
    const found = validateFields(fields, values)
    setIssues(found)
    if (found.length > 0) return
    setBusy(true)
    setErr(null)
    try {
      onDone(await apiStudio.renderPrompt(item.id, toRenderValues(values)))
    } catch (e) {
      // 后端点名了缺哪几个变量，原文照抄
      setErr(errText(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="spl-picker-fill">
      <p className="spl-picker-note">
        「{titleOf(item)}」带 {item.variables.length} 个变量，
        填好之后插进去的是填好的正文，不是带 <code>{'{{}}'}</code> 的模板。
      </p>
      <SchemaForm schema={schema} value={values} onChange={setValues} issues={issues} />
      {err !== null && <p className="form-err">{err}</p>}
      <div className="spl-picker-acts">
        <button className="btn btn-sm" onClick={onBack}>
          <IconArrowLeft /> 换一条
        </button>
        <button
          className={busy ? 'btn btn-sm btn-primary loading' : 'btn btn-sm btn-primary'}
          onClick={() => void submit()}
        >
          {busy && <span className="spinner" />}
          填好并套用
        </button>
      </div>
    </div>
  )
}

/* ==================== 列表项 ==================== */

/** 这一行到底是干什么用的。

    长提示词是这个面板的主角，而两条同类模板的正文开头几乎一模一样——
    截三行英文谁也分不出谁。有人写的「适用场景」就显示它，没写才从正文按分句摘
    （`prompt-digest`），并且标一下这是摘的，免得用户以为自己写过用途说明。 */
function RowDigest({ item }: { item: PromptEntry }): JSX.Element {
  const digest = promptDigest(item)
  if (digest.text === '') return <span className="spl-picker-scene">（还没写正文）</span>
  if (digest.fromScene) return <span className="spl-picker-scene">{digest.text}</span>
  return (
    <span className="spl-picker-scene">
      <span className="spl-row-mark">正文</span>
      {digest.text}
    </span>
  )
}

interface RowActions {
  onApply: (item: PromptEntry, withNegative: boolean) => void
  onEdit: (item: PromptEntry) => void
  onCopy: (item: PromptEntry) => void
  onDelete: (item: PromptEntry) => void
  onFavorite: (item: PromptEntry) => void
  onHidden: (item: PromptEntry, next: boolean) => void
}

function PromptRow({
  item,
  busy,
  acts,
}: {
  item: PromptEntry
  busy: boolean
  acts: RowActions
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const hasNegative = item.negative.trim() !== ''
  const words = promptStats(item.body).words

  return (
    <div className="spl-picker-row">
      <button className="spl-picker-main" onClick={() => acts.onApply(item, false)}>
        <span className="spl-picker-title">
          {item.favorite && (
            <span className="spl-star spl-star-on" aria-label="已收藏">
              <IconStar filled />
            </span>
          )}
          {titleOf(item)}
          {item.builtin && <span className="spl-badge">内置</span>}
          {item.category_name !== '' && (
            <span className="spl-badge spl-badge-cat">{item.category_name}</span>
          )}
          {item.hidden && <span className="spl-badge spl-badge-hidden">已隐藏</span>}
        </span>
        <RowDigest item={item} />
        <span className="spl-picker-meta">
          {`${words} 词`}
          {item.variables.length > 0 && ` · ${item.variables.length} 个变量`}
          {hasNegative && ' · 带负向'}
          {item.used_count > 0 && ` · 套用 ${item.used_count} 次`}
        </span>
      </button>

      {/* 正文全文摊在面板里读。详情要跳去库页的话，用户挑一条词要离开画布一次 */}
      {open && <p className="spl-picker-text">{item.body}</p>}
      {open && hasNegative && (
        <p className="spl-picker-text spl-picker-text-neg">{item.negative}</p>
      )}

      <div className="spl-picker-acts">
        <button className="btn btn-sm btn-soft" onClick={() => acts.onApply(item, false)}>
          只插正文
        </button>
        <button
          className="btn btn-sm btn-outline"
          disabled={!hasNegative}
          title={
            hasNegative
              ? '正文之后加一行分隔说明，再接负向内容'
              : '这条没写负向内容，插进去也只有正文'
          }
          onClick={() => acts.onApply(item, true)}
        >
          正文+负向
        </button>
        <span className="spl-flex" />

        <button
          className="btn btn-ghost-sm"
          aria-expanded={open}
          title={open ? '收起全文' : '把这条的正文全文摊开来看'}
          onClick={() => setOpen(!open)}
        >
          {open ? '收起' : '全文'}
        </button>

        {item.builtin ? (
          <>
            <button
              className="icon-btn"
              disabled={busy}
              aria-label={item.hidden ? '恢复这条内置模板' : '隐藏这条内置模板'}
              title={
                item.hidden
                  ? '放回列表里'
                  : '从列表里收起来。内置模板删不掉（它随版本发布，不是一行数据），隐藏可逆、正文不动'
              }
              onClick={() => acts.onHidden(item, !item.hidden)}
            >
              {item.hidden ? <IconPlus /> : <IconTrash />}
            </button>
            <button
              className="icon-btn"
              disabled={busy}
              aria-label="复制为自建"
              title="复制一份自建副本再改。原模板留在系统库里，副本改坏了删掉就还原成原版"
              onClick={() => acts.onCopy(item)}
            >
              <IconFileText />
            </button>
          </>
        ) : (
          <>
            <button
              className={item.favorite ? 'icon-btn active' : 'icon-btn'}
              disabled={busy}
              aria-label={item.favorite ? '取消收藏' : '收藏'}
              title={item.favorite ? '取消收藏' : '收藏（默认排序里收藏的排最前）'}
              onClick={() => acts.onFavorite(item)}
            >
              <IconStar filled={item.favorite} />
            </button>
            <button
              className="icon-btn"
              disabled={busy}
              aria-label="复制一份"
              title="复制成一条新的再改，原来那条不动"
              onClick={() => acts.onCopy(item)}
            >
              <IconFileText />
            </button>
            <button
              className="icon-btn"
              disabled={busy}
              aria-label="编辑"
              title="改这一条。编辑器铺满整屏——长提示词在窄面板里改不动"
              onClick={() => acts.onEdit(item)}
            >
              <IconEdit />
            </button>
            <button
              className="icon-btn spl-picker-del"
              disabled={busy}
              aria-label="删除"
              title="真删掉这一条"
              onClick={() => acts.onDelete(item)}
            >
              <IconTrash />
            </button>
          </>
        )}
      </div>
    </div>
  )
}

/* ==================== 面板 ==================== */

export function PromptPicker({
  onPick,
  onClose,
}: {
  onPick: (item: PromptItem) => void
  onClose: () => void
}): JSX.Element {
  const qc = useQueryClient()
  const [query, setQuery] = useState<PanelQuery>(PANEL_QUERY_DEFAULTS)
  const patch = (over: Partial<PanelQuery>) => setQuery((prev) => ({ ...prev, ...over }))

  // 选中的带变量条目：填完才交出去
  const [filling, setFilling] = useState<{ item: PromptItem; withNegative: boolean } | null>(null)
  const [draft, setDraft] = useState<PromptDraft | null>(null)
  const [deleting, setDeleting] = useState<PromptEntry | null>(null)
  const [rowBusy, setRowBusy] = useState<number | null>(null)
  const [delBusy, setDelBusy] = useState(false)

  const fullscreen = useFullscreenElement()
  useEscapeClose(onClose)

  /* 面板宽度。初值从 localStorage 读，读到什么都先按当前视口钳一遍——
     上次在 2560 的外接屏拖到 760，今天在笔记本上打开就该收回去。 */
  const [width, setWidth] = useState(() =>
    loadPanelWidth(typeof window === 'undefined' ? 0 : window.innerWidth),
  )
  const widthRef = useRef(width)
  const setW = useCallback((next: number) => {
    widthRef.current = next
    setWidth(next)
  }, [])
  const [dragging, setDragging] = useState(false)

  // 窗口缩小时跟着收窄，否则面板会把画布挤没而用户没做任何事
  useEffect(() => {
    const onResize = () => setW(clampPanelWidth(widthRef.current, window.innerWidth))
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [setW])

  /** 拖左边缘改宽。往左拖变宽，所以是 `起点 - 当前` */
  const startDrag = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.preventDefault()
    const el = e.currentTarget
    const startX = e.clientX
    const startW = widthRef.current
    el.setPointerCapture(e.pointerId)
    setDragging(true)
    const move = (ev: PointerEvent) => {
      setW(clampPanelWidth(startW + (startX - ev.clientX), window.innerWidth))
    }
    const stop = () => {
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerup', stop)
      el.removeEventListener('pointercancel', stop)
      setDragging(false)
      // 松手才落存储：拖的过程里每帧写一次 localStorage 是同步 IO，会把拖拽拖卡
      savePanelWidth(widthRef.current)
    }
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', stop)
    el.addEventListener('pointercancel', stop)
  }

  /** 键盘也能调宽。拖拽把不了键盘的关，而这条分隔线是面板唯一的尺寸控件 */
  const keyDrag = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? 64 : 16
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
    e.preventDefault()
    const next = clampPanelWidth(
      widthRef.current + (e.key === 'ArrowLeft' ? step : -step),
      window.innerWidth,
    )
    setW(next)
    savePanelWidth(next)
  }

  /* 面板自己带 include_hidden：隐藏是可逆的，看不见就没法恢复。
     键上多一段 'panel'，与库页的 ['spl-prompts','library'] 分开缓存，前缀失效仍然一起刷 */
  const groupsQuery = useQuery({ queryKey: ['spl-groups'], queryFn: () => apiStudio.promptGroups() })
  const listQuery = useQuery({
    queryKey: ['spl-prompts', 'panel'],
    queryFn: () => fetchPromptLibrary(true),
  })

  const groups: PromptGroup[] = groupsQuery.data?.items ?? []
  const groupsError = groupsQuery.isError ? errText(groupsQuery.error) : null
  const all = useMemo(() => listQuery.data?.items ?? [], [listQuery.data])
  const categories = listQuery.data?.categories ?? []

  const shown = useMemo(() => filterPrompts(all, query), [all, query])
  const counts = useMemo(() => scopeCounts(all, query.showHidden), [all, query.showHidden])
  const hiddenCount = useMemo(() => all.filter((it) => it.hidden).length, [all])

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['spl-prompts'] })
    void qc.invalidateQueries({ queryKey: ['spl-groups'] })
  }

  /** 真正交出去。计数是排序用的统计，跟套用本身没有因果关系——先把内容交出去，
      计数失败也不回滚、不弹错打断。 */
  const emit = (item: PromptItem, withNegative: boolean) => {
    const negative = item.negative.trim()
    onPick(
      withNegative && negative !== ''
        ? { ...item, body: fullPromptText(item.body, negative), negative: '' }
        : item,
    )
    void apiStudio.usePrompt(item.id).catch(() => undefined)
    /* 交完不自己关：面板的意义就是「一边看图一边挑」，连着挑两三条是常态。
       关不关由调用方在 `onPick` 里决定（画布那边目前挑完就关，改那个要动 CanvasPage）。 */
    setFilling(null)
  }

  /** 套用一条。带变量的先进填写步骤——把 `{{name}}` 原样插进提示词框，
      模型不会报错，只会照着这段占位乱出图，是这套东西唯一真正会出事的失败模式。 */
  const apply = (item: PromptEntry, withNegative: boolean) => {
    if (needsFill(item)) {
      setFilling({ item, withNegative })
      return
    }
    emit(item, withNegative)
  }

  const guard = async (id: number, run: () => Promise<void>) => {
    if (rowBusy !== null) return
    setRowBusy(id)
    try {
      await run()
    } catch (e) {
      toast.error(errText(e))
    } finally {
      setRowBusy(null)
    }
  }

  const toggleFav = (item: PromptEntry) =>
    void guard(item.id, async () => {
      await apiStudio.patchPrompt(item.id, { favorite: !item.favorite })
      refresh()
    })

  /** 隐藏 / 恢复一条内置模板。删不掉是因为它不是一行数据，隐藏可逆、内容不动 */
  const toggleHidden = (item: PromptEntry, next: boolean) =>
    void guard(item.id, async () => {
      await setPromptHidden(item.id, next)
      toast.success(next ? '已隐藏。开「含已隐藏」随时恢复，正文一个字没动' : '已恢复')
      refresh()
    })

  /** 复制一份再改。内置模板要改只能走这条路（后端对负数 id 的写操作一律 400），
      自建条目复制着改也用它——副本改坏了删掉就回到原样。 */
  const copyItem = (item: PromptEntry) =>
    void guard(item.id, async () => {
      const copy = await apiStudio.forkPrompt(item.id)
      refresh()
      setDraft(editDraft(normalizePrompt(copy)))
      toast.success(
        item.builtin
          ? '已复制成自建副本，改完记得保存。原模板还留在系统库里，不想再看见就点它的「隐藏」'
          : '已复制一份，改完记得保存',
      )
    })

  const confirmDelete = async () => {
    if (deleting === null || delBusy) return
    setDelBusy(true)
    try {
      await apiStudio.deletePrompt(deleting.id)
      toast.success('提示词已删除')
      setDeleting(null)
      refresh()
    } catch (e) {
      toast.error(errText(e))
    } finally {
      setDelBusy(false)
    }
  }

  const acts: RowActions = {
    onApply: apply,
    onEdit: (item) => setDraft(editDraft(item)),
    onCopy: copyItem,
    onDelete: setDeleting,
    onFavorite: toggleFav,
    onHidden: toggleHidden,
  }

  const scopeTabs: [PromptScope, string][] = [
    ['all', '全部'],
    ['system', '系统模板'],
    ['mine', '我的'],
    ['favorite', '收藏'],
  ]

  const sortTabs: [PanelSort, string][] = [
    ['smart', '常用优先'],
    ['updated', '最近更新'],
    ['used', '套用最多'],
  ]

  const panel = (
    <aside
      className={dragging ? 'spl-panel spl-panel-drag' : 'spl-panel'}
      style={{ width: `${width}px` }}
      aria-labelledby="spl-panel-heading"
    >
      <div
        className="spl-panel-grip"
        role="separator"
        aria-orientation="vertical"
        aria-label="拖动调整面板宽度，方向键也可以"
        aria-valuenow={width}
        aria-valuemin={PANEL_MIN_W}
        aria-valuemax={PANEL_MAX_W}
        tabIndex={0}
        onPointerDown={startDrag}
        onKeyDown={keyDrag}
      />

      <header className="spl-panel-head">
        <h3 id="spl-panel-heading">提示词库</h3>
        <span className="spl-flex" />
        <button
          className="btn btn-sm btn-soft"
          title="说一句想要什么，模型写出正向与负向，落进编辑器给你改——不会直接进库"
          onClick={() => setDraft(blankDraft(query.group, true))}
        >
          <IconSparkle /> AI 写一条
        </button>
        <button
          className="btn btn-sm btn-primary"
          onClick={() => setDraft(blankDraft(query.group, false))}
        >
          <IconPlus /> 新建
        </button>
        <button className="icon-btn" aria-label="关闭" onClick={onClose}>
          <IconClose />
        </button>
      </header>

      {filling !== null ? (
        <FillStep
          key={filling.item.id}
          item={filling.item}
          onBack={() => setFilling(null)}
          onDone={(rendered) =>
            emit(
              { ...filling.item, body: rendered.body, negative: rendered.negative },
              filling.withNegative,
            )
          }
        />
      ) : (
        <>
          <div className="spl-scope">
            {scopeTabs.map(([id, label]) => (
              <button
                key={id}
                className={query.scope === id ? 'spl-scope-btn spl-scope-on' : 'spl-scope-btn'}
                onClick={() => patch({ scope: id })}
              >
                {label}
                <span className="spl-scope-n">{counts[id]}</span>
              </button>
            ))}
          </div>

          <div className="spl-picker-bar">
            <span className="spl-search">
              <IconSearch />
              <input
                value={query.text}
                placeholder="搜标题、场景、正文、负向…"
                onChange={(e) => patch({ text: e.target.value })}
                onKeyDown={(e) => {
                  if (e.key === 'Escape' && query.text !== '') {
                    // 焦点在搜索框里，这一下只清词；再按一次才关面板（STD-UI-002b）
                    e.stopPropagation()
                    patch({ text: '' })
                  }
                }}
              />
            </span>
            {query.scope === 'system' ? (
              <Picker
                size="sm"
                className="spl-sel"
                aria-label="按内置分类筛选"
                value={query.category}
                onChange={(v) => patch({ category: v })}
                options={[
                  { value: 'all', label: '全部分类' },
                  ...categories.map((c) => ({ value: c.id, label: c.name })),
                ]}
              />
            ) : (
              <Picker
                size="sm"
                className="spl-sel"
                aria-label="按分组筛选"
                value={typeof query.group === 'number' ? String(query.group) : query.group}
                disabled={groupsError !== null}
                onChange={(v) =>
                  patch({ group: (v === 'all' || v === 'none' ? v : Number(v)) as GroupFilter })
                }
                options={[
                  { value: 'all', label: '全部分组' },
                  { value: 'none', label: '未归组' },
                  ...groupOptions(groups).map((o) => ({ value: String(o.id), label: o.label })),
                ]}
              />
            )}
          </div>

          <div className="spl-panel-sorts">
            <div className="spl-sorts">
              {sortTabs.map(([id, label]) => (
                <button
                  key={id}
                  className={query.sort === id ? 'spl-sort spl-sort-on' : 'spl-sort'}
                  onClick={() => patch({ sort: id })}
                >
                  {label}
                </button>
              ))}
            </div>
            <span className="spl-flex" />
            {hiddenCount > 0 && (
              <label className="spl-panel-hidden" title="隐藏掉的内置模板只有在这里才看得见，也才恢复得了">
                <input
                  type="checkbox"
                  checked={query.showHidden}
                  onChange={(e) => patch({ showHidden: e.target.checked })}
                />
                含已隐藏 {hiddenCount}
              </label>
            )}
            <span className="spl-picker-count">{shown.length} 条</span>
          </div>

          {groupsError !== null && (
            <p className="spl-picker-note spl-picker-err">
              分组接口没通，按分组筛选与新建时选分组都用不了：{groupsError}
              <br />
              下面的列表是全部提示词，搜索照常可用。
            </p>
          )}

          <div className="spl-picker-body">
            {listQuery.isPending && <p className="spl-picker-note">载入提示词…</p>}
            {listQuery.isError && (
              <p className="spl-picker-note spl-picker-err">
                提示词加载失败：{errText(listQuery.error)}
                <button className="btn btn-ghost-sm" onClick={() => void listQuery.refetch()}>
                  重试
                </button>
              </p>
            )}
            {!listQuery.isPending && !listQuery.isError && shown.length === 0 && (
              <p className="spl-picker-note">
                {all.length === 0
                  ? '提示词库还是空的。点上面的「新建」写一条，或者让 AI 写一条。'
                  : '没有匹配的提示词。换个词，或把筛选切回「全部」。'}
              </p>
            )}

            {shown.map((it) => (
              <PromptRow key={it.id} item={it} busy={rowBusy === it.id} acts={acts} />
            ))}
          </div>

          <p className="spl-picker-note">
            点条目 = 只插正文；「正文+负向」在正文后另起一行写明分隔再接负向。带变量的先填空。
            内置模板改不了也删不掉（随版本发布），要改就「复制为自建」，副本删掉即还原成原版。
          </p>
        </>
      )}
    </aside>
  )

  /* **一律 portal 出去**，不留在调用方的 DOM 位置：`position: fixed` 只在没有
     transform / filter / contain 祖先时才相对视口定位，而画布的生成条是
     `transform: translateX(-50%)` 定位的——留在原地的话面板会贴着生成条右边缘
     而不是视口右边缘。宿主取全屏元素优先：Fullscreen API 只渲染全屏元素的后代子树。 */
  const host = fullscreen ?? (typeof document === 'undefined' ? null : document.body)

  return (
    <>
      {host === null ? panel : createPortal(panel, host)}

      {draft !== null &&
        host !== null &&
        createPortal(
          /* 编辑器是 `position:absolute; inset:0`，铺的是最近的定位祖先。库页那边的祖先是
             整页，这里得自己给一层铺满视口的壳，否则它会缩进 420 宽的面板里——
             而长提示词在窄缝里改正是这一版要解决的问题。 */
          <div className="spl-ed-layer">
            <Suspense fallback={<p className="spl-picker-note spl-ed-loading">载入编辑器…</p>}>
              <LazyPromptEditor
                key={draft.id ?? 'new'}
                init={draft}
                groups={groups}
                groupsError={groupsError}
                onClose={() => setDraft(null)}
                onSaved={() => {
                  setDraft(null)
                  refresh()
                }}
              />
            </Suspense>
          </div>,
          host,
        )}

      {deleting !== null && (
        <Overlay onClose={() => setDeleting(null)} card="ov-narrow" labelledBy="spl-pk-del-title">
          <div className="overlay-head">
            <span className="overlay-title" id="spl-pk-del-title">
              删除「{titleOf(deleting)}」？
            </span>
          </div>
          <p className="spl-warn">
            <IconAlert />
            <span>
              <b>这一条会被真删掉，正文和负向都不再保留。</b>
              已经用它生成过的图不受影响。
            </span>
          </p>
          <div className="overlay-foot">
            <button className="btn" onClick={() => setDeleting(null)}>
              取消
            </button>
            <button
              className={delBusy ? 'btn btn-danger-solid loading' : 'btn btn-danger-solid'}
              onClick={() => void confirmDelete()}
            >
              {delBusy && <span className="spinner" />}
              确认删除
            </button>
          </div>
        </Overlay>
      )}
    </>
  )
}
