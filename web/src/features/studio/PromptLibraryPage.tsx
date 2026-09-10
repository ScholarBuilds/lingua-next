/* 提示词库（FR-478 · M3 · M67 三栏改版）：正/负向提示词的分组管理，
   各工具的提示词框从这里一键套用。

   三栏抄自 Infinite-Canvas 的提示词面板：左栏切库与筛分类、中栏是列表、右栏是详情。
   卡片列表里正文只能截三行，而这些模板的正文动辄两三百词，挑的时候真正要看的就是
   那几百词——截断的摘要看不出两条「九宫格」差在哪。详情栏才是这个库能用起来的关键。

   两条口径与素材库一致：分组只是贴归属，删组不删条目；内置模板随版本维护，
   用户改不动它——改了下次升级就被覆盖，所以编辑入口换成「复制为自建」，
   并在卡片上写清为什么与怎么办（STD-UI-006：禁用表达不了「改了没用」）。
   内置模板可以**隐藏**（可逆，落 user_pref）：删不掉是因为它本来就不是一行数据，
   但「这条我永远用不上」是真实诉求，蓝本的 hiddenBuiltinIds 就是干这个的。

   列表、搜索、分组筛选、左栏每一项的计数全部落在同一份客户端数组上：
   接口的 group_id/q/favorite/builtin/category 过滤器都能用，但混着用会出现「左栏数字
   和右边列表对不上」——同源算才对得上。提示词库是几十到几百条的量级，
   真到了要分页的规模再切回服务端过滤。 */

import { useMemo, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useSearchParams } from 'react-router-dom'
import { toast } from 'sonner'

import { Overlay, useEscapeClose } from '../../components/Overlay'
import {
  IconAlert,
  IconClock,
  IconClose,
  IconEdit,
  IconFileText,
  IconPlus,
  IconSearch,
  IconSidebar,
  IconSparkle,
  IconStar,
  IconTrash,
} from '../../components/icons'
import { Picker } from '@/components/ui/picker'
import { apiStudio } from '../../lib/api-studio'
import type { PromptGroup, PromptItem, PromptVariable, RenderedPrompt } from '../../lib/api-studio'
import { AssetManagerTabs } from './AssetManagerTabs'
import { fetchPromptLibrary, fullPromptText, setPromptHidden } from './PromptPicker'
import type { PromptCategory, PromptEntry } from './PromptPicker'
import { RevisionPanel } from './RevisionPanel'
import { SchemaForm, describeSchema, schemaDefaults, validateFields } from './SchemaForm'
import type { SchemaIssue } from './SchemaForm'
import {
  COMPOSE_DEFAULTS,
  applyComposed,
  composePrompt,
  composedNote,
} from './prompt-compose'
import type { ComposeOptions } from './prompt-compose'
import { promptDigest, promptStats } from './prompt-digest'
import { mergeVariables, toRenderValues, variableSchema } from './prompt-variables'
import './prompt-library.css'

/** 左栏选中的范围。快捷入口、内置分类与自建分组三者互斥，做成联合类型比一堆 boolean
    好维护。`category` 是内置模板自带的分类，`group` 是用户自建的分组——两套并行，
    不能合并：合了之后删一个分组就会把内置模板的归类一起删掉，升级一次它又长回来。 */
type Scope =
  | { kind: 'all' }
  | { kind: 'mine' }
  | { kind: 'ungrouped' }
  | { kind: 'favorite' }
  | { kind: 'builtin' }
  | { kind: 'category'; id: string }
  | { kind: 'hidden' }
  | { kind: 'group'; id: number }

/** 左栏每一项的条数。与中栏列表同源算，保证「左栏数字」和「右边列表」对得上 */
interface Counts {
  all: number
  mine: number
  builtin: number
  ungrouped: number
  favorite: number
  hidden: number
  byCategory: Record<string, number>
}

type SortKey = 'updated' | 'used'

/** 左栏选中项进地址栏（`?scope=`）。两个理由：刷新之后还在原地；
    「已隐藏」这种平时不显眼的入口能被别处直接链过去（隐藏时的 toast 就指着它）。
    写的时候用 replace，翻一遍分类不该在浏览器历史里堆出十几条记录。 */
function encodeScope(scope: Scope): string {
  switch (scope.kind) {
    case 'category':
      return `cat:${scope.id}`
    case 'group':
      return `group:${scope.id}`
    default:
      return scope.kind
  }
}

function parseScope(raw: string | null): Scope {
  const text = raw ?? ''
  if (text.startsWith('cat:')) return { kind: 'category', id: text.slice(4) }
  if (text.startsWith('group:')) {
    const id = Number(text.slice(6))
    // 认不出的分组 id 回落到「全部」而不是留一个永远空着的列表
    return Number.isFinite(id) ? { kind: 'group', id } : { kind: 'all' }
  }
  switch (text) {
    case 'mine':
    case 'ungrouped':
    case 'favorite':
    case 'builtin':
    case 'hidden':
      return { kind: text }
    default:
      return { kind: 'all' }
  }
}

/** 编辑器里的那份草稿。id 为 null = 新建 */
interface Draft {
  id: number | null
  title: string
  scene: string
  body: string
  negative: string
  group_id: number | null
  variables: PromptVariable[]
  /** 开编辑器时把焦点直接放进 AI 那格。「AI 写一条」进来的就是它——
      用户点这个按钮时脑子里已经有一句话要打了，不该再让他找输入框 */
  focusAi?: boolean
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : '未知错误'
}

function fmtTime(iso: string | null): string {
  if (iso === null) return '未记录'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

async function copyText(text: string, what: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text)
    toast.success(`已复制${what}`)
  } catch {
    // 非安全上下文（局域网 http）拿不到 clipboard，说清怎么办比只报一句失败有用
    toast.error('浏览器不让复制，选中那段文字手动复制吧')
  }
}

/** 篇幅那一行。正向提示词几乎都是英文短语流，词数比字符数更贴近「这条有多长」 */
function lengthLabel(text: string): string {
  const { chars, words } = promptStats(text)
  return `${words} 词 · ${chars} 字符`
}

/** 隐藏的内置模板只在「已隐藏」里出现。别处一律当它不存在——不然「隐藏」这个动作
    在界面上就没有可观察的效果，用户会以为没生效。 */
function inScope(item: PromptEntry, scope: Scope): boolean {
  if (scope.kind !== 'hidden' && item.hidden) return false
  switch (scope.kind) {
    case 'all':
      return true
    case 'mine':
      return !item.builtin
    case 'ungrouped':
      return !item.builtin && item.group_id === null
    case 'favorite':
      return item.favorite
    case 'builtin':
      return item.builtin
    case 'category':
      return item.category === scope.id
    case 'hidden':
      return item.hidden
    case 'group':
      return item.group_id === scope.id
  }
}

function scopeTitle(scope: Scope, groups: PromptGroup[], categories: PromptCategory[]): string {
  switch (scope.kind) {
    case 'all':
      return '全部'
    case 'mine':
      return '我的提示词'
    case 'ungrouped':
      return '未归组'
    case 'favorite':
      return '我的收藏'
    case 'builtin':
      return '系统模板'
    case 'category':
      return `系统模板 · ${categories.find((c) => c.id === scope.id)?.name ?? scope.id}`
    case 'hidden':
      return '已隐藏的系统模板'
    case 'group':
      return groups.find((g) => g.id === scope.id)?.name ?? '分组'
  }
}

/* ============ 左栏：库切换 + 内置分类 + 两级分组树 ============ */

function LibraryRail({
  groups,
  categories,
  loading,
  error,
  counts,
  scope,
  open,
  onScope,
  onChanged,
}: {
  groups: PromptGroup[]
  categories: PromptCategory[]
  loading: boolean
  error: string | null
  counts: Counts
  scope: Scope
  /** 窄屏下这一栏是抽屉，收着时整个滑出屏幕。宽屏下这个值不起作用 */
  open: boolean
  onScope: (next: Scope) => void
  /** 删组会把条目退回未归组，条目列表也要跟着刷 */
  onChanged: () => void
}): JSX.Element {
  const [creating, setCreating] = useState<{ parent: number | null } | null>(null)
  const [draft, setDraft] = useState('')
  const [renaming, setRenaming] = useState<{ id: number; text: string } | null>(null)
  const [deleting, setDeleting] = useState<PromptGroup | null>(null)
  const [busy, setBusy] = useState(false)

  const libs = groups.filter((g) => g.parent_id === null)
  const childrenOf = (id: number) => groups.filter((g) => g.parent_id === id)

  const startCreate = (parent: number | null) => {
    setCreating({ parent })
    setDraft('')
  }

  const commitCreate = async () => {
    if (creating === null) return
    const name = draft.trim()
    const parent = creating.parent
    setCreating(null)
    setDraft('')
    if (name === '') return
    try {
      await apiStudio.createPromptGroup({ name, parent_id: parent })
      onChanged()
    } catch (e) {
      toast.error(errText(e))
    }
  }

  const commitRename = async () => {
    if (renaming === null) return
    const { id, text } = renaming
    setRenaming(null)
    const name = text.trim()
    if (name === '') return
    try {
      await apiStudio.patchPromptGroup(id, { name })
      onChanged()
    } catch (e) {
      toast.error(errText(e))
    }
  }

  const confirmDelete = async () => {
    if (deleting === null || busy) return
    setBusy(true)
    try {
      const r = await apiStudio.deletePromptGroup(deleting.id)
      toast.success(`分组已删除，${r.released} 条提示词退回「未归组」，条目本身都还在`)
      if (scope.kind === 'group' && scope.id === deleting.id) onScope({ kind: 'all' })
      setDeleting(null)
      onChanged()
    } catch (e) {
      toast.error(errText(e))
    } finally {
      setBusy(false)
    }
  }

  const row = (g: PromptGroup, sub: boolean) => {
    const on = scope.kind === 'group' && scope.id === g.id
    const kids = childrenOf(g.id)
    const editing = renaming !== null && renaming.id === g.id
    return (
      <div
        key={g.id}
        className={`spl-item${on ? ' spl-item-on' : ''}${sub ? ' spl-item-sub' : ''}`}
        role="button"
        tabIndex={0}
        onClick={() => onScope({ kind: 'group', id: g.id })}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            onScope({ kind: 'group', id: g.id })
          }
        }}
      >
        {editing ? (
          <input
            className="spl-rename"
            value={renaming.text}
            autoFocus
            onClick={(e) => e.stopPropagation()}
            onChange={(e) => setRenaming({ id: g.id, text: e.target.value })}
            onBlur={() => void commitRename()}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void commitRename()
              if (e.key === 'Escape') {
                // 这一下 Esc 只退出改名，不冒到浮层栈去关别的层（STD-UI-002b）
                e.stopPropagation()
                setRenaming(null)
              }
            }}
          />
        ) : (
          <>
            <span className="spl-item-name" title={g.name}>
              {g.name}
            </span>
            <span
              className="spl-item-count"
              title={kids.length > 0 ? '直接挂在这一级的条数，不含子文件夹' : '这个分组下的条数'}
            >
              {g.count}
            </span>
            <span className="spl-item-acts" onClick={(e) => e.stopPropagation()}>
              {!sub && (
                <button
                  className="spl-act"
                  aria-label={`在「${g.name}」下新建子文件夹`}
                  title="新建子文件夹"
                  onClick={() => startCreate(g.id)}
                >
                  <IconPlus />
                </button>
              )}
              <button
                className="spl-act"
                aria-label={`重命名「${g.name}」`}
                title="改名"
                onClick={() => setRenaming({ id: g.id, text: g.name })}
              >
                <IconEdit />
              </button>
              <button
                className="spl-act"
                aria-label={`删除「${g.name}」`}
                title={
                  kids.length > 0
                    ? '这个库下还有子文件夹，先把子文件夹删掉'
                    : '删除分组（提示词不会被删）'
                }
                disabled={kids.length > 0}
                onClick={() => setDeleting(g)}
              >
                <IconTrash />
              </button>
            </span>
          </>
        )}
      </div>
    )
  }

  const quick = (target: Scope, label: string, n: number, title?: string) => {
    const on =
      scope.kind === target.kind &&
      (target.kind !== 'category' || (scope.kind === 'category' && scope.id === target.id))
    return (
      <button
        className={`spl-item${on ? ' spl-item-on' : ''}`}
        title={title}
        onClick={() => onScope(target)}
      >
        <span className="spl-item-name">{label}</span>
        <span className="spl-item-count">{n}</span>
      </button>
    )
  }

  /** 顶部库切换。系统模板与自建条目是两批东西，写提示词时几乎不会混着找——
      蓝本那边就是一个「系统提示词库 / 我的」的下拉，这里换成三档的分段控件。 */
  const libTab = (target: Scope, label: string, n: number) => {
    const on = scope.kind === target.kind || (target.kind === 'builtin' && scope.kind === 'category')
    return (
      <button
        className={on ? 'spl-lib-btn spl-lib-on' : 'spl-lib-btn'}
        onClick={() => onScope(target)}
      >
        {label}
        <span className="spl-lib-n">{n}</span>
      </button>
    )
  }

  return (
    <aside className={open ? 'spl-side spl-side-open' : 'spl-side'} aria-label="提示词分类">
      <div className="spl-lib">
        {libTab({ kind: 'all' }, '全部', counts.all)}
        {libTab({ kind: 'builtin' }, '系统', counts.builtin)}
        {libTab({ kind: 'mine' }, '我的', counts.mine)}
      </div>

      <div className="spl-side-sec">
        <span>系统模板分类</span>
      </div>
      {categories.map((cat) =>
        quick({ kind: 'category', id: cat.id }, cat.name, counts.byCategory[cat.id] ?? 0),
      )}
      {counts.hidden > 0 &&
        quick(
          { kind: 'hidden' },
          '已隐藏',
          counts.hidden,
          '内置模板删不掉（它是随版本发布的常量，删了下次升级又回来），只能收起来。点进去随时恢复',
        )}

      <div className="spl-side-sec">
        <span>我的</span>
      </div>
      {quick({ kind: 'ungrouped' }, '未归组', counts.ungrouped)}
      {quick({ kind: 'favorite' }, '我的收藏', counts.favorite)}

      <div className="spl-side-sec">
        <span>分组</span>
      </div>

      {loading && <p className="spl-side-note">载入分组…</p>}
      {error !== null && (
        <p className="spl-side-note spl-side-err">
          分组加载失败：{error}
          <br />
          分组树用不了，右边的条目列表照常能看能改。
        </p>
      )}
      {!loading && error === null && libs.length === 0 && (
        <p className="spl-side-note">还没有库。新建一个库，再把提示词归进去。</p>
      )}

      {libs.map((lib) => (
        <div key={lib.id}>
          {row(lib, false)}
          {childrenOf(lib.id).map((sub) => row(sub, true))}
          {creating !== null && creating.parent === lib.id && (
            <div className="spl-newbox">
              <input
                value={draft}
                autoFocus
                placeholder="子文件夹名称"
                onChange={(e) => setDraft(e.target.value)}
                onBlur={() => void commitCreate()}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void commitCreate()
                  if (e.key === 'Escape') {
                    e.stopPropagation()
                    setCreating(null)
                  }
                }}
              />
            </div>
          )}
        </div>
      ))}

      {creating !== null && creating.parent === null ? (
        <div className="spl-newbox">
          <input
            value={draft}
            autoFocus
            placeholder="库名称"
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => void commitCreate()}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void commitCreate()
              if (e.key === 'Escape') {
                e.stopPropagation()
                setCreating(null)
              }
            }}
          />
          <p>回车建库，Esc 取消</p>
        </div>
      ) : (
        <button className="spl-new" disabled={error !== null} onClick={() => startCreate(null)}>
          <IconPlus />
          新建库
        </button>
      )}

      {deleting !== null && (
        <Overlay onClose={() => setDeleting(null)} card="ov-narrow" labelledBy="spl-gdel-title">
          <div className="overlay-head">
            <span className="overlay-title" id="spl-gdel-title">
              删除分组「{deleting.name}」？
            </span>
          </div>
          <p className="spl-warn">
            <IconAlert />
            <span>
              <b>只解除归属，提示词不会被删。</b>
              这个分组下的 {deleting.count} 条提示词会退回「未归组」，内容原样保留，随时能重新归组。
            </span>
          </p>
          <div className="overlay-foot">
            <button className="btn" onClick={() => setDeleting(null)}>
              取消
            </button>
            <button
              className={busy ? 'btn btn-danger loading' : 'btn btn-danger'}
              onClick={() => void confirmDelete()}
            >
              {busy && <span className="spinner" />}
              删除分组
            </button>
          </div>
        </Overlay>
      )}
    </aside>
  )
}

/* ==================== 模板变量：声明与填写 ==================== */

/** 抽屉里的变量声明区。名字不在这里改——它由正文里的 `{{name}}` 占位决定，
    这里只给每个变量补标签、说明、默认值和是否必填。

    做成「只读名字 + 可写说明」而不是一张能增删行的表，是因为两边都能改名字的话
    立刻会出现「声明里有、正文里没有」的死变量，填变量的表单上就多一个填了也没用
    的空格子；而正文才是真正被发出去的东西。 */
function VariableEditor({
  variables,
  onChange,
}: {
  variables: PromptVariable[]
  onChange: (next: PromptVariable[]) => void
}): JSX.Element {
  const patch = (name: string, over: Partial<PromptVariable>) => {
    onChange(variables.map((item) => (item.name === name ? { ...item, ...over } : item)))
  }

  return (
    <div className="field">
      <label>模板变量</label>
      {variables.length === 0 ? (
        <span className="field-hint">
          正文里写 <code>{'{{主体}}'}</code> 这样的双花括号占位，这里就会出现对应的变量，
          套用时先填空再插进提示词框。不写占位就是一条普通提示词。
        </span>
      ) : (
        <>
          <div className="spl-vars">
            {variables.map((item) => (
              <div className="spl-var" key={item.name}>
                <code className="spl-var-name">{`{{${item.name}}}`}</code>
                <input
                  className="field-input spl-var-label"
                  value={item.label}
                  placeholder="显示名（留空就用变量名）"
                  onChange={(e) => patch(item.name, { label: e.target.value })}
                />
                <input
                  className="field-input spl-var-default"
                  value={item.default}
                  placeholder="默认值"
                  onChange={(e) => patch(item.name, { default: e.target.value })}
                />
                <label className="spl-var-req">
                  <input
                    type="checkbox"
                    checked={item.required}
                    onChange={(e) => patch(item.name, { required: e.target.checked })}
                  />
                  必填
                </label>
                <input
                  className="field-input spl-var-desc"
                  value={item.description}
                  placeholder="一句话说明这里该填什么"
                  onChange={(e) => patch(item.name, { description: e.target.value })}
                />
              </div>
            ))}
          </div>
          <span className="field-hint">
            必填的变量没填就套用，服务端会直接拦下并点名是哪几个——
            带着 <code>{'{{}}'}</code> 的正文发给模型，模型不会报错，只会照着乱出图。
          </span>
        </>
      )}
    </div>
  )
}

/** 填变量并预览的浮层。表单直接由 SchemaForm 按 JSON Schema 渲染，
    不另写一套控件——必填标记、约束提示、错误定位它都已经处理过了。 */
function VariableFillOverlay({
  item,
  onClose,
}: {
  item: PromptItem
  onClose: () => void
}): JSX.Element {
  const schema = useMemo(() => variableSchema(item.variables), [item.variables])
  const fields = useMemo(() => describeSchema(schema), [schema])
  const [values, setValues] = useState<Record<string, unknown>>(() => schemaDefaults(fields))
  const [issues, setIssues] = useState<SchemaIssue[]>([])
  const [result, setResult] = useState<RenderedPrompt | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const run = async () => {
    if (busy) return
    const found = validateFields(fields, values)
    setIssues(found)
    if (found.length > 0) return
    setBusy(true)
    setErr(null)
    try {
      const rendered = await apiStudio.renderPrompt(item.id, toRenderValues(values))
      setResult(rendered)
      // 套用计数是 fire-and-forget：为了一个统计数字打断套用没有道理
      void apiStudio.usePrompt(item.id).catch(() => undefined)
    } catch (e) {
      // 后端 detail 原文照抄：它点名了缺哪几个变量，改写成「渲染失败」就没信息了
      setErr(errText(e))
      setResult(null)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Overlay onClose={onClose} card="spl-fill" labelledBy="spl-fill-title">
      <div className="overlay-head">
        <span className="overlay-title" id="spl-fill-title">
          填变量 · {item.title === '' ? '（无标题）' : item.title}
        </span>
      </div>

      <SchemaForm schema={schema} value={values} onChange={setValues} issues={issues} />

      {err !== null && <p className="form-err">{err}</p>}

      {result !== null && (
        <div className="spl-fill-out">
          <label>填好的正文</label>
          <textarea className="field-textarea" value={result.body} readOnly />
          {result.negative !== '' && (
            <>
              <label>填好的负向</label>
              <textarea className="field-textarea" value={result.negative} readOnly />
            </>
          )}
        </div>
      )}

      <div className="overlay-foot">
        <button className="btn" onClick={onClose}>
          关闭
        </button>
        {result !== null && (
          <button className="btn btn-soft" onClick={() => void copyText(result.body, '填好的正文')}>
            复制正文
          </button>
        )}
        {result !== null && result.negative !== '' && (
          <button
            className="btn btn-soft"
            title="正文之后加一行分隔说明，再接负向——与套用浮层的「正文+负向」是同一段文字"
            onClick={() => void copyText(fullPromptText(result.body, result.negative), '完整提示词')}
          >
            复制完整
          </button>
        )}
        <button
          className={busy ? 'btn btn-primary loading' : 'btn btn-primary'}
          onClick={() => void run()}
        >
          {busy && <span className="spinner" />}
          填好并预览
        </button>
      </div>
    </Overlay>
  )
}

/* ==================== 编辑器 ==================== */

/** 编辑器里的 AI 面板。

    **产出一律落进上面的编辑框，不入库**——生成质量参差是常态，库里一旦混进
    没人看过的条目，整个库就不敢直接套用了。落不落由人改完点保存决定。
    覆盖前先存一份快照，给一次「撤销」：模型写出来的东西不满意是常事，
    而被覆盖掉的可能是用户自己打了十分钟的正文。 */
function AiComposer({
  hasBody,
  busy,
  err,
  note,
  options,
  onOptions,
  intent,
  onIntent,
  onCompose,
  canUndo,
  onUndo,
  autoFocus,
}: {
  hasBody: boolean
  busy: boolean
  err: string | null
  note: string | null
  options: ComposeOptions
  onOptions: (next: ComposeOptions) => void
  intent: string
  onIntent: (next: string) => void
  onCompose: (mode: 'create' | 'expand') => void
  canUndo: boolean
  onUndo: () => void
  autoFocus: boolean
}): JSX.Element {
  return (
    <section className="spl-ai">
      <div className="spl-ai-head">
        <IconSparkle />
        <label htmlFor="spl-ai-intent">让 AI 写一条</label>
      </div>
      <textarea
        id="spl-ai-intent"
        className="field-textarea spl-ai-intent"
        value={intent}
        autoFocus={autoFocus}
        placeholder="想要什么？例：给一双运动鞋拍街头风格产品图，黄昏暖光、湿地面反光"
        onChange={(e) => onIntent(e.target.value)}
      />

      <div className="spl-ai-opts">
        <Picker
          size="sm"
          className="spl-ai-lang"
          value={options.language}
          onChange={(v) => onOptions({ ...options, language: v === 'zh' ? 'zh' : 'en' })}
          options={[
            { value: 'en', label: '正文写英文' },
            { value: 'zh', label: '正文写中文' },
          ]}
        />
        <label className="spl-ai-check">
          <input
            type="checkbox"
            checked={options.withNegative}
            onChange={(e) => onOptions({ ...options, withNegative: e.target.checked })}
          />
          带负向
        </label>
        <label className="spl-ai-check" title="正文里留 {{占位}}，做成能反复套用的模板">
          <input
            type="checkbox"
            checked={options.withVariables}
            onChange={(e) => onOptions({ ...options, withVariables: e.target.checked })}
          />
          留占位
        </label>
      </div>

      <div className="spl-ai-acts">
        <button
          className={busy ? 'btn btn-sm btn-primary loading' : 'btn btn-sm btn-primary'}
          disabled={busy || intent.trim() === ''}
          title={intent.trim() === '' ? '先说一句想要什么' : '按上面这段描述写一条新的'}
          onClick={() => onCompose('create')}
        >
          {busy && <span className="spinner" />}
          写一条
        </button>
        <button
          className="btn btn-sm btn-outline"
          disabled={busy || !hasBody}
          title={
            hasBody
              ? '拿现在编辑框里的正文当原稿，让模型补齐构图、光线、材质这些每次都要写的维度'
              : '编辑框里还没有正文，先写点东西或者用左边的「写一条」'
          }
          onClick={() => onCompose('expand')}
        >
          扩写现有正文
        </button>
        {canUndo && (
          <button className="btn btn-sm" title="把 AI 覆盖掉的那一版换回来" onClick={onUndo}>
            撤销这次生成
          </button>
        )}
      </div>

      {err !== null && <p className="spl-fail">{err}</p>}
      {note !== null && <p className="spl-ai-note">{note}</p>}
      <p className="spl-ai-why">
        产出只落进上面的编辑框，<b>没有入库</b>——改到满意点「保存」才会存进库里。
      </p>
    </section>
  )
}

/** 新建 / 编辑一条提示词。

    铺满整页而不是 440px 的右侧抽屉：这些正文动辄两三百词，在一条窄缝里改长提示词
    是这一版之前最难受的一件事。正向正文占最宽的一栏、等宽字体、随窗口拉满高度；
    标题、场景、分组、变量声明这些一行就写完的东西挪到右侧窄栏。 */
export function PromptEditor({
  init,
  groups,
  groupsError,
  onClose,
  onSaved,
}: {
  init: Draft
  groups: PromptGroup[]
  groupsError: string | null
  onClose: () => void
  onSaved: () => void
}): JSX.Element {
  const [title, setTitle] = useState(init.title)
  const [scene, setScene] = useState(init.scene)
  const [body, setBody] = useState(init.body)
  const [negative, setNegative] = useState(init.negative)
  const [groupId, setGroupId] = useState<number | null>(init.group_id)
  const [declared, setDeclared] = useState<PromptVariable[]>(init.variables)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [askDiscard, setAskDiscard] = useState(false)
  const rootRef = useRef<HTMLElement | null>(null)

  const [intent, setIntent] = useState('')
  const [aiOptions, setAiOptions] = useState<ComposeOptions>(COMPOSE_DEFAULTS)
  const [aiBusy, setAiBusy] = useState(false)
  const [aiErr, setAiErr] = useState<string | null>(null)
  const [aiNote, setAiNote] = useState<string | null>(null)
  // AI 覆盖之前的那一版，给一次撤销
  const [aiUndo, setAiUndo] = useState<Draft | null>(null)

  // 名单跟着正文实时算：用户打完 `{{主体}}` 立刻能看到多出一个变量，
  // 不用先存一次才知道自己写对没有。保存时服务端会再派生一遍，那边才是事实源
  const variables = useMemo(
    () => mergeVariables(body, negative, declared),
    [body, negative, declared],
  )

  const dirty =
    title !== init.title ||
    scene !== init.scene ||
    body !== init.body ||
    negative !== init.negative ||
    groupId !== init.group_id ||
    JSON.stringify(variables) !== JSON.stringify(init.variables)

  /** 改了东西还没存就想关，先问一句——编辑器里躺的是刚打的一大段正文 */
  const requestClose = () => {
    if (dirty && !askDiscard) {
      setAskDiscard(true)
      return
    }
    onClose()
  }

  // 两段式 Esc：焦点在有内容的输入框里时，第一下只失焦（STD-UI-002b）
  useEscapeClose(() => {
    const el = document.activeElement
    if (
      (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) &&
      el.value !== '' &&
      rootRef.current !== null &&
      rootRef.current.contains(el)
    ) {
      el.blur()
      return
    }
    requestClose()
  })

  const compose = async (mode: 'create' | 'expand') => {
    if (aiBusy) return
    setAiBusy(true)
    setAiErr(null)
    setAiNote(null)
    try {
      const out = await composePrompt({
        intent: intent.trim(),
        draft: mode === 'expand' ? body : '',
        negative: mode === 'expand' ? negative : '',
        mode,
        language: aiOptions.language,
        with_negative: aiOptions.withNegative,
        with_variables: aiOptions.withVariables,
      })
      // 覆盖前存一份，模型写出来不满意是常事，而被盖掉的可能是用户自己打的正文
      setAiUndo({ id: init.id, title, scene, body, negative, group_id: groupId, variables })
      const merged = applyComposed({ title, scene, body, negative, variables }, out)
      setTitle(merged.title)
      setScene(merged.scene)
      setBody(merged.body)
      setNegative(merged.negative)
      setDeclared(merged.variables)
      setAiNote(composedNote(out))
    } catch (e) {
      // 后端 detail 原文照抄：能力没绑模型、模型没吐正文，都点了名
      setAiErr(errText(e))
    } finally {
      setAiBusy(false)
    }
  }

  const undoAi = () => {
    if (aiUndo === null) return
    setTitle(aiUndo.title)
    setScene(aiUndo.scene)
    setBody(aiUndo.body)
    setNegative(aiUndo.negative)
    setDeclared(aiUndo.variables)
    setAiUndo(null)
    setAiNote(null)
  }

  const save = async () => {
    if (busy) return
    const t = title.trim()
    const b = body.trim()
    if (t === '') {
      setErr('标题不能为空——列表和套用浮层里认的就是它')
      return
    }
    if (b === '') {
      setErr('正向正文不能为空，套用时插进提示词框的就是这段')
      return
    }
    setBusy(true)
    setErr(null)
    const payload = {
      title: t,
      body: b,
      negative: negative.trim(),
      scene: scene.trim(),
      group_id: groupId,
      variables,
    }
    try {
      if (init.id === null) await apiStudio.createPrompt(payload)
      else await apiStudio.patchPrompt(init.id, payload)
      toast.success(init.id === null ? '提示词已新建' : '提示词已保存，历史里多了一版')
      onSaved()
    } catch (e) {
      // 后端 detail 原文照抄，不改写成「保存失败，请重试」这种没信息的话
      setErr(errText(e))
    } finally {
      setBusy(false)
    }
  }

  const options: { id: number; label: string }[] = []
  for (const lib of groups.filter((g) => g.parent_id === null)) {
    options.push({ id: lib.id, label: lib.name })
    for (const sub of groups.filter((g) => g.parent_id === lib.id)) {
      options.push({ id: sub.id, label: `　└ ${sub.name}` })
    }
  }

  return (
    <aside
      className="spl-editor"
      ref={rootRef}
      aria-label={init.id === null ? '新建提示词' : '编辑提示词'}
    >
      <header className="spl-ed-head">
        <h2>{init.id === null ? '新建提示词' : `编辑提示词 #${init.id}`}</h2>
        {init.id !== null && (
          <span className="spl-ed-tip">存一次进一版历史，随时能翻回去</span>
        )}
        <span className="spl-flex" />
        <button className="icon-btn" aria-label="关闭" onClick={requestClose}>
          <IconClose />
        </button>
      </header>

      <div className="spl-ed-grid">
        <div className="spl-ed-main">
          <div className="spl-ed-sec spl-ed-grow">
            <div className="spl-sec-head">
              <label htmlFor="spl-f-body">正向正文</label>
              <span className="spl-ed-len">{lengthLabel(body)}</span>
              <button
                className="btn btn-ghost-sm"
                disabled={body === ''}
                onClick={() => void copyText(body, '正向正文')}
              >
                复制
              </button>
            </div>
            <textarea
              id="spl-f-body"
              className="field-textarea spl-body-input"
              value={body}
              // 新建时焦点直接落在正文上（走 AI 那条除外，那边焦点在描述框里）；
              // 改老条目不抢焦点，免得把光标从用户刚点的位置弹走
              autoFocus={init.id === null && init.focusAi !== true}
              spellCheck={false}
              placeholder="真正插进提示词框的内容。写 {{主体}} 这样的双花括号占位，右边就会出现对应的变量"
              onChange={(e) => setBody(e.target.value)}
            />
          </div>

          <div className="spl-ed-sec">
            <div className="spl-sec-head">
              <label htmlFor="spl-f-neg">负向（要避开什么）</label>
              <span className="spl-ed-len">{lengthLabel(negative)}</span>
            </div>
            <textarea
              id="spl-f-neg"
              className="field-textarea spl-neg-input"
              value={negative}
              spellCheck={false}
              placeholder="留空就是没写"
              onChange={(e) => setNegative(e.target.value)}
            />
            <span className="field-hint">
              套用时默认只插正文；选「正文+负向」才会在正文后另起一行写明分隔，再接这段。
            </span>
          </div>
        </div>

        <div className="spl-ed-side">
          <div className="field">
            <label htmlFor="spl-f-title">标题</label>
            <input
              id="spl-f-title"
              className="field-input"
              value={title}
              placeholder="如：写实产品图 · 白底"
              onChange={(e) => setTitle(e.target.value)}
            />
          </div>

          <div className="field">
            <label htmlFor="spl-f-scene">适用场景</label>
            <input
              id="spl-f-scene"
              className="field-input"
              value={scene}
              placeholder="一句话说清什么时候用它"
              onChange={(e) => setScene(e.target.value)}
            />
            <span className="field-hint">
              列表里显示的就是这一句。不写的话列表只能摘一段正文出来，两条同类模板摘出来
              长得几乎一样，挑的时候分不出。
            </span>
          </div>

          <div className="field">
            <label htmlFor="spl-f-group">所属分组</label>
            <Picker
              size="sm"
              className="field-select"
              value={groupId === null ? 'none' : String(groupId)}
              disabled={groupsError !== null}
              onChange={(v) => setGroupId(v === 'none' ? null : Number(v))}
              options={[
                { value: 'none', label: '未归组' },
                ...options.map((o) => ({ value: String(o.id), label: o.label })),
              ]}
            />
            {groupsError !== null && (
              // 不生效就要说清为什么与保存时会发生什么，别只把控件禁掉（STD-UI-006）
              <p className="spl-fail">
                分组接口没通，这一项这会儿改不了：{groupsError}
                {init.id === null ? '；新建的条目会先落进「未归组」。' : '；保存时按原来的归属存。'}
              </p>
            )}
            {groupsError === null && options.length === 0 && (
              <span className="field-hint">还没建过分组，先去左栏「新建库」。</span>
            )}
          </div>

          <VariableEditor variables={variables} onChange={setDeclared} />

          <AiComposer
            hasBody={body.trim() !== ''}
            busy={aiBusy}
            err={aiErr}
            note={aiNote}
            options={aiOptions}
            onOptions={setAiOptions}
            intent={intent}
            onIntent={setIntent}
            onCompose={(mode) => void compose(mode)}
            canUndo={aiUndo !== null}
            onUndo={undoAi}
            autoFocus={init.focusAi === true}
          />
        </div>
      </div>

      {err !== null && <p className="form-err spl-ed-err">{err}</p>}

      <div className="spl-ed-foot">
        {askDiscard ? (
          <>
            <span className="spl-discard">改动还没保存，确定放弃？</span>
            <button className="btn" onClick={() => setAskDiscard(false)}>
              继续编辑
            </button>
            <button className="btn btn-danger" onClick={onClose}>
              放弃改动
            </button>
          </>
        ) : (
          <>
            <span className="spl-ed-state">
              {dirty ? '有未保存的改动' : init.id === null ? '还没保存过' : '与库里一致'}
            </span>
            <span className="spl-flex" />
            <button className="btn" onClick={requestClose}>
              取消
            </button>
            <button
              className={busy ? 'btn btn-primary loading' : 'btn btn-primary'}
              onClick={() => void save()}
            >
              {busy && <span className="spinner" />}
              保存
            </button>
          </>
        )}
      </div>
    </aside>
  )
}

/* ==================== 全屏读正文 ==================== */

/** 把一段提示词摊开来读。

    详情栏宽 380，一段三百词的英文提示词在里面要滚四五屏；真要通读一遍或者
    跟另一条比着看的时候，这一层给的是整屏宽度和更宽松的行距。只读——
    改要走编辑器，两个能改的入口会打架。 */
function PromptReader({
  title,
  label,
  text,
  onClose,
}: {
  title: string
  label: string
  text: string
  onClose: () => void
}): JSX.Element {
  return (
    <Overlay onClose={onClose} card="spl-reader" labelledBy="spl-reader-title">
      <div className="overlay-head">
        <span className="overlay-title" id="spl-reader-title">
          {label} · {title}
        </span>
        <span className="spl-flex" />
        <span className="spl-ed-len">{lengthLabel(text)}</span>
      </div>
      <pre className="spl-reader-text">{text}</pre>
      <div className="overlay-foot">
        <button className="btn" onClick={onClose}>
          关闭
        </button>
        <button className="btn btn-soft" onClick={() => void copyText(text, label)}>
          复制
        </button>
      </div>
    </Overlay>
  )
}

/* ==================== 右栏：详情 ==================== */

/** 详情栏。列表里的正文只能截三行，而这些模板动辄两三百词——真正要看的就是那几百词，
    截断的摘要看不出两条「九宫格」差在哪。这一栏把正向、负向、变量全文摊开，
    并给两种取用方式：「复制正向」与「完整复制」（正文 + 分隔行 + 负向），
    与套用浮层的「只插正文 / 正文+负向」同一套语义（都走 fullPromptText）。 */
function PromptDetail({
  item,
  groupLabel,
  busy,
  open,
  onClose,
  onFill,
  onEdit,
  onDelete,
  onFork,
  onHistory,
  onFavorite,
  onHidden,
}: {
  item: PromptEntry
  groupLabel: string
  busy: boolean
  /** 用户主动点过某一条。窄屏下这一栏盖在列表上，没主动点就不该盖 */
  open: boolean
  onClose: () => void
  onFill: () => void
  onEdit: () => void
  onDelete: () => void
  onFork: () => void
  onHistory: () => void
  onFavorite: () => void
  onHidden: (next: boolean) => void
}): JSX.Element {
  const [reading, setReading] = useState<{ label: string; text: string } | null>(null)

  const hasNegative = item.negative.trim() !== ''
  const hasVars = item.variables.length > 0
  const title = item.title === '' ? '（无标题）' : item.title

  return (
    <aside
      className={open ? 'spl-detail spl-detail-open' : 'spl-detail'}
      aria-label="提示词详情"
    >
      <div className="spl-detail-head">
        <div className="spl-detail-titlerow">
          <h2 className="spl-detail-title">{title}</h2>
          {/* 宽屏下这一栏一直在，关不关无所谓；窄屏下它盖住列表，必须给一条回去的路 */}
          <button className="icon-btn spl-detail-close" aria-label="返回列表" onClick={onClose}>
            <IconClose />
          </button>
        </div>
        <div className="spl-detail-tags">
          {item.builtin && <span className="spl-badge">内置</span>}
          {item.category_name !== '' && (
            <span className="spl-badge spl-badge-cat">{item.category_name}</span>
          )}
          {item.source === 'Infinite-Canvas' && (
            <span className="spl-badge spl-badge-source" title={item.source_ref ?? undefined}>
              源自 Infinite-Canvas
            </span>
          )}
          {item.hidden && <span className="spl-badge spl-badge-hidden">已隐藏</span>}
        </div>
        <p className="spl-detail-meta">
          {item.builtin ? '随版本发布' : groupLabel} · 套用 {item.used_count} 次 ·{' '}
          {item.builtin ? '无版本链' : `第 ${item.version ?? 1} 版 · 更新 ${fmtTime(item.updated_at)}`}
        </p>
        {item.scene !== '' && <p className="spl-detail-scene">{item.scene}</p>}
      </div>

      <div className="spl-detail-body">
        <section className="spl-sec">
          <div className="spl-sec-head">
            <label>正向提示词</label>
            <span className="spl-ed-len">{lengthLabel(item.body)}</span>
            <button
              className="btn btn-ghost-sm"
              title="铺满整屏读这一段。三百词的提示词在这条窄栏里要滚四五屏"
              onClick={() => setReading({ label: '正向提示词', text: item.body })}
            >
              全屏
            </button>
            <button
              className="btn btn-ghost-sm"
              title={
                hasVars
                  ? '复制走的是带 {{占位}} 的原文（改模板时才要这个）。要能直接用的正文，点下面的「填变量」'
                  : '正文原样复制走'
              }
              onClick={() => void copyText(item.body, hasVars ? '原文（含占位）' : '正向提示词')}
            >
              {hasVars ? '复制原文' : '复制'}
            </button>
          </div>
          <p className="spl-full">{item.body}</p>
        </section>

        {hasNegative && (
          <section className="spl-sec">
            <div className="spl-sec-head">
              <label>负向提示词（要避开什么）</label>
              <span className="spl-ed-len">{lengthLabel(item.negative)}</span>
              <button
                className="btn btn-ghost-sm"
                onClick={() => setReading({ label: '负向提示词', text: item.negative })}
              >
                全屏
              </button>
              <button
                className="btn btn-ghost-sm"
                onClick={() => void copyText(item.negative, '负向提示词')}
              >
                {hasVars ? '复制原文' : '复制'}
              </button>
            </div>
            <p className="spl-full spl-full-neg">{item.negative}</p>
          </section>
        )}

        {hasVars && (
          <section className="spl-sec">
            <div className="spl-sec-head">
              <label>模板变量</label>
            </div>
            <ul className="spl-varlist">
              {item.variables.map((v) => (
                <li key={v.name}>
                  <code className={v.required ? 'spl-vartag spl-vartag-req' : 'spl-vartag'}>
                    {`{{${v.name}}}`}
                  </code>
                  <span className="spl-varlist-label">{v.label === '' ? v.name : v.label}</span>
                  {v.description !== '' && (
                    <span className="spl-varlist-desc">{v.description}</span>
                  )}
                  <span className="spl-varlist-req">{v.required ? '必填' : '可留空'}</span>
                </li>
              ))}
            </ul>
            <p className="spl-why">
              带变量的条目不能直接复制走：正文里的 <code>{'{{}}'}</code> 占位原样发给模型，
              模型不会报错，只会照着乱出图。点「填变量」把空填上，拿到的才是能直接用的正文。
            </p>
          </section>
        )}

        {item.builtin && (
          <p className="spl-why">
            {item.source === 'Infinite-Canvas' ? '该模板从 Infinite-Canvas 迁入并保留来源；' : ''}
            内置模板会随版本更新，直接改的话下次升级就被覆盖，所以这里不给改也不给删。
            要按自己的写法调，点「复制为自建」拿一份副本，副本随便改、随便删；
            只是不想再看见它，点「隐藏」——隐藏可逆，正文一个字不动，左栏「已隐藏」里能恢复。
          </p>
        )}
      </div>

      <div className="spl-detail-foot">
        {hasVars ? (
          <button className="btn btn-sm btn-primary" onClick={onFill}>
            <IconSparkle /> 填变量
          </button>
        ) : (
          <button
            className="btn btn-sm btn-primary"
            title="正文原样复制走"
            onClick={() => void copyText(item.body, '正向提示词')}
          >
            复制正向
          </button>
        )}
        <button
          className="btn btn-sm btn-soft"
          disabled={!hasNegative || hasVars}
          title={
            hasVars
              ? '这条带变量，完整版要先填空——点「填变量」，那边能把填好的正文与完整版一起复制走'
              : hasNegative
                ? '正文之后加一行分隔说明，再接负向内容——与套用浮层的「正文+负向」是同一段文字'
                : '这条没写负向内容，完整复制和只复制正文是一样的'
          }
          onClick={() => void copyText(fullPromptText(item.body, item.negative), '完整提示词')}
        >
          完整复制
        </button>
        <span className="spl-flex" />
        {item.builtin ? (
          <>
            <button
              className="btn btn-sm btn-outline"
              disabled={busy}
              title={
                item.hidden
                  ? '放回列表里'
                  : '从列表里收起来。内置模板删不掉（它是随版本发布的常量），隐藏可逆、内容不动'
              }
              onClick={() => onHidden(!item.hidden)}
            >
              {item.hidden ? '恢复' : '隐藏'}
            </button>
            <button className={busy ? 'btn btn-sm btn-soft loading' : 'btn btn-sm btn-soft'} onClick={onFork}>
              {busy ? <span className="spinner" /> : <IconFileText />}
              复制为自建
            </button>
          </>
        ) : (
          <>
            <button
              className="btn btn-sm btn-outline"
              disabled={busy}
              title={item.favorite ? '取消收藏' : '收藏（套用浮层里收藏的排最前）'}
              onClick={onFavorite}
            >
              <IconStar filled={item.favorite} />
              {item.favorite ? '已收藏' : '收藏'}
            </button>
            <button className="btn btn-sm btn-outline" onClick={onHistory}>
              <IconClock /> v{item.version ?? 1}
            </button>
            <button className="btn btn-sm btn-outline" onClick={onEdit}>
              <IconEdit /> 编辑
            </button>
            <button className="btn btn-sm btn-danger" onClick={onDelete}>
              <IconTrash /> 删除
            </button>
          </>
        )}
      </div>

      {reading !== null && (
        <PromptReader
          title={title}
          label={reading.label}
          text={reading.text}
          onClose={() => setReading(null)}
        />
      )}
    </aside>
  )
}

/** 列表项那一行说明。

    有「适用场景」就显示它——那是人写的中文一句话，说清什么时候用。没写才从正文
    现摘一段，并且标一下这是摘的：不标的话用户会以为自己给这条写过用途说明，
    而两条同类模板的正文开头长得几乎一样，摘出来的那行分不出谁是谁。 */
function PromptRowDigest({ item }: { item: PromptEntry }): JSX.Element {
  const digest = promptDigest(item)
  if (digest.text === '') return <span className="spl-row-scene">（还没写正文）</span>
  if (digest.fromScene) return <span className="spl-row-scene">{digest.text}</span>
  return (
    <span className="spl-row-scene spl-row-excerpt">
      <span className="spl-row-mark">正文</span>
      {digest.text}
    </span>
  )
}

/* ==================== 页面 ==================== */

export default function PromptLibraryPage(): JSX.Element {
  const qc = useQueryClient()
  const [params, setParams] = useSearchParams()
  const scope = useMemo(() => parseScope(params.get('scope')), [params])
  // 窄屏下左栏是抽屉：选完一档就收回去，不然它一直盖着列表
  const [railOpen, setRailOpen] = useState(false)
  const setScope = (next: Scope) => {
    const patched = new URLSearchParams(params)
    const encoded = encodeScope(next)
    if (encoded === 'all') patched.delete('scope')
    else patched.set('scope', encoded)
    // 换一档就把选中项松开：新的一档里多半没有刚才那条，留着它窄屏下会
    // 顶着详情栏盖住列表，用户以为自己没切成功。与 scope 同一次写入，
    // 分两次 setParams 会各自基于同一份旧 params 算，后一次把前一次覆盖掉
    patched.delete('item')
    setParams(patched, { replace: true })
    setRailOpen(false)
  }
  const [text, setText] = useState('')
  const [sort, setSort] = useState<SortKey>('updated')
  const [draft, setDraft] = useState<Draft | null>(null)
  const [deleting, setDeleting] = useState<PromptEntry | null>(null)
  const [delBusy, setDelBusy] = useState(false)
  const [rowBusy, setRowBusy] = useState<number | null>(null)
  const [filling, setFilling] = useState<PromptEntry | null>(null)
  /* 选中项进地址栏（`?item=`），与左栏那一档同一条口径。三个理由：
     刷新之后还停在同一条上；「看看这条」能直接把链接发出去；窄屏下详情栏是
     盖在列表上的一层，它开着没开着属于「现在在看什么」，本来就该在地址里。
     存 id 而不是整条：列表重取之后拿着旧快照，详情栏会停在改之前的内容上。 */
  const pickedId = useMemo(() => {
    const raw = params.get('item')
    if (raw === null || raw.trim() === '') return null
    const id = Number(raw)
    return Number.isFinite(id) ? id : null
  }, [params])
  const setPickedId = (id: number | null) => {
    const patched = new URLSearchParams(params)
    if (id === null) patched.delete('item')
    else patched.set('item', String(id))
    setParams(patched, { replace: true })
  }
  const [historyId, setHistoryId] = useState<number | null>(null)

  const groupsQuery = useQuery({ queryKey: ['spl-groups'], queryFn: () => apiStudio.promptGroups() })
  // 只有库自己带 include_hidden：被隐藏的内置模板得看得见才谈得上恢复。
  // 键上多一段 'library'，与套用浮层的 ['spl-prompts'] 分开缓存，前缀失效仍然一起刷
  const listQuery = useQuery({
    queryKey: ['spl-prompts', 'library'],
    queryFn: () => fetchPromptLibrary(true),
  })

  const groups: PromptGroup[] = groupsQuery.data?.items ?? []
  const groupsError = groupsQuery.isError ? errText(groupsQuery.error) : null

  const all = useMemo(() => listQuery.data?.items ?? [], [listQuery.data])
  const categories = listQuery.data?.categories ?? []

  const counts = useMemo<Counts>(() => {
    const byCategory: Record<string, number> = {}
    for (const item of all) {
      if (item.hidden || item.category === null) continue
      byCategory[item.category] = (byCategory[item.category] ?? 0) + 1
    }
    const visible = all.filter((i) => !i.hidden)
    return {
      all: visible.length,
      mine: visible.filter((i) => !i.builtin).length,
      builtin: visible.filter((i) => i.builtin).length,
      ungrouped: visible.filter((i) => !i.builtin && i.group_id === null).length,
      favorite: visible.filter((i) => i.favorite).length,
      hidden: all.filter((i) => i.hidden).length,
      byCategory,
    }
  }, [all])

  const shown = useMemo(() => {
    const q = text.trim().toLowerCase()
    const hit = all.filter((it) => {
      if (!inScope(it, scope)) return false
      if (q === '') return true
      const hay = `${it.title} ${it.scene} ${it.body} ${it.negative} ${it.category_name}`
      return hay.toLowerCase().includes(q)
    })
    return [...hit].sort((a, b) => {
      if (sort === 'used' && a.used_count !== b.used_count) return b.used_count - a.used_count
      // 内置模板没有 updated_at，天然沉在自建条目下面；同为内置时按声明顺序（id 从 -1 起）
      const at = a.updated_at ?? ''
      const bt = b.updated_at ?? ''
      if (at !== bt) return bt.localeCompare(at)
      if (a.category_sort !== b.category_sort) return a.category_sort - b.category_sort
      return b.id - a.id
    })
  }, [all, scope, text, sort])

  // 选中项跟着列表走：筛掉之后回落到第一条，详情栏永远有东西看
  const picked = shown.find((it) => it.id === pickedId) ?? shown[0] ?? null
  /* 「用户主动点过这一条」而不是「回落到了第一条」。窄屏下详情栏盖在列表上，
     只有前者才该盖上来——搜索把选中项筛掉之后详情要自己让开，
     否则用户看着一条自己没点过的条目，还找不回列表。 */
  const pickedByUser = pickedId !== null && shown.some((it) => it.id === pickedId)
  const historyItem = historyId === null ? undefined : all.find((it) => it.id === historyId)

  const groupName = (id: number | null) =>
    id === null ? '未归组' : (groups.find((g) => g.id === id)?.name ?? `分组 #${id}`)

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['spl-prompts'] })
    void qc.invalidateQueries({ queryKey: ['spl-groups'] })
  }

  const toggleFav = async (item: PromptEntry) => {
    if (rowBusy !== null) return
    setRowBusy(item.id)
    try {
      await apiStudio.patchPrompt(item.id, { favorite: !item.favorite })
      refresh()
    } catch (e) {
      toast.error(errText(e))
    } finally {
      setRowBusy(null)
    }
  }

  /** 隐藏 / 恢复一条内置模板。删不掉是因为它不是一行数据，隐藏可逆、内容不动 */
  const toggleHidden = async (item: PromptEntry, next: boolean) => {
    if (rowBusy !== null) return
    setRowBusy(item.id)
    try {
      await setPromptHidden(item.id, next)
      toast.success(
        next
          ? '已隐藏。左栏「已隐藏」里随时恢复，正文一个字没动'
          : '已恢复，这条模板回到列表里了',
      )
      refresh()
    } catch (e) {
      toast.error(errText(e))
    } finally {
      setRowBusy(null)
    }
  }

  /** 内置模板复制成自建，复制完直接开抽屉——用户点这个按钮就是想改 */
  const fork = async (item: PromptEntry) => {
    if (rowBusy !== null) return
    setRowBusy(item.id)
    try {
      const copy = await apiStudio.forkPrompt(item.id)
      refresh()
      setPickedId(copy.id)
      setDraft({
        id: copy.id,
        title: copy.title,
        scene: copy.scene,
        body: copy.body,
        negative: copy.negative,
        group_id: copy.group_id,
        variables: copy.variables,
      })
      toast.success('已复制成自建条目，改完记得保存。原模板还留在系统库里，不想再看见就点它的「隐藏」')
    } catch (e) {
      toast.error(errText(e))
    } finally {
      setRowBusy(null)
    }
  }

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

  const editDraft = (it: PromptEntry): Draft => ({
    id: it.id,
    title: it.title,
    scene: it.scene,
    body: it.body,
    negative: it.negative,
    group_id: it.group_id,
    variables: it.variables,
  })

  const newDraft = (focusAi: boolean): Draft => ({
    id: null,
    title: '',
    scene: '',
    body: '',
    negative: '',
    group_id: scope.kind === 'group' ? scope.id : null,
    variables: [],
    focusAi,
  })

  return (
    <main className="page spl-page">
      <LibraryRail
        groups={groups}
        categories={categories}
        loading={groupsQuery.isPending}
        error={groupsError}
        counts={counts}
        scope={scope}
        open={railOpen}
        onScope={setScope}
        onChanged={refresh}
      />
      {/* 窄屏下左栏浮在列表上，点旁边收回去。宽屏下这块永远不显示 */}
      {railOpen && (
        <button
          className="spl-scrim"
          aria-label="收起分类栏"
          onClick={() => setRailOpen(false)}
        />
      )}

      <section className="spl-main">
        <AssetManagerTabs active="prompts" />
        <header className="spl-head">
          <div className="spl-head-text">
            <h1>提示词库</h1>
            <p>{scopeTitle(scope, groups, categories)} · 分组只是贴归属，删组不删条目</p>
          </div>
          <span className="spl-flex" />
          <button
            className="btn btn-soft"
            title="说一句想要什么，模型写出正向与负向，落进编辑器给你改——不会直接进库"
            onClick={() => setDraft(newDraft(true))}
          >
            <IconSparkle /> AI 写一条
          </button>
          <button className="btn btn-primary" onClick={() => setDraft(newDraft(false))}>
            <IconPlus /> 新建提示词
          </button>
        </header>

        <div className="spl-bar">
          {/* 窄屏下左栏收成抽屉，这个按钮是唯一的入口；宽屏下它不显示 */}
          <button
            className="spl-rail-toggle"
            aria-label="分类与分组"
            onClick={() => setRailOpen(true)}
          >
            <IconSidebar /> 分类
          </button>
          <span className="spl-search">
            <IconSearch />
            <input
              value={text}
              placeholder="搜标题、场景、正文、负向…"
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape' && text !== '') {
                  // 先清搜索词，不冒到浮层栈（STD-UI-002b）
                  e.stopPropagation()
                  setText('')
                }
              }}
            />
          </span>
          <div className="spl-sorts">
            <button
              className={sort === 'updated' ? 'spl-sort spl-sort-on' : 'spl-sort'}
              onClick={() => setSort('updated')}
            >
              最近更新
            </button>
            <button
              className={sort === 'used' ? 'spl-sort spl-sort-on' : 'spl-sort'}
              onClick={() => setSort('used')}
            >
              最常用
            </button>
          </div>
          <span className="spl-flex" />
          <span className="spl-count">
            {shown.length} 条{text.trim() !== '' && ` / 共 ${counts.all}`}
          </span>
        </div>

        {listQuery.isError && (
          <p className="spl-note spl-note-err">
            提示词加载失败：{errText(listQuery.error)}
            <button className="btn btn-ghost-sm" onClick={() => void listQuery.refetch()}>
              重试
            </button>
          </p>
        )}

        <div className="spl-body">
          {listQuery.isPending && <p className="spl-empty">载入提示词…</p>}
          {!listQuery.isPending && !listQuery.isError && shown.length === 0 && (
            <p className="spl-empty">
              {counts.all === 0
                ? '提示词库还是空的。点右上角「新建提示词」写一条，各工具的提示词框就能一键套用。'
                : scope.kind === 'hidden'
                  ? '没有被隐藏的内置模板。'
                  : '这里没有匹配的条目。换个词，或切到左栏「全部」。'}
            </p>
          )}

          {shown.length > 0 && (
            <div className="spl-list">
              {shown.map((it) => (
                <button
                  key={it.id}
                  className={
                    picked !== null && picked.id === it.id ? 'spl-row spl-row-on' : 'spl-row'
                  }
                  onClick={() => setPickedId(it.id)}
                >
                  <span className="spl-row-top">
                    {it.favorite && (
                      <span className="spl-star spl-star-on" aria-label="已收藏">
                        <IconStar filled />
                      </span>
                    )}
                    <span className="spl-row-title">{it.title === '' ? '（无标题）' : it.title}</span>
                    {it.builtin && <span className="spl-badge">内置</span>}
                    {it.category_name !== '' && (
                      <span className="spl-badge spl-badge-cat">{it.category_name}</span>
                    )}
                    {it.hidden && <span className="spl-badge spl-badge-hidden">已隐藏</span>}
                  </span>
                  <PromptRowDigest item={it} />
                  <span className="spl-row-meta">
                    {it.builtin ? '随版本发布' : groupName(it.group_id)}
                    {it.variables.length > 0 && ` · ${it.variables.length} 个变量`}
                    {it.negative.trim() !== '' && ' · 带负向'}
                    {` · ${promptStats(it.body).words} 词`}
                    {it.used_count > 0 && ` · 套用 ${it.used_count} 次`}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
      </section>

      {picked !== null && (
        <PromptDetail
          key={picked.id}
          item={picked}
          groupLabel={groupName(picked.group_id)}
          busy={rowBusy === picked.id}
          open={pickedByUser}
          onClose={() => setPickedId(null)}
          onFill={() => setFilling(picked)}
          onEdit={() => setDraft(editDraft(picked))}
          onDelete={() => setDeleting(picked)}
          onFork={() => void fork(picked)}
          onHistory={() => setHistoryId(picked.id)}
          onFavorite={() => void toggleFav(picked)}
          onHidden={(next) => void toggleHidden(picked, next)}
        />
      )}

      {draft !== null && (
        // key 让换一条编辑时表单彻底重建，否则上一条的正文会留在框里
        <PromptEditor
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
      )}

      {filling !== null && (
        <VariableFillOverlay key={filling.id} item={filling} onClose={() => setFilling(null)} />
      )}

      {historyItem !== undefined && (
        <RevisionPanel
          kind="prompt"
          id={historyItem.id}
          name={historyItem.title === '' ? '（无标题）' : historyItem.title}
          currentVersion={historyItem.version}
          onRestored={refresh}
          onClose={() => setHistoryId(null)}
        />
      )}

      {deleting !== null && (
        <Overlay onClose={() => setDeleting(null)} card="ov-narrow" labelledBy="spl-del-title">
          <div className="overlay-head">
            <span className="overlay-title" id="spl-del-title">
              删除「{deleting.title === '' ? '（无标题）' : deleting.title}」？
            </span>
          </div>
          <p className="spl-warn">
            <IconAlert />
            <span>
              <b>这一条会被真删掉，正文和负向都不再保留。</b>
              已经用它生成过的图不受影响——图归模块 16 的资产库管，删提示词动不了它。
            </span>
          </p>
          <p className="spl-warn-note">
            只是暂时不想在列表里看到它，取消收藏或挪到一个不常开的分组更合适。
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
    </main>
  )
}
