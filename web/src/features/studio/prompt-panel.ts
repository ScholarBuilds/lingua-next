/* 提示词面板的纯逻辑：宽度记忆与筛选排序。

   拆出来是因为面板本体是个带 portal、带指针拖拽的组件，本仓 vitest 跑在 node 里
   （没有 jsdom），这两样在组件里验不了。宽度的钳制规则和「哪几条该出现在列表上」
   才是真正会出错的地方——钳制写错，面板能盖住半张画布；筛选写错，用户以为
   自己的条目没保存上。

   这里不 import 任何组件模块：面板从这里取值，反过来不成立。提示词条目只按
   结构约束成 `PromptLike`，不引 `PromptEntry`，省掉一条只为类型存在的依赖边。 */

import type { PromptVariable } from '../../lib/api-studio'
import { hasUnfilledPlaceholders } from './prompt-variables'

/** 面板最窄。再窄的话一行放不下六七个英文词，长提示词的摘要全成截断 */
export const PANEL_MIN_W = 320

/** 面板最宽。挑词是「看着画布挑」，面板宽过这个数就变成第二个页面了 */
export const PANEL_MAX_W = 760

export const PANEL_DEFAULT_W = 420

/** 画布那边至少要留出来的宽度。

    这是「右侧面板」与「居中弹窗」的全部区别：用户要一边看图一边挑词，
    面板可以拖宽，但不能宽到把画布中央和底下的输入框压没——那样还不如弹窗。 */
export const CANVAS_KEEP_W = 480

export const PANEL_WIDTH_KEY = 'lingua.studio.prompt-panel-width'

type MiniStorage = Pick<Storage, 'getItem' | 'setItem'>

/** 拿存储。面板宽度是本机的手感偏好，不入库：同步到服务端要多一张表和一条
    同步链路，换不来任何东西。 */
function pickStorage(explicit?: MiniStorage): MiniStorage | null {
  if (explicit !== undefined) return explicit
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    // Safari 无痕模式读 localStorage 直接抛，不能让它把整个面板带崩
    return null
  }
}

/** 把一个宽度钳进可用区间。

    上限跟着视口走而不是常量：1280 宽的窗口拖到 760 还剩 520 给画布，
    900 宽的窗口就只能给到 420。视口窄到连 `PANEL_MIN_W + CANVAS_KEEP_W` 都不够时
    以最小宽为准——那一档由 CSS 的窄屏规则接管，逻辑这边不该返回一个负数。 */
export function clampPanelWidth(px: number, viewport: number): number {
  const room = Number.isFinite(viewport) && viewport > 0 ? viewport : PANEL_DEFAULT_W + CANVAS_KEEP_W
  const upper = Math.max(PANEL_MIN_W, Math.min(PANEL_MAX_W, room - CANVAS_KEEP_W))
  if (!Number.isFinite(px)) return Math.min(PANEL_DEFAULT_W, upper)
  return Math.max(PANEL_MIN_W, Math.min(upper, Math.round(px)))
}

/** 读上次的宽度。存的东西坏了就当没存过——宽度是便利功能，不值得为一条脏数据
    让面板打不开。 */
export function loadPanelWidth(viewport: number, storage?: MiniStorage): number {
  const store = pickStorage(storage)
  if (store === null) return clampPanelWidth(PANEL_DEFAULT_W, viewport)
  try {
    const raw = store.getItem(PANEL_WIDTH_KEY)
    if (raw === null || raw.trim() === '') return clampPanelWidth(PANEL_DEFAULT_W, viewport)
    const n = Number(raw)
    return clampPanelWidth(Number.isFinite(n) ? n : PANEL_DEFAULT_W, viewport)
  } catch {
    return clampPanelWidth(PANEL_DEFAULT_W, viewport)
  }
}

/** 记下宽度。写失败（配额满、无痕模式）就算了，不打断拖拽 */
export function savePanelWidth(px: number, storage?: MiniStorage): void {
  const store = pickStorage(storage)
  if (store === null) return
  try {
    store.setItem(PANEL_WIDTH_KEY, String(Math.round(px)))
  } catch {
    /* 存不下就不存 */
  }
}

/* ==================== 筛选与排序 ==================== */

/** 库切换。内置模板、自建条目、收藏是三批几乎不混着找的东西 */
export type PromptScope = 'all' | 'system' | 'mine' | 'favorite'

export type GroupFilter = 'all' | 'none' | number

/** 排序档。`smart` = 收藏优先 → 最常用，是挑词时想要的顺序；
    改完一条想立刻找回它的时候才切「最近更新」。 */
export type PanelSort = 'smart' | 'updated' | 'used'

/** 筛选只认这几个字段，不绑死 `PromptEntry`——面板与库页的条目类型将来若分家，
    这一层不用跟着改。 */
export interface PromptLike {
  id: number
  title: string
  scene: string
  body: string
  negative: string
  group_id: number | null
  builtin: boolean
  hidden: boolean
  favorite: boolean
  used_count: number
  category: string | null
  category_name: string
  category_sort: number
  updated_at: string | null
}

export interface PanelQuery {
  text: string
  scope: PromptScope
  group: GroupFilter
  category: string
  sort: PanelSort
  /** 把隐藏掉的内置模板也列出来。只有「系统模板」那一档给得出这个开关——
      隐藏是可逆的，看不见就没法恢复。 */
  showHidden: boolean
}

export const PANEL_QUERY_DEFAULTS: PanelQuery = {
  text: '',
  scope: 'all',
  group: 'all',
  category: 'all',
  sort: 'smart',
  showHidden: false,
}

function matchesText(item: PromptLike, needle: string): boolean {
  if (needle === '') return true
  const hay = `${item.title} ${item.scene} ${item.body} ${item.negative} ${item.category_name}`
  return hay.toLowerCase().includes(needle)
}

function inScope(item: PromptLike, q: PanelQuery): boolean {
  switch (q.scope) {
    case 'system':
      return item.builtin
    case 'mine':
      return !item.builtin
    case 'favorite':
      return item.favorite
    case 'all':
      return true
  }
}

/** 分类是内置模板的属性，分组是自建条目的归属：各管各的那一边，不互相过滤。
    合着算的话，切到一个自建分组会把内置模板全筛掉，而用户只是想换个分组看看。 */
function inBucket(item: PromptLike, q: PanelQuery): boolean {
  if (item.builtin) {
    return q.category === 'all' || item.category === q.category
  }
  if (q.group === 'none') return item.group_id === null
  if (typeof q.group === 'number') return item.group_id === q.group
  return true
}

function compare(a: PromptLike, b: PromptLike, sort: PanelSort): number {
  if (sort === 'smart') {
    // 收藏过的和一直在用的排在刚建还没用过的前面，否则常用那几条会被新建的挤到底下
    if (a.favorite !== b.favorite) return a.favorite ? -1 : 1
    if (a.used_count !== b.used_count) return b.used_count - a.used_count
    return (b.updated_at ?? '').localeCompare(a.updated_at ?? '')
  }
  if (sort === 'used' && a.used_count !== b.used_count) return b.used_count - a.used_count
  const at = a.updated_at ?? ''
  const bt = b.updated_at ?? ''
  // 内置模板没有 updated_at，天然沉在自建条目下面；同为内置时按声明顺序（id 从 -1 起）
  if (at !== bt) return bt.localeCompare(at)
  if (a.category_sort !== b.category_sort) return a.category_sort - b.category_sort
  return b.id - a.id
}

/** 面板列表的那一份数组。左上角的计数、列表、空状态全部读它，保证对得上。

    隐藏的内置模板默认不出现：不然「隐藏」这个动作在界面上就没有可观察的效果。
    开了 `showHidden` 才连隐藏的一起列，那是恢复它们的唯一入口。 */
export function filterPrompts<T extends PromptLike>(all: T[], q: PanelQuery): T[] {
  const needle = q.text.trim().toLowerCase()
  const hit = all.filter((item) => {
    if (item.hidden && !q.showHidden) return false
    if (!inScope(item, q)) return false
    if (!inBucket(item, q)) return false
    return matchesText(item, needle)
  })
  return [...hit].sort((a, b) => compare(a, b, q.sort))
}

/** 顶上四个档各有多少条。与列表同源算——两处各算一遍就会出现
    「标签上写 12 条，点进去只有 9 条」。 */
export function scopeCounts(all: PromptLike[], showHidden: boolean): Record<PromptScope, number> {
  const live = all.filter((item) => showHidden || !item.hidden)
  return {
    all: live.length,
    system: live.filter((item) => item.builtin).length,
    mine: live.filter((item) => !item.builtin).length,
    favorite: live.filter((item) => item.favorite).length,
  }
}

/* ==================== 编辑器草稿 ==================== */

/** 交给编辑器的那份草稿。`id` 为 null = 新建。

    形状与提示词库页编辑器的 `init` 一致——面板不自己写第二个编辑器，
    长提示词在一条窄缝里改是这套东西最难受的一件事，编辑器铺满整屏才对。
    两边对不上时 tsc 会在面板那边报错，因为它把这个类型喂给了同一个组件。 */
export interface PromptDraft {
  id: number | null
  title: string
  scene: string
  body: string
  negative: string
  group_id: number | null
  variables: PromptVariable[]
  /** 开编辑器时焦点直接落进 AI 那格。「AI 写一条」进来的就是它 */
  focusAi?: boolean
}

export type PromptEntryLike = PromptLike & { variables: PromptVariable[] }

/** 空草稿。当前正筛着某个自建分组时，新建的条目默认落进那个分组——
    用户是在那一档里点的「新建」，落到别处等于建完就找不着。 */
export function blankDraft(group: GroupFilter, focusAi: boolean): PromptDraft {
  return {
    id: null,
    title: '',
    scene: '',
    body: '',
    negative: '',
    group_id: typeof group === 'number' ? group : null,
    variables: [],
    focusAi,
  }
}

/** 拿一条已有的条目当草稿。内置模板不走这条路——它不是一行数据，改了下次升级就没了，
    要改先 fork 成自建（后端对负数 id 的写操作一律 400）。 */
export function editDraft(item: PromptEntryLike): PromptDraft {
  return {
    id: item.id,
    title: item.title,
    scene: item.scene,
    body: item.body,
    negative: item.negative,
    group_id: item.group_id,
    variables: item.variables,
  }
}

/* ==================== 套用前的关口 ==================== */

/** 这一条能不能直接插进提示词框，还是得先填空。

    整条链路上唯一真正会出事的失败模式：带 `{{name}}` 的正文原样发给模型，
    模型不报错，只会照着这段占位乱出图。所以两个信号都要看——`variables` 是
    服务端按正文派生的，但缓存里的旧条目、手改过的库都可能让它为空而正文里
    还留着占位。 */
export function needsFill(item: { variables: PromptVariable[]; body: string; negative: string }): boolean {
  return item.variables.length > 0 || hasUnfilledPlaceholders(item.body, item.negative)
}
