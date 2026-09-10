/* 循环节点的完整配置弹窗（模块 17 · FR-465）。

   蓝本 Infinite-Canvas 没有这个东西——它的循环全部塞在 340px 宽的节点卡片里，
   十二轮就是手写十二条提示词，而且写完之前看不出会发生什么。

   这里做三件蓝本没有的事：

   1. **按条编辑**轮次提示词（序号、增删、上下移、一键插 token），
      不是一个按行分割的 textarea；
   2. **逐轮预演**：右栏把每一轮实际会发的提示词摊开，占位符已替换、
      取第几条已标出、逐张喂图会取哪几张也标出。跑之前就能看见，
      而不是跑完十二轮才发现《计数》拼错了；
   3. **AI 一键配**：一句话生成整套配置（模式、轮数、每轮提示词），
      产出是草稿，落进表单让用户改。

   > [!warning] 预演必须与运行时同源
   >
   > 右栏调的是 `canvasStore.previewRounds`，它和 `roundPrompt` 共用同一行
   > `vars[(round-1) % vars.length]` 与同一个 `applyRoundVars`。
   > 另写一份算式的预演比没有预演更糟——用户会照着一份谎言调参数。 */

import { useCallback, useMemo, useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { ArrowDown, ArrowUp, Plus, Sparkles, X } from '@/components/NexusIcon'
import { toast } from 'sonner'

import { Overlay } from '../../components/Overlay'
import { apiStudio } from '../../lib/api-studio'
import {
  CASCADE_POOL_DEFAULT,
  CASCADE_POOL_MAX,
  LOOP_MAX,
  previewRounds,
  useCanvasStore,
} from './canvasStore'
import type { LoopMode, ScvNode } from './canvasStore'

import './loop-config.css'

/** 可插入的占位符。**必须与 `applyRoundVars` 支持的三个一致**——
 *  这里多列一个，用户插进去之后运行时不会替换，图上会出现《XX》四个字。 */
const TOKENS: Array<{ token: string; hint: string }> = [
  { token: '《计数》', hint: '当前第几轮。从「起始计数」开始数' },
  { token: '《总数》', hint: '一共几轮' },
  { token: '《进度》', hint: '第几轮/共几轮，例如 3/12' },
]

/** 轮数与批量的快捷档（蓝本 `loopNumberControlHtml` 的 quick 数组同款） */
const QUICK = [1, 2, 3, 4, 5, 6, 8, 10, 12, 20]

const MODE_COPY: Record<LoopMode, { label: string; tip: string }> = {
  serial: {
    label: '循环',
    tip: '一轮跑完再跑下一轮，后一轮能看到前一轮的产物。要**一致性**时用它：同一个角色的多个场景、同一套 UI 的多个页面、连续分镜。',
  },
  parallel: {
    label: '并发',
    tip: '所有轮同时开跑，互不影响，快得多。要**多样性**时用它：同一个需求的多个风格方案、多个配色、A/B 备选。',
  },
}

/** 把 `**加粗**` 渲染出来。说明句里就靠它把「一致性 / 多样性」两个词顶出来 */
function em(text: string): (string | JSX.Element)[] {
  return text
    .split(/(\*\*[^*]+\*\*)/g)
    .map((part, i) =>
      part.startsWith('**') && part.endsWith('**') ? <b key={i}>{part.slice(2, -2)}</b> : part,
    )
}

/** 编辑中的配置。和 `ScvNode` 的字段一一对应，保存时整份写回 */
interface Draft {
  title: string
  mode: LoopMode
  count: number
  loopStart: number
  prompts: string[]
  imageInput: boolean
  batch: number
  pool: number
}

function draftOf(node: ScvNode): Draft {
  const raw = node.variable_prompts ?? []
  return {
    title: node.title ?? '循环',
    mode: node.mode === 'parallel' ? 'parallel' : 'serial',
    count: Math.max(1, Math.min(node.count ?? 3, LOOP_MAX)),
    loopStart: Math.max(1, node.loop_start ?? 1),
    // 一条都没有时给一个空行：让用户直接看见输入框，而不是一片空白加一个「添加」按钮
    prompts: raw.length > 0 ? raw : [''],
    imageInput: node.image_input === true,
    batch: Math.max(1, node.image_batch_size ?? 1),
    pool: Math.max(1, Math.min(node.parallel_limit ?? CASCADE_POOL_DEFAULT, CASCADE_POOL_MAX)),
  }
}

export function LoopConfigDialog({
  nodeId,
  onClose,
}: {
  nodeId: string
  onClose: () => void
}): JSX.Element | null {
  const node = useCanvasStore((s) => s.nodes.find((n) => n.id === nodeId))
  const snapshot = useCanvasStore((s) => s.snapshot)
  const updateNode = useCanvasStore((s) => s.updateNode)

  /** 上游连着几张图、上游提示词是什么。预演与 AI 编排都要用。
   *
   *  **选择器必须吐一个字符串**，不能吐 `{images, prompt}`：zustand 按引用比较，
   *  每次都是新对象 = 每次都判定「变了」= 无限重渲染，直接
   *  `Maximum update depth exceeded`。同文件的 `planKey` 早就是这么写的，
   *  这条不是理论风险，是这个组件第一版真的崩在这里。 */
  const upstreamKey = useCanvasStore((s) => {
    let images = 0
    const texts: string[] = []
    for (const c of s.connections) {
      if (c.to !== nodeId) continue
      const from = s.nodes.find((n) => n.id === c.from)
      if (from === undefined) continue
      images += (from.items ?? []).filter((i) => i.kind === 'image').length
      const t = (from.text ?? from.prompt_draft ?? '').trim()
      if (t !== '') texts.push(t)
    }
    // \u0000 当分隔符：提示词里不可能出现，用换行会和多条提示词自己的换行混在一起
    return `${images}\u0000${texts.join('\n')}`
  })
  const upstream = useMemo(() => {
    const at = upstreamKey.indexOf('\u0000')
    return { images: Number(upstreamKey.slice(0, at)) || 0, prompt: upstreamKey.slice(at + 1) }
  }, [upstreamKey])

  const [draft, setDraft] = useState<Draft | null>(node === undefined ? null : draftOf(node))
  const [idea, setIdea] = useState('')
  const [why, setWhy] = useState('')
  /** 光标停在哪一条提示词上。点 token 按钮时插进这一条 */
  const [focused, setFocused] = useState(0)

  const patch = useCallback((v: Partial<Draft>) => setDraft((d) => (d === null ? d : { ...d, ...v })), [])

  const plan = useMutation({
    mutationFn: () =>
      apiStudio.planLoop({
        idea,
        upstream_images: upstream.images,
        upstream_prompt: upstream.prompt,
      }),
    onSuccess: (r) => {
      patch({
        title: r.title,
        mode: r.mode,
        count: r.count,
        loopStart: r.loop_start,
        prompts: r.variable_prompts.length > 0 ? r.variable_prompts : [''],
        imageInput: r.image_input,
        batch: r.image_batch_size,
      })
      setWhy(r.why)
      toast.success(`已生成 ${r.variable_prompts.length} 条轮次提示词，改完再保存`)
    },
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : '生成失败'),
  })

  const rows = useMemo(
    () =>
      draft === null
        ? []
        : previewRounds(
            {
              count: draft.count,
              loop_start: draft.loopStart,
              variable_prompts: draft.prompts,
              image_input: draft.imageInput,
              image_batch_size: draft.batch,
            },
            { upstreamImages: upstream.images },
          ),
    [draft, upstream.images],
  )

  if (node === undefined || draft === null) return null

  const save = (): void => {
    snapshot()
    updateNode(nodeId, {
      title: draft.title.trim() === '' ? '循环' : draft.title.trim(),
      mode: draft.mode,
      count: draft.count,
      loop_start: draft.loopStart,
      // 保存时丢掉纯空白条：它们在运行时本来就会被过滤，留在数据里只会让下次打开多出空行
      variable_prompts: draft.prompts.filter((p) => p.trim() !== ''),
      image_input: draft.imageInput,
      image_batch_size: draft.batch,
      parallel_limit: draft.pool,
    })
    toast.success('循环配置已保存')
    onClose()
  }

  const setPrompt = (i: number, v: string): void =>
    patch({ prompts: draft.prompts.map((p, k) => (k === i ? v : p)) })

  const movePrompt = (i: number, delta: number): void => {
    const to = i + delta
    if (to < 0 || to >= draft.prompts.length) return
    const next = [...draft.prompts]
    ;[next[i], next[to]] = [next[to], next[i]]
    patch({ prompts: next })
    setFocused(to)
  }

  const insertToken = (token: string): void => {
    const at = Math.min(focused, draft.prompts.length - 1)
    setPrompt(at, `${draft.prompts[at]}${token}`)
  }

  const totalGens = draft.count

  return (
    <Overlay onClose={onClose} card="lcfg-card" labelledBy="lcfg-title">
      <header className="lcfg-head">
        <div>
          <h3 id="lcfg-title">循环配置</h3>
          <p className="lcfg-sub">
            循环节点自己不出图，它让下游的出图节点跑 {draft.count} 轮
            {upstream.images > 0 ? ` · 上游有 ${upstream.images} 张图` : ' · 上游没有图片输入'}
          </p>
        </div>
        <button className="btn btn-ghost-sm" aria-label="关闭" onClick={onClose}>
          <X />
        </button>
      </header>

      <div className="lcfg-body">
        <div className="lcfg-form">
          {/* ── AI 一键配。放最上面：多数人是带着一句需求来的，不是带着一张参数表 ── */}
          <section className="lcfg-sec lcfg-ai">
            <span className="lcfg-label">
              <Sparkles /> 用一句话配好
            </span>
            <textarea
              className="lcfg-idea"
              rows={2}
              value={idea}
              placeholder="例如：给语聊房做 12 张不同风格的封面，每张主色调不一样"
              onChange={(e) => setIdea(e.target.value)}
            />
            <div className="lcfg-ai-act">
              <button
                className="btn btn-primary btn-sm"
                disabled={idea.trim() === '' || plan.isPending}
                onClick={() => plan.mutate()}
              >
                {plan.isPending ? '正在配…' : '生成配置'}
              </button>
              <span className="lcfg-note">
                只写配置不出图，生成完还能改，随便重来
              </span>
            </div>
            {why !== '' && <p className="lcfg-why">模型的理由：{why}</p>}
          </section>

          {/* ── 运行方式 ── */}
          <section className="lcfg-sec">
            <span className="lcfg-label">运行方式</span>
            <div className="lcfg-seg">
              {(['serial', 'parallel'] as LoopMode[]).map((m) => (
                <button
                  key={m}
                  className={draft.mode === m ? 'lcfg-seg-btn lcfg-seg-on' : 'lcfg-seg-btn'}
                  onClick={() => patch({ mode: m })}
                >
                  {MODE_COPY[m].label}
                </button>
              ))}
            </div>
            <p className="lcfg-tip">{em(MODE_COPY[draft.mode].tip)}</p>
            {draft.mode === 'parallel' && (
              <label className="lcfg-field">
                同时跑几轮
                <input
                  type="number"
                  min={1}
                  max={CASCADE_POOL_MAX}
                  value={draft.pool}
                  onChange={(e) =>
                    patch({ pool: Math.max(1, Math.min(Number(e.target.value) || 1, CASCADE_POOL_MAX)) })
                  }
                />
                <span className="lcfg-note">最大 {CASCADE_POOL_MAX}</span>
              </label>
            )}
          </section>

          {/* ── 轮次 ── */}
          <section className="lcfg-sec">
            <span className="lcfg-label">轮次</span>
            <div className="lcfg-nums">
              <label className="lcfg-field">
                轮数
                <input
                  type="number"
                  min={1}
                  max={LOOP_MAX}
                  value={draft.count}
                  onChange={(e) =>
                    patch({ count: Math.max(1, Math.min(Number(e.target.value) || 1, LOOP_MAX)) })
                  }
                />
              </label>
              <label className="lcfg-field">
                起始计数
                <input
                  type="number"
                  min={1}
                  max={LOOP_MAX}
                  value={draft.loopStart}
                  onChange={(e) => patch({ loopStart: Math.max(1, Number(e.target.value) || 1) })}
                />
                <span className="lcfg-note">《计数》从这个数开始</span>
              </label>
            </div>
            <div className="lcfg-quick">
              {QUICK.map((n) => (
                <button
                  key={n}
                  className={n === draft.count ? 'lcfg-chip lcfg-chip-on' : 'lcfg-chip'}
                  onClick={() => patch({ count: n })}
                >
                  {n}
                </button>
              ))}
            </div>
          </section>

          {/* ── 轮次提示词：按条编辑 ── */}
          <section className="lcfg-sec">
            <span className="lcfg-label">
              轮次提示词
              <em className="lcfg-count">{draft.prompts.filter((p) => p.trim() !== '').length} 条</em>
            </span>
            <p className="lcfg-tip">
              第 n 轮取第 n 条。条数少于轮数时会<b>循环取用</b>——想让每轮都不一样，
              条数就要等于轮数；想用一条模板跑很多轮，就只写一条并在里面写《计数》。
            </p>

            <ol className="lcfg-prompts">
              {draft.prompts.map((p, i) => (
                <li key={i} className={i === focused ? 'lcfg-prompt lcfg-prompt-on' : 'lcfg-prompt'}>
                  <span className="lcfg-idx">{i + 1}</span>
                  <textarea
                    rows={2}
                    value={p}
                    placeholder={i === 0 ? '这一轮要画什么' : ''}
                    onFocus={() => setFocused(i)}
                    onChange={(e) => setPrompt(i, e.target.value)}
                  />
                  <span className="lcfg-prompt-act">
                    <button
                      aria-label="上移"
                      title="上移"
                      disabled={i === 0}
                      onClick={() => movePrompt(i, -1)}
                    >
                      <ArrowUp />
                    </button>
                    <button
                      aria-label="下移"
                      title="下移"
                      disabled={i === draft.prompts.length - 1}
                      onClick={() => movePrompt(i, 1)}
                    >
                      <ArrowDown />
                    </button>
                    <button
                      aria-label="删除这条"
                      title="删除这条"
                      disabled={draft.prompts.length <= 1}
                      onClick={() => patch({ prompts: draft.prompts.filter((_, k) => k !== i) })}
                    >
                      <X />
                    </button>
                  </span>
                </li>
              ))}
            </ol>

            <div className="lcfg-prompt-tools">
              <button
                className="lcfg-chip"
                onClick={() => {
                  patch({ prompts: [...draft.prompts, ''] })
                  setFocused(draft.prompts.length)
                }}
              >
                <Plus /> 加一条
              </button>
              <span className="lcfg-tokens">
                {TOKENS.map((t) => (
                  <button key={t.token} className="lcfg-chip" title={t.hint} onClick={() => insertToken(t.token)}>
                    {t.token}
                  </button>
                ))}
              </span>
            </div>
          </section>

          {/* ── 逐张喂图 ── */}
          <section className="lcfg-sec">
            <label className="lcfg-check">
              <input
                type="checkbox"
                checked={draft.imageInput}
                onChange={(e) => patch({ imageInput: e.target.checked })}
              />
              逐张喂上游的图
            </label>
            <p className="lcfg-tip">
              {upstream.images > 0
                ? `上游有 ${upstream.images} 张图。开了之后每轮往后取几张，而不是每轮都把全部图一起送上去。`
                : '这个循环上游还没连图片节点。连上之后可以让每轮各用其中几张。'}
            </p>
            {draft.imageInput && (
              <>
                <label className="lcfg-field">
                  每轮取几张
                  <input
                    type="number"
                    min={1}
                    max={100}
                    value={draft.batch}
                    onChange={(e) => patch({ batch: Math.max(1, Math.min(Number(e.target.value) || 1, 100)) })}
                  />
                </label>
                <div className="lcfg-quick">
                  {[1, 2, 3, 4, 5, 6, 8, 10].map((n) => (
                    <button
                      key={n}
                      className={n === draft.batch ? 'lcfg-chip lcfg-chip-on' : 'lcfg-chip'}
                      onClick={() => patch({ batch: n })}
                    >
                      {n}
                    </button>
                  ))}
                </div>
              </>
            )}
          </section>
        </div>

        {/* ── 逐轮预演 ── */}
        <aside className="lcfg-preview">
          <div className="lcfg-preview-head">
            <span className="lcfg-label">跑起来会是这样</span>
            <span className="lcfg-note">
              共 {totalGens} 轮
              {rows.length < draft.count ? `，下面只列前 ${rows.length} 轮` : ''}
            </span>
          </div>
          <ol className="lcfg-rounds">
            {rows.map((r) => (
              <li key={r.round} className="lcfg-round">
                <div className="lcfg-round-head">
                  <b>第 {r.round} 轮</b>
                  {r.fromIndex > 0 && <em>用第 {r.fromIndex} 条</em>}
                  {r.imageSlots.length > 0 && <em>取图 {r.imageSlots.join('、')}</em>}
                </div>
                <p className={r.text.trim() === '' ? 'lcfg-round-text lcfg-round-empty' : 'lcfg-round-text'}>
                  {r.text.trim() === '' ? '（这一轮没有提示词，只会用节点自身的草稿）' : r.text}
                </p>
              </li>
            ))}
          </ol>
          {draft.count > rows.length && (
            <p className="lcfg-note lcfg-more">
              还有 {draft.count - rows.length} 轮，规律同上
            </p>
          )}
        </aside>
      </div>

      <footer className="lcfg-foot">
        <span className="lcfg-note">保存只改这个节点的配置，不会开始出图</span>
        <span className="lcfg-foot-act">
          <button className="btn btn-outline btn-sm" onClick={onClose}>
            取消
          </button>
          <button className="btn btn-primary btn-sm" onClick={save}>
            保存配置
          </button>
        </span>
      </footer>
    </Overlay>
  )
}
