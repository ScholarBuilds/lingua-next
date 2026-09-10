/* 画布输入框的纯逻辑（模块 17 · 生成模式 / 批量出图 / 最近提示词 / 草稿拼接）。

   抽出 CanvasPage 的理由只有一条：这几件事都得有单测，而组件里跑不了——
   本仓 vitest 跑在 node 环境（没有 jsdom），DOM 与 React 树都摸不到，
   只有纯函数验得动。 */

import type {
  CanvasCountMode,
  CanvasRunMode,
  CanvasRunSettings,
  SetPlan,
  StudioTask,
} from '../../lib/api-studio'

/** 批量出图的并发上限。

    **不是 `GEN_N_MAX`**。那个数（50）管的是「一个节点这一次要几张图」，
    由 `generateFrom` 内部拆成 N 个各自成败的单张任务；这里管的是
    「同时对几个节点发起生成」。两个数是**相乘**的关系：选 20 个节点各 4 张，
    不限并发就是 80 个请求同时出门，上游限流一挡，整批一起红。
    3 是按「一屏之内看得清谁在跑」定的，不是物理上限。 */
export const BULK_CONCURRENCY = 3

/** 最近提示词存几条。存多了下拉要滚动，反而不如重新打一遍快 */
export const RECENT_MAX = 12

/** 单条最近提示词留多长。超长的（贴了一整段结构化 JSON）截断存，
    免得把 localStorage 的配额吃光——那会让整个域名的存储写入静默失败 */
export const RECENT_ITEM_MAX = 600

/** localStorage 的键。带 `lingua.` 前缀是为了和别的站点/别的功能分开 */
export const RECENT_KEY = 'lingua.canvas.recent-prompts'

/* ==================== 生成模式：出几张 × 怎么跑 ==================== */

/** 输入框上只有两个正交的选择，其余全部由它们推导。

    收口之前这三件事分散在三个入口：张数在参数行的数字框、串行只能去画布上
    建一个循环节点再连线、成套是动作行上另一个按钮。三个入口互不知道对方存在，
    用户要「出一套登录页」得先猜自己该点哪一个。

    映射到既有能力（**都是复用，不是重写**）：
    - `one` / `fixed` + `parallel` → `generateFrom` 的张数 N（N 个各自成败的单张任务）；
    - `fixed` + `serial` → `runSetPlan` 的 consistent 语义（上一张的产物进下一张的参考），
      与循环节点 `mode:'serial'` 同一条链，只是不必先在画布上画出来；
    - `auto` → 成套弹窗（AI 问清需求后决定几张、每张写什么词）。 */
export interface GenMode {
  count: CanvasCountMode
  run: CanvasRunMode
  /** 这一次真正会起几张。`auto` 时为 null——张数要等 AI 规划完才知道，
   *  拿一个占位数字去算「预计多久」只会是一句假话 */
  n: number | null
}

/** 切到「多张」时给的默认张数。给 1 的话用户还得再点一次数字框才有意义 */
export const GEN_N_DEFAULT = 4

/** 从 run_settings 读出模式。

    **旧画布只有 `n`**（收口之前界面上只有那个数字框），所以缺 `count_mode` 时
    按 `n` 反推：n>1 当作「多张·并发」，否则「1 张」。这样旧画布打开后
    看到的模式与它上次真正跑的一致，不需要迁移。 */
export function genModeOf(
  rs: Pick<CanvasRunSettings, 'n' | 'count_mode' | 'run_mode'> | undefined,
  max: number,
): GenMode {
  const raw = Math.round(Number(rs?.n ?? 1))
  const n = Number.isFinite(raw) ? Math.max(1, Math.min(raw, max)) : 1
  const count: CanvasCountMode = rs?.count_mode ?? (n > 1 ? 'fixed' : 'one')
  const run: CanvasRunMode = rs?.run_mode === 'serial' ? 'serial' : 'parallel'
  if (count === 'auto') return { count, run, n: null }
  if (count === 'one') return { count, run, n: 1 }
  return { count, run, n }
}

/** 切换「出几张」要写回 run_settings 的补丁。

    **`n` 必须跟着写**：运行时 `generateFrom` 只读 `rs.n`，光改 `count_mode`
    的话选了「1 张」还照旧出 4 张，而且不报错——本仓在「UI 上能改的参数
    必须回头确认运行时真的读它」这条上已经栽过一次（循环节点的三个控件）。 */
export function countModePatch(
  next: CanvasCountMode,
  current: GenMode,
  max: number,
): { count_mode: CanvasCountMode; n: number } {
  if (next === 'fixed') {
    const keep = current.n ?? 0
    return { count_mode: next, n: keep > 1 ? Math.min(keep, max) : Math.min(GEN_N_DEFAULT, max) }
  }
  // one 与 auto 都只会起一次请求：auto 的真实张数由成套方案决定，不经 rs.n
  return { count_mode: next, n: 1 }
}

/** 张数框改动后的补丁。夹在 [1, max]，非数字退回 1。

    **停在 `fixed` 不因为敲到 1 就跳回「1 张」**：数字框只在「多张」那一档存在，
    用户清空重打的中途必然经过空串（读成 1），跳档会让输入框在打字过程中消失。 */
export function countPatch(raw: unknown, max: number): { count_mode: CanvasCountMode; n: number } {
  const value = Math.round(Number(raw))
  const n = Number.isFinite(value) ? Math.max(1, Math.min(value, max)) : 1
  return { count_mode: 'fixed', n }
}

/** 批量条上「统一张数」写回时的补丁。

    与 `countPatch` 的差别只有 1 张那一档：批量是从下拉里**选定**的，
    不存在打字中途，选了 1 就该让单节点输入框显示「1 张」并把跑法收起来。 */
export function bulkCountPatch(
  raw: unknown,
  max: number,
): { count_mode: CanvasCountMode; n: number } {
  const patch = countPatch(raw, max)
  return patch.n <= 1 ? { count_mode: 'one', n: 1 } : patch
}

/** 「怎么跑」要不要出现在条上。

    只出一张时并发与串行跑出来的东西一模一样，摆着它是纯噪声——
    **隐藏而不是禁用**：禁用的控件仍占位置、仍要读一遍才知道点不动。
    `auto` 也不出现，它的跑法由成套弹窗里那对按钮决定（那里才知道有几步）。 */
export function showRunPicker(mode: GenMode): boolean {
  return mode.count === 'fixed' && (mode.n ?? 1) > 1
}

/** 这次提交走哪条链路。三条都是既有能力，这里只做分派 */
export type GenRoute = 'single' | 'serial-set' | 'plan'

export function genRoute(mode: GenMode): GenRoute {
  if (mode.count === 'auto') return 'plan'
  if (mode.count === 'fixed' && mode.run === 'serial' && (mode.n ?? 1) > 1) return 'serial-set'
  return 'single'
}

export interface GenPlanInput {
  mode: GenMode
  /** 节点上已经有图。决定并发是分支出新节点还是落回本节点 */
  hasItems: boolean
  /** 会一起上送的参考图张数 */
  refs: number
  /** 这个节点最近几次单张出图的实测秒数。空 = 没有可依据的数据 */
  samples: number[]
}

/** 点下去之前先把「将要发生什么」摆出来。

    现在点完就是一片进度条，用户不知道自己刚才点了什么——尤其在
    「4 张 · 串行」这种要跑几分钟的组合上，跑错了才发现的代价是几分钟加几次调用。
    分段返回而不是拼好一整句，是为了让界面自己决定怎么排（窄了要换行）。 */
export function genPlanLine(input: GenPlanInput): string[] {
  const { mode, hasItems, refs } = input
  const out: string[] = []
  const n = mode.n

  out.push(mode.count === 'auto' ? '张数由 AI 从提示词判断' : `出 ${n ?? 1} 张`)

  if (mode.count === 'auto') out.push('跑法在成套弹窗里定')
  else if ((n ?? 1) > 1) {
    out.push(
      mode.run === 'serial'
        ? '串行：同一句词跑 N 遍，后一张看得见前一张'
        : '并发：同时发出去，各自成败',
    )
  }

  if (mode.count === 'auto') out.push('落在本节点下方一排')
  else if (genRoute(mode) === 'serial-set') out.push(`本节点下方排 ${n ?? 1} 个新节点`)
  else if (hasItems) out.push('落在右侧新建的节点里')
  else out.push('落进本节点')

  out.push(refs > 0 ? `带 ${refs} 张参考（按图1…图${refs} 的顺序上送）` : '文生图，没有参考图')

  const eta = etaSeconds(input.samples, mode)
  if (eta !== null) out.push(`按最近 ${input.samples.length} 次估约 ${durationText(eta)}`)

  return out
}

/** 预计耗时。

    **样本不够就返回 null，不猜**：编一个「约 30 秒」出来，用户等到 3 分钟时
    只会觉得这条也在骗他。取中位数而不是均值——出图偶尔卡上游一次两分钟，
    均值会被那一次拖到毫无参考价值。

    并发按「一起出门、一起回来」估（`generateFrom` 是 `Promise.all`，
    客户端不限并发），串行按 N 倍估。 */
export function etaSeconds(samples: number[], mode: GenMode): number | null {
  const usable = samples.filter((value) => Number.isFinite(value) && value > 0)
  if (usable.length < 2 || mode.n === null) return null
  const sorted = [...usable].sort((a, b) => a - b)
  const mid = sorted[Math.floor(sorted.length / 2)]
  return Math.max(1, Math.round(mode.run === 'serial' ? mid * mode.n : mid))
}

export function durationText(seconds: number): string {
  if (seconds < 60) return `${seconds} 秒`
  const minutes = Math.floor(seconds / 60)
  const rest = seconds % 60
  return rest === 0 ? `${minutes} 分` : `${minutes} 分 ${rest} 秒`
}

/** 串行多图的方案。
 *
 *  **N 步用的是同一句词**，不是「一套里每张各写各的」——那是「自动」档的事
 *  （走成套规划，AI 给每张写不同的词）。这里的价值在于后一张看得见前一张，
 *  适合同一个画面反复迭代，不适合「出十个不同的登录界面」。

    走 `runSetPlan` 的 consistent 语义：第 n 步把第 n-1 步的产物排在初始参考图
    **之前**，这就是「一套」保持一致的全部来源。每一步用同一句词——用户想让
    每张不一样的话该选「自动」，那条路上 AI 会替他把 N 句词写出来。 */
export function serialSetPlan(prompt: string, n: number, max: number): SetPlan {
  const total = Math.max(2, Math.min(Math.round(n), max))
  const body = prompt.trim()
  return {
    goal: `按同一句词串行出 ${total} 张`,
    intent: 'consistent',
    variables: [],
    rationale: '输入框选了「串行」：后一张带着前一张的产物做参考，整套保持一致。',
    steps: Array.from({ length: total }, (_, index) => ({
      id: `serial-${index + 1}`,
      title: `第 ${index + 1} 张`,
      prompt: body,
      dependsOn: index === 0 ? [] : [`serial-${index}`],
    })),
  }
}

/* ==================== 失败的单张 ==================== */

/** 一次点击拆出的 N 个单张任务共享 `execution_group_id`（`generateFrom` 就这么发的）。
    按它取「上一批」，而不是把这个节点历史上所有失败都摆出来——三天前那次失败
    永远挂在条上，用户既想不起来它是什么，也不会去点。 */
export function lastBatchFailures(items: StudioTask[]): StudioTask[] {
  const sorted = [...items].sort((a, b) => (b.created_at ?? '').localeCompare(a.created_at ?? ''))
  const newest = sorted[0]
  if (newest === undefined) return []
  const group = newest.execution_group_id
  const batch =
    group === null || group === undefined
      ? [newest]
      : sorted.filter((task) => task.execution_group_id === group)
  return batch.filter(
    (task) => task.retryable && ['failed', 'partial', 'cancelled'].includes(task.status),
  )
}

/** 最近几次单张出图的实测秒数，新的在前。

    只认 `succeeded`：失败的那次多半是几百毫秒就 4xx 回来了，掺进去会把估算
    压得离谱地低。 */
export function taskDurations(items: StudioTask[], limit = 6): number[] {
  const out: number[] = []
  const sorted = [...items].sort((a, b) => (b.created_at ?? '').localeCompare(a.created_at ?? ''))
  for (const task of sorted) {
    if (task.status !== 'succeeded' || task.started_at === null || task.finished_at === null) continue
    const seconds = (Date.parse(task.finished_at) - Date.parse(task.started_at)) / 1000
    if (!Number.isFinite(seconds) || seconds <= 0) continue
    out.push(Math.round(seconds))
    if (out.length >= limit) break
  }
  return out
}

/* ==================== 批量出图 ==================== */

/** 参与批量的一个候选节点。只带判定要用的三样，不依赖 canvasStore 的整个节点类型 */
export interface BulkCandidate {
  id: string
  type: string
  /** 这个节点这一次真正会用的提示词（上游拼好、批量草稿也应用过之后的） */
  prompt: string
  /** 已经在生成中。再发一次会被 `generateFrom` 静默丢掉，不如提前说清楚 */
  running: boolean
}

export interface BulkPlan {
  targets: string[]
  skipped: { id: string; reason: string }[]
}

/** 选中的一批节点里，哪些能出图、哪些不能以及为什么。

    分出 `skipped` 而不是直接过滤掉，是因为「选了 8 个只跑了 3 个」必须能解释：
    静默过滤的话用户只会觉得批量出图坏了。 */
export function bulkPlan(candidates: BulkCandidate[]): BulkPlan {
  const targets: string[] = []
  const skipped: { id: string; reason: string }[] = []
  for (const item of candidates) {
    if (item.type !== 'image') {
      skipped.push({ id: item.id, reason: '不是出图节点' })
      continue
    }
    if (item.running) {
      skipped.push({ id: item.id, reason: '正在生成中' })
      continue
    }
    if (item.prompt.trim() === '') {
      skipped.push({ id: item.id, reason: '没有提示词' })
      continue
    }
    targets.push(item.id)
  }
  return { targets, skipped }
}

/** 跳过原因归并成一句人话。按原因分组而不是逐个列 id——节点 id 是随机串，
    念给用户听没有任何意义，他要知道的是「为什么少跑了几个」。 */
export function skipSummary(skipped: { reason: string }[]): string {
  if (skipped.length === 0) return ''
  const byReason = new Map<string, number>()
  for (const item of skipped) byReason.set(item.reason, (byReason.get(item.reason) ?? 0) + 1)
  const parts = [...byReason].map(([reason, n]) => `${n} 个${reason}`)
  return `跳过 ${skipped.length} 个：${parts.join('、')}`
}

/** 「没有提示词」这条与其余跳过原因**不是一类**。

    实测过的场景：框选 11 个节点，界面显示「对选中的 0 个节点出图 · 跳过 11 个：
    10 个没有提示词、1 个不是出图节点」，主按钮「出图 · 0 个」灰着。看起来像坏了。
    但在正下方那个空输入框里打一句话，立刻变成「10 个」、按钮亮起——
    **那 10 个差的东西就在光标已经停着的地方**。

    把它和「不是出图节点」并列成「跳过」，等于把一个差一句话的状态说成了失败。
    所以这里分三堆：
      ready    —— 这一次真能跑的
      needWord —— 只差一句词，写了就能跑（要指向输入框，不叫跳过）
      excluded —— 真的不参与（类型不对、正在跑），这才叫跳过 */
export const NO_PROMPT_REASON = '没有提示词'

export interface BulkStatus {
  ready: number
  needWord: number
  excluded: { reason: string; count: number }[]
  /** 主状态一句话 */
  headline: string
  /** 补充说明；没有就是空串，界面上别留空行 */
  note: string
  /** 主按钮文案 */
  action: string
  canRun: boolean
}

export function bulkStatus(plan: BulkPlan): BulkStatus {
  const ready = plan.targets.length
  const needWord = plan.skipped.filter((s) => s.reason === NO_PROMPT_REASON).length
  const rest = new Map<string, number>()
  for (const item of plan.skipped) {
    if (item.reason === NO_PROMPT_REASON) continue
    rest.set(item.reason, (rest.get(item.reason) ?? 0) + 1)
  }
  const excluded = [...rest].map(([reason, count]) => ({ reason, count }))
  const excludedNote = excluded.map((e) => `${e.count} 个${e.reason}`).join('、')

  // 一个能跑的都没有、但差的只是词——这是最该说清楚的一种，别说成失败
  if (ready === 0 && needWord > 0) {
    return {
      ready, needWord, excluded,
      headline: `${needWord} 个节点还没有词`,
      note: excludedNote === '' ? '在下面写一句，它们就一起出' : `在下面写一句就能一起出；另有 ${excludedNote}`,
      action: `写一句词，出 ${needWord} 个`,
      canRun: false,
    }
  }
  if (ready === 0) {
    return {
      ready, needWord, excluded,
      headline: '选中的节点都不能出图',
      note: excludedNote,
      action: '出图',
      canRun: false,
    }
  }
  const tail: string[] = []
  if (needWord > 0) tail.push(`${needWord} 个还没有词，写一句就一起带上`)
  if (excludedNote !== '') tail.push(`跳过 ${excludedNote}`)
  return {
    ready, needWord, excluded,
    headline: `${ready} 个节点准备好了`,
    note: tail.join('；'),
    action: `出图 · ${ready} 个`,
    canRun: true,
  }
}

export interface BulkOutcome {
  id: string
  ok: boolean
  error?: string
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/** 带并发上限的批量执行。

    两条纪律：
    1. **一个失败不拖垮整批**——每个任务各自 try/catch，结果按 id 回报，
       调用方据此给「成 5 失 1」这种收尾，而不是整批 reject；
    2. **结果按入参顺序回**——用完成顺序的话，收尾里列出的失败节点顺序
       每次都不一样，对不上画布上的位置。

    `run` 本身通常不抛（`generateFrom` 内部已经吞了单张失败并各自 toast），
    这里的 catch 是防它真炸——一个节点的 store 异常不该让后面几个都不发出去。 */
export async function runBulk(
  ids: string[],
  run: (id: string) => Promise<void>,
  opts: { limit?: number; onProgress?: (done: number, total: number) => void } = {},
): Promise<BulkOutcome[]> {
  const total = ids.length
  const out: BulkOutcome[] = new Array<BulkOutcome>(total)
  if (total === 0) return out
  const limit = Math.max(1, Math.min(opts.limit ?? BULK_CONCURRENCY, total))
  let cursor = 0
  let done = 0

  const worker = async (): Promise<void> => {
    for (;;) {
      const index = cursor
      cursor += 1
      if (index >= total) return
      const id = ids[index]
      try {
        await run(id)
        out[index] = { id, ok: true }
      } catch (e) {
        out[index] = { id, ok: false, error: errText(e) }
      }
      done += 1
      opts.onProgress?.(done, total)
    }
  }

  await Promise.all(Array.from({ length: limit }, () => worker()))
  return out
}

/* ==================== 草稿拼接 ==================== */

/** 批量草稿怎么落到每个节点上 */
export type BulkDraftMode = 'append' | 'replace'

/** 追加一段文本。空串原样返回——「套了个空条目把草稿吃掉」比不生效更糟 */
export function appendDraft(base: string, add: string): string {
  const tail = add.trim()
  if (tail === '') return base
  return base === '' ? tail : `${base}\n${tail}`
}

/** 批量提交时某个节点最终会用的词。
 *
 *  批量草稿为空时一律退回「各自的词」，`replace` 也不例外：
 *  空输入框 + 替换 = 把选中节点的提示词全清空，那是个没人想要的操作，
 *  而它一次能毁掉十几个节点的草稿。 */
export function effectiveDraft(own: string, shared: string, mode: BulkDraftMode): string {
  if (shared.trim() === '') return own
  return mode === 'replace' ? shared.trim() : appendDraft(own, shared)
}

/* ==================== AI 扩写的原文 / 结果切换 ==================== */

/** 输入框里此刻显示的是哪一版。

    **由正文导出，不另存一个 `shown` 状态**：状态与正文各存一份，
    迟早会有一份是错的（用户手改一个字之后，状态还说「显示的是扩写后」，
    再点一次「扩写后」就把他刚改的字盖掉了）。
    返回 null = 两版都不是，说明用户已经在上面改过了——这时对比条该收起来，
    而不是留一个会吃掉他修改的切换按钮。 */
export function composeShown(
  text: string,
  trace: { before: string; after: string } | null,
): 'before' | 'after' | null {
  if (trace === null) return null
  if (text === trace.after) return 'after'
  if (text === trace.before) return 'before'
  return null
}

/* ==================== 最近用过的提示词 ==================== */

type MiniStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

/** 拿存储。**不入库**：最近提示词是本机顺手用的东西，
    同步到服务端只会多一张表和一条同步链路，换不来任何东西。 */
function pick(explicit?: MiniStorage): MiniStorage | null {
  if (explicit !== undefined) return explicit
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    // Safari 无痕模式读 localStorage 直接抛，不能让它把输入框整个带崩
    return null
  }
}

function normalizeList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  const out: string[] = []
  for (const item of raw) {
    if (typeof item !== 'string') continue
    const text = item.trim().slice(0, RECENT_ITEM_MAX)
    if (text === '' || out.includes(text)) continue
    out.push(text)
    if (out.length >= RECENT_MAX) break
  }
  return out
}

/** 读最近提示词。存的东西坏了就当空——这是个便利功能，
    不该因为一条脏数据让输入框打不开 */
export function recentLoad(storage?: MiniStorage): string[] {
  const store = pick(storage)
  if (store === null) return []
  try {
    return normalizeList(JSON.parse(store.getItem(RECENT_KEY) ?? '[]'))
  } catch {
    return []
  }
}

/** 记一条。同内容的旧记录会被顶到最前而不是留两份——
    重复出图的人一天能提交同一句词十几次，不去重的话列表里全是它。 */
export function recentPush(text: string, storage?: MiniStorage): string[] {
  const entry = text.trim().slice(0, RECENT_ITEM_MAX)
  const current = recentLoad(storage)
  if (entry === '') return current
  const next = [entry, ...current.filter((item) => item !== entry)].slice(0, RECENT_MAX)
  const store = pick(storage)
  if (store !== null) {
    try {
      store.setItem(RECENT_KEY, JSON.stringify(next))
    } catch {
      // 配额满了就算了，下拉少一条不影响出图
    }
  }
  return next
}

export function recentClear(storage?: MiniStorage): void {
  const store = pick(storage)
  if (store === null) return
  try {
    store.removeItem(RECENT_KEY)
  } catch {
    // 同上
  }
}

/** 下拉里显示的一行。整段提示词往往是几行长文，列表里只留一行 */
export function recentLabel(text: string, max = 42): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max)}…` : flat
}
