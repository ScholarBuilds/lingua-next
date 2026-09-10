import { Picker } from '@/components/ui/picker'

/* 批量策划台（模块 16 FR-437 / FR-439）。

   一句话 → LLM 拆成若干子任务 → 逐条改 → 一起执行。拆解阶段只调文本模型，
   不出图，所以「AI 策划」这一步不花生图的钱，按钮上直接写明。

   底部合计（共 N 个任务 / M 张图 / 档位分布）是执行前唯一能看到总量的地方。
   批量的钱是一次性花掉的，没有合计就点执行不可接受（FR-439）。 */

import { useMutation } from '@tanstack/react-query'
import { ImagePlus, Plus, Sparkles, Trash2, X } from '@/components/NexusIcon'
import type { ChangeEvent } from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'

import { Overlay } from '@/components/Overlay'
import type { BatchTask, ImageApp, RatioOption } from '@/lib/api-image'
import { apiImage } from '@/lib/api-image'

import './BatchPlanner.css'

/** 卡片行 = 子任务 + 一个稳定的本地 id，用来做导航定位与 React key */
interface TaskRow extends BatchTask {
  rid: string
}

/** 服务端 `BatchRunBody.tasks` 的上限 */
const MAX_TASKS = 20
/** 单条最多几张，与服务端 `image_batch.MAX_N` 一致 */
const MAX_N = 4
/** 拆解阶段服务端封顶 12 条，选项别给到用户拿不到的数 */
const PLAN_CHOICES = [3, 4, 6, 8, 10, 12]

function clampN(value: number): number {
  if (!Number.isFinite(value)) return 1
  return Math.min(MAX_N, Math.max(1, Math.round(value)))
}

export function BatchPlanner({
  appKey,
  apps,
  ratios,
  tiers,
  onClose,
  onRun,
}: {
  appKey: string
  apps: ImageApp[]
  ratios: RatioOption[]
  tiers: { key: string; label: string }[]
  onClose: () => void
  onRun: (tasks: BatchTask[]) => Promise<void> | void
}) {
  const app = useMemo(() => apps.find((a) => a.key === appKey) ?? null, [apps, appKey])
  const ratioMap = useMemo(() => new Map(ratios.map((r) => [r.key, r])), [ratios])

  // 应用锁了比例就全批跟着锁——注册表把它当成这个应用能不能用的分水岭，不是偏好
  const lockedRatio = app?.ratio && ratioMap.has(app.ratio) ? app.ratio : null
  const firstRatio = lockedRatio ?? ratios[0]?.key ?? '1:1'
  const firstTier = tiers.some((t) => t.key === '1k') ? '1k' : (tiers[0]?.key ?? '1k')

  const [idea, setIdea] = useState('')
  const [maxTasks, setMaxTasks] = useState(6)
  const [tasks, setTasks] = useState<TaskRow[]>([])
  const [globalRatio, setGlobalRatio] = useState(firstRatio)
  const [globalTier, setGlobalTier] = useState(firstTier)
  const [active, setActive] = useState<string | null>(null)
  const [running, setRunning] = useState(false)
  const [reference, setReference] = useState<{ url: string; name: string } | null>(null)

  const seq = useRef(0)
  const cardRefs = useRef(new Map<string, HTMLDivElement>())

  // 换图与卸载时都要放掉 blob URL，否则整场会话攒一堆
  useEffect(
    () => () => {
      if (reference) URL.revokeObjectURL(reference.url)
    },
    [reference],
  )

  function nextId(): string {
    seq.current += 1
    return `row-${seq.current}`
  }

  function ratioLabel(key: string): string {
    return ratioMap.get(key)?.label ?? key
  }

  /** 标定过就显示实测尺寸，没标定才显示我们请求的那个数（FR-432） */
  function sizeOf(ratioKey: string, tier: string): string {
    const ratio = ratioMap.get(ratioKey)
    if (!ratio) return ''
    return ratio.measured[tier] ?? ratio.sizes[tier] ?? ''
  }

  /** 模型给的比例/档位不一定在本地目录里，收下时统一归一化 */
  function adopt(task: BatchTask): TaskRow {
    return {
      rid: nextId(),
      label: task.label,
      prompt_zh: task.prompt_zh,
      ratio: lockedRatio ?? (ratioMap.has(task.ratio) ? task.ratio : globalRatio),
      tier: tiers.some((t) => t.key === task.tier) ? task.tier : globalTier,
      n: clampN(task.n),
    }
  }

  const plan = useMutation({
    mutationFn: () =>
      apiImage.planBatch({ idea: idea.trim(), app_key: appKey, max_tasks: maxTasks }),
    onSuccess: (data) => {
      const rows = data.tasks.slice(0, MAX_TASKS).map(adopt)
      setTasks(rows)
      setActive(rows[0]?.rid ?? null)
      if (rows.length === 0) toast.error('模型没拆出子任务，把想法写具体一些再试')
    },
    onError: (e: Error) => toast.error(e.message),
  })

  const describe = useMutation({
    mutationFn: (file: File) => {
      const form = new FormData()
      form.append('image', file)
      form.append('mode', 'recreate')
      return apiImage.describe(form)
    },
    onSuccess: (result) => {
      setIdea((prev) =>
        prev.trim() === '' ? result.zh : `${prev.trim()}\n参考图画面：${result.zh}`,
      )
      toast.success('参考图已反推成中文描述，并入想法')
    },
    onError: (e: Error) => toast.error(e.message),
  })

  function pickReference(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = '' // 同一张图再选一次也要能触发
    if (!file) return
    setReference({ url: URL.createObjectURL(file), name: file.name })
    describe.mutate(file)
  }

  function jump(rid: string) {
    setActive(rid)
    // 内嵌浏览器面板会整个吞掉 smooth 滚动，这里显式用 auto
    cardRefs.current.get(rid)?.scrollIntoView({ behavior: 'auto', block: 'nearest' })
  }

  function addTask() {
    if (tasks.length >= MAX_TASKS) {
      toast.error(`一批最多 ${MAX_TASKS} 个任务`)
      return
    }
    const row: TaskRow = {
      rid: nextId(),
      label: '',
      prompt_zh: '',
      ratio: globalRatio,
      tier: globalTier,
      n: 1,
    }
    setTasks((prev) => [...prev, row])
    setActive(row.rid)
    window.setTimeout(() => jump(row.rid), 0) // 等卡片挂载后再滚过去
  }

  function patchTask(rid: string, patch: Partial<BatchTask>) {
    setTasks((prev) => prev.map((t) => (t.rid === rid ? { ...t, ...patch } : t)))
  }

  function removeTask(rid: string) {
    cardRefs.current.delete(rid)
    setTasks((prev) => prev.filter((t) => t.rid !== rid))
  }

  function applyGlobal() {
    if (tasks.length === 0) return
    setTasks((prev) => prev.map((t) => ({ ...t, ratio: globalRatio, tier: globalTier })))
    toast.success(
      `已把 ${ratioLabel(globalRatio)} · ${globalTier.toUpperCase()} 应用到 ${tasks.length} 条`,
    )
  }

  const totals = useMemo(() => {
    let images = 0
    const byTier = new Map<string, number>()
    for (const task of tasks) {
      images += task.n
      byTier.set(task.tier, (byTier.get(task.tier) ?? 0) + task.n)
    }
    return { images, byTier: [...byTier.entries()] }
  }, [tasks])

  const blanks = tasks.filter((t) => t.prompt_zh.trim() === '').length
  const drifted = tasks.filter((t) => t.ratio !== globalRatio || t.tier !== globalTier).length
  const canRun = tasks.length > 0 && blanks === 0 && !running

  async function run() {
    if (!canRun) return
    setRunning(true)
    try {
      await onRun(
        tasks.map((t) => ({
          label: t.label.trim(),
          prompt_zh: t.prompt_zh.trim(),
          ratio: t.ratio,
          tier: t.tier,
          n: t.n,
        })),
      )
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '批量执行失败')
    } finally {
      setRunning(false)
    }
  }

  return (
    <Overlay onClose={onClose} card="bp-modal" dismissable={!running} labelledBy="bp-title">
      <header className="bp-head">
        <b id="bp-title" className="bp-title">
          批量策划台
        </b>
        <span className="chip accent">{app?.label ?? appKey}</span>
        <span className="bp-head-hint">{app?.hint ?? ''}</span>
        <button className="icon-btn" onClick={onClose} disabled={running} title="关闭">
          <X size={17} />
        </button>
      </header>

      <div className="bp-body">
        <aside className="bp-side">
          <div className="bp-side-block">
            <div className="bp-side-title">全局参数</div>
            <label className="bp-field">
              <span>比例</span>
              <Picker
                size="sm"
                className="field-select"
                value={globalRatio}
                disabled={lockedRatio !== null}
                onChange={setGlobalRatio}
                options={ratios.map((r) => ({ value: r.key, label: r.label }))}
              />
            </label>
            {lockedRatio !== null && <p className="bp-note">该应用锁定比例，逐条不可改</p>}
            <label className="bp-field">
              <span>档位</span>
              <Picker
                size="sm"
                className="field-select"
                value={globalTier}
                onChange={setGlobalTier}
                options={tiers.map((t) => ({ value: t.key, label: t.label }))}
              />
            </label>
            {sizeOf(globalRatio, globalTier) !== '' && (
              <p className="bp-note bp-mono">{sizeOf(globalRatio, globalTier)}</p>
            )}
            <button
              className={drifted > 0 ? 'btn btn-soft btn-sm' : 'btn btn-outline btn-sm'}
              onClick={applyGlobal}
              disabled={tasks.length === 0}
            >
              应用到全部子任务{drifted > 0 ? `（${drifted} 条不一致）` : ''}
            </button>
          </div>

          <div className="bp-side-title bp-nav-title">任务导航 · {tasks.length}</div>
          <nav className="bp-nav">
            {tasks.length === 0 && <p className="bp-note">还没有子任务</p>}
            {tasks.map((task, i) => (
              <button
                key={task.rid}
                className={`bp-nav-item${active === task.rid ? ' on' : ''}`}
                onClick={() => jump(task.rid)}
              >
                <span className="bp-idx">{i + 1}</span>
                <span className="bp-nav-text">
                  <span className="bp-nav-label">
                    {task.label.trim() === '' ? `子任务 ${i + 1}` : task.label}
                  </span>
                  <span className="bp-nav-meta">
                    {ratioLabel(task.ratio)} · {task.tier.toUpperCase()} · {task.n} 张
                  </span>
                </span>
                {task.prompt_zh.trim() === '' && <span className="bp-nav-warn">空</span>}
              </button>
            ))}
          </nav>
        </aside>

        <section className="bp-main">
          <div className="bp-idea">
            <div className="bp-idea-col">
              <label className="bp-field">
                <span>原始想法</span>
                <textarea
                  className="field-textarea"
                  value={idea}
                  placeholder="一句话说清这批图要什么，例如：给咖啡馆场景课配一组插图，覆盖点单、取餐、靠窗座位"
                  maxLength={800}
                  onChange={(e) => setIdea(e.target.value)}
                />
              </label>
              <div className="bp-idea-bar">
                <Picker
                  size="sm"
                  className="field-select bp-plan-n"
                  value={String(maxTasks)}
                  onChange={(v) => setMaxTasks(Number(v))}
                  options={PLAN_CHOICES.map((n) => ({ value: String(n), label: `最多 ${n} 条` }))}
                />
                <button
                  className="btn btn-primary"
                  onClick={() => plan.mutate()}
                  disabled={idea.trim() === '' || plan.isPending || running}
                >
                  <Sparkles size={16} />
                  {plan.isPending
                    ? '策划中…'
                    : tasks.length > 0
                      ? 'AI 重新策划（只改方案，不出图）'
                      : 'AI 策划（只写方案，不出图）'}
                </button>
                {tasks.length > 0 && (
                  <span className="bp-note">重新策划会替换当前 {tasks.length} 条</span>
                )}
              </div>
            </div>

            <div className="bp-ref">
              <div className="bp-ref-box">
                {reference ? (
                  <img src={reference.url} alt={reference.name} />
                ) : (
                  <ImagePlus size={20} />
                )}
              </div>
              <label className="btn btn-outline btn-sm">
                <input type="file" accept="image/*" hidden onChange={pickReference} />
                {reference ? '换参考图' : '加参考图'}
              </label>
              <p className="bp-note">
                {describe.isPending
                  ? '反推中…'
                  : '参考图只用来反推中文画面描述并入想法，走视觉模型，比出图便宜'}
              </p>
            </div>
          </div>

          <div className="bp-tasks">
            {tasks.length === 0 && (
              <div className="bp-empty">
                <p>还没有子任务。</p>
                <p className="bp-note">
                  写一句想法让 AI 拆成方案，或者直接手动添加——这一步只写方案，不出图。
                </p>
              </div>
            )}

            {tasks.map((task, i) => (
              <div
                key={task.rid}
                ref={(el) => {
                  if (el) cardRefs.current.set(task.rid, el)
                  else cardRefs.current.delete(task.rid)
                }}
                className={`bp-card${active === task.rid ? ' on' : ''}${
                  task.prompt_zh.trim() === '' ? ' blank' : ''
                }`}
                onFocus={() => setActive(task.rid)}
              >
                <div className="bp-card-head">
                  <span className="bp-idx">{i + 1}</span>
                  <input
                    className="field-input bp-label"
                    value={task.label}
                    placeholder={`子任务 ${i + 1} 的短名`}
                    maxLength={40}
                    onChange={(e) => patchTask(task.rid, { label: e.target.value })}
                  />
                  <button
                    className="icon-btn"
                    onClick={() => removeTask(task.rid)}
                    disabled={running}
                    title="删除这条"
                  >
                    <Trash2 size={16} />
                  </button>
                </div>

                <textarea
                  className="field-textarea bp-prompt"
                  value={task.prompt_zh}
                  placeholder="中文画面描述：写具体可见的东西（主体、环境、视角）"
                  maxLength={2000}
                  onChange={(e) => patchTask(task.rid, { prompt_zh: e.target.value })}
                />

                <div className="bp-card-row">
                  <Picker
                    size="sm"
                    className="field-select"
                    value={task.ratio}
                    disabled={lockedRatio !== null}
                    onChange={(v) => patchTask(task.rid, { ratio: v })}
                    options={ratios.map((r) => ({ value: r.key, label: r.label }))}
                  />
                  <Picker
                    size="sm"
                    className="field-select"
                    value={task.tier}
                    title={tiers.find((t) => t.key === task.tier)?.label ?? task.tier}
                    onChange={(v) => patchTask(task.rid, { tier: v })}
                    options={tiers.map((t) => ({ value: t.key, label: t.label }))}
                  />
                  <label className="bp-n">
                    <span>张数</span>
                    <input
                      className="field-input"
                      type="number"
                      min={1}
                      max={MAX_N}
                      value={task.n}
                      onChange={(e) => patchTask(task.rid, { n: clampN(Number(e.target.value)) })}
                    />
                  </label>
                  {sizeOf(task.ratio, task.tier) !== '' && (
                    <span className="bp-mono bp-note">{sizeOf(task.ratio, task.tier)}</span>
                  )}
                </div>
              </div>
            ))}

            <button className="btn btn-outline bp-add" onClick={addTask} disabled={running}>
              <Plus size={16} />
              添加子任务
            </button>
          </div>
        </section>
      </div>

      <footer className="bp-foot">
        <div className="bp-sum">
          <div className="bp-sum-line">
            共 <b>{tasks.length}</b> 个任务 · 共 <b>{totals.images}</b> 张图 · 档位{' '}
            {totals.byTier.length === 0 && '—'}
            {totals.byTier.map(([key, n], i) => (
              <span key={key} className={key === '1k' ? undefined : 'bp-hot'}>
                {i > 0 ? ' / ' : ''}
                {key.toUpperCase()} {n} 张
              </span>
            ))}
          </div>
          <div className="bp-note">
            {blanks > 0
              ? `${blanks} 条还没写画面描述，补完才能执行`
              : '执行后逐条入队，开始真正出图；上面的策划阶段只写方案。'}
          </div>
        </div>
        <button className="btn btn-outline" onClick={onClose} disabled={running}>
          取消
        </button>
        <button className="btn btn-primary btn-lg" onClick={() => void run()} disabled={!canRun}>
          {running
            ? `正在入队 ${tasks.length} 个任务…`
            : `执行 ${tasks.length} 个任务 · ${totals.images} 张图`}
        </button>
      </footer>
    </Overlay>
  )
}
