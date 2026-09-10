/* 成套出图的配置弹窗（模块 17 · 需求见 `00.需求文档/.../成套出图节点.md`）。

   替换的是原来那个「循环节点」弹窗：它把 `轮数 / 起始计数 / 每轮张数 / 并发数`
   直接摊在界面上让用户填。那些参数用户不一定会配，配错了不报错，只出一批不对的图。

   这里改成四步，用户只说想要什么：

     需求 →  AI 反问（可点选、关掉能重开） →  实施方案（可手改、可让 AI 改） →  执行

   > [!warning] 参数不暴露，但可见
   >
   > 轮数、并发、每轮提示词这些**由方案推出来**，用户不填。
   > 但「看看底层怎么配的」一展开就能看到全部，且**只读**——
   > 要改就回方案层改。参数是方案的投影，不是另一处真相。

   > [!warning] 关掉一问 ≠ 答了这一问
   >
   > 提问卡片右上角的 × 是「先跳过」，那一问留在未答清单里可以重开
   > （抄 MCP elicitation 的 `cancel` 语义，它与 `decline` 是两回事）。
   > 混为一谈的话，用户手滑关掉一个窗口，AI 就当他弃权了。 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import {
  ArrowDown,
  ArrowUp,
  ChevronDown,
  MessageCircleQuestion,
  Plus,
  RotateCcw,
  Sparkles,
  X,
} from '@/components/NexusIcon'
import { toast } from 'sonner'

import { Overlay } from '../../components/Overlay'
import { apiConfig } from '../../lib/api-config'
import { apiStudio } from '../../lib/api-studio'
import type {
  CanvasItem,
  PlanStep,
  SetAnswer,
  SetAttachment,
  SetPlan,
  SetQuestion,
} from '../../lib/api-studio'
import { Picker } from '@/components/ui/picker'
import { AttachPreview, AttachStrip } from './CanvasAttachments'
import { LOOP_MAX, useCanvasStore } from './canvasStore'

import './set-plan.css'

/** 走到哪一步了。`ask` 与 `plan` 之间可以来回，不是单向流程 */
type Phase = 'idea' | 'ask' | 'plan'

/** 一句话讲清楚这个节点是干什么的。放在第一屏——
 *  用户第一次打开时最需要知道的是「它能替我做什么」，不是「有哪些参数」 */
const INTENT_COPY = {
  consistent: {
    label: '一致成套',
    hint: '一轮跟着一轮，上一轮的产物当下一轮的参考。一套登录流程、同一个角色的多个场景、连续分镜用它。',
  },
  varied: {
    label: '多样备选',
    hint: '所有方案同时开跑，互不影响。没灵感时用它——同一个需求给你几个完全不同的方向。',
  },
} as const

/** 一问的选项。**控件按选项自己的形态选**，不是所有题都长一个样：
 *
 *  | 形态 | 控件 | 为什么 |
 *  | --- | --- | --- |
 *  | 多选 | 药丸 chips | 多选要能同时亮好几个，单选那种整行高亮读起来像选错了 |
 *  | 单选 + 有说明 | 整行单选（圆点 + 标题 + 说明） | 说明要占一行，挤成卡片网格会把字压成两三行 |
 *  | 单选 + 短标签且无说明 | 分段控件 | 三四个短词并排一眼扫完，各占一行是浪费 |
 *
 *  这个分派抄的是 Claude Design 的问答卡：同一张卡上三种控件混排，
 *  信息密度差别很大但不显乱——形态差异本身就在说"这题跟上一题不一样"。 */
function Options({
  q,
  value,
  onPick,
}: {
  q: SetQuestion
  value: string | string[] | undefined
  onPick: (next: string | string[]) => void
}): JSX.Element {
  const hasHint = q.options.some((o) => o.hint !== '')
  const short = q.options.every((o) => o.label.length <= 8)

  if (q.type === 'multi') {
    const list = Array.isArray(value) ? value : []
    return (
      <div className="stp-pills">
        {q.options.map((o) => (
          <button
            key={o.value}
            className={list.includes(o.value) ? 'stp-pill stp-pill-on' : 'stp-pill'}
            title={o.hint}
            onClick={() =>
              onPick(
                list.includes(o.value) ? list.filter((v) => v !== o.value) : [...list, o.value],
              )
            }
          >
            {o.label}
          </button>
        ))}
      </div>
    )
  }

  if (!hasHint && short && q.options.length <= 4) {
    return (
      <div className="stp-seg stp-seg-wide">
        {q.options.map((o) => (
          <button
            key={o.value}
            className={value === o.value ? 'stp-seg-btn stp-seg-on' : 'stp-seg-btn'}
            onClick={() => onPick(o.value)}
          >
            {o.label}
          </button>
        ))}
      </div>
    )
  }

  return (
    <div className="stp-radios">
      {q.options.map((o) => (
        <button
          key={o.value}
          className={value === o.value ? 'stp-radio stp-radio-on' : 'stp-radio'}
          onClick={() => onPick(o.value)}
        >
          <span className="stp-radio-dot" aria-hidden />
          <span className="stp-radio-body">
            <b>{o.label}</b>
            {o.hint !== '' && <small>{o.hint}</small>}
          </span>
        </button>
      ))}
    </div>
  )
}

/** 「带上了什么」。
 *
 *  用户点"成套"时输入框里的一切都会跟着走：上游的图、这个节点自己的图、
 *  写了一半的提示词、挂着的文档。**不显示出来就等于没带**——用户无从判断
 *  AI 是不是看见了那份规范，只能靠出图结果去猜。
 *
 *  三类东西的去向不一样，所以分三行写清楚，而不是堆成一个"附件"列表：
 *  图真会作为参考图发出去，文档只被读正文，提示词进的是需求框。 */
function CarryPanel({
  refs,
  attachments,
  prompt,
}: {
  refs: number[]
  attachments: CanvasItem[]
  prompt: string
}): JSX.Element | null {
  const [preview, setPreview] = useState<CanvasItem | null>(null)
  const [openPrompt, setOpenPrompt] = useState(false)
  /* 图片附件已经在 refs 里了（refAssetIds 会收），这里只列非图附件，
     否则同一张图会在"参考图"和"附件"里各出现一次 */
  const files = attachments.filter((a) => a.kind !== 'image')
  if (refs.length === 0 && files.length === 0 && prompt.trim() === '') return null

  return (
    <section className="stp-carry">
      <div className="stp-carry-head">
        <b>带上了</b>
        <span className="stp-note">这些会跟着一起发过去，点开能看</span>
      </div>

      {refs.length > 0 && (
        <div className="stp-carry-row">
          <span className="stp-carry-tag">参考图 {refs.length} 张</span>
          <div className="stp-carry-thumbs">
            {refs.map((id, i) => (
              <button
                key={id}
                className="stp-carry-thumb"
                title="点开看大图"
                /* 给个名字，否则预览标题只会写「附件」——参考图是画布上的资产，
                   没有文件名，用序号让用户对得上是第几张 */
                onClick={() =>
                  setPreview({ kind: 'image', asset_id: id, name: `参考图 ${i + 1}` })
                }
              >
                <img src={`/api/images/assets/${id}/thumb`} alt="" />
              </button>
            ))}
          </div>
        </div>
      )}

      {files.length > 0 && (
        <div className="stp-carry-row">
          <span className="stp-carry-tag">文件 {files.length} 个</span>
          <AttachStrip items={files} compact />
        </div>
      )}

      {prompt.trim() !== '' && (
        <div className="stp-carry-row">
          <span className="stp-carry-tag">提示词</span>
          <button
            className={openPrompt ? 'stp-carry-prompt stp-carry-prompt-open' : 'stp-carry-prompt'}
            title={openPrompt ? '收起' : '展开看全文'}
            onClick={() => setOpenPrompt((v) => !v)}
          >
            {prompt}
          </button>
        </div>
      )}

      {preview !== null && <AttachPreview item={preview} onClose={() => setPreview(null)} />}
    </section>
  )
}

export function SetPlanDialog({
  nodeId,
  refs,
  autoStart = false,
  onClose,
  onRun,
}: {
  nodeId: string
  /** 当前会一并送上去的参考图。由生成条算好传进来——
   *  它本来就在算这个（生成条上那句「参考 N 张」），这里不该再算一遍 */
  refs: number[]
  /** 打开就直接开跑规划，不等用户再点一次「开始」。
   *
   *  输入框选「自动」时传真：需求那句话用户已经写在输入框里了，弹窗里
   *  原样显示着它、再要求点一次「开始」是纯多余的一步。
   *  **只自动到出方案为止**——方案仍然要摆出来让人看一眼再执行，
   *  一套十张是真金白银，不该替用户按下去。 */
  autoStart?: boolean
  onClose: () => void
  /** 确认执行。方案已经存在节点上，调用方负责开跑 */
  onRun: (plan: SetPlan) => void
}): JSX.Element | null {
  const node = useCanvasStore((s) => s.nodes.find((n) => n.id === nodeId))
  const snapshot = useCanvasStore((s) => s.snapshot)
  const updateNode = useCanvasStore((s) => s.updateNode)

  const upstreamImages = refs.length

  const [phase, setPhase] = useState<Phase>(() => (node?.set_plan === undefined ? 'idea' : 'plan'))
  /* 输入框里写了一半的提示词直接当需求初值：那本来就是用户描述这批图的原话，
     让他在这里再打一遍是纯粹的重复劳动。惰性初值而不是 effect——
     effect 会先渲染一帧空白，用户看得见那一下闪。 */
  const [idea, setIdea] = useState(() => node?.prompt_draft ?? '')
  const [alias, setAlias] = useState('explain-standard')
  const [questions, setQuestions] = useState<SetQuestion[]>([])
  /** 已经答过的。`cancel`（跳过）的**不进这里**，它们留在 questions 里可以重开 */
  const [answers, setAnswers] = useState<Map<string, string | string[]>>(new Map())
  /** 跳过的那些。单独记着，才能给出「还有 N 个问题没答，点这里继续」的入口 */
  const [skipped, setSkipped] = useState<Set<string>>(new Set())
  /* 打开时先载入节点上存着的方案：改到一半关掉、下次进来还在，
     而不是从头再问一遍。用惰性初值而不是 effect——effect 会先渲染一帧空白。 */
  const [plan, setPlan] = useState<SetPlan | null>(() => node?.set_plan ?? null)
  const [tweak, setTweak] = useState('')
  const [showRun, setShowRun] = useState(false)
  /** 问题列表末尾那句自由补充。抄的是 Claude Design 那个「你还有什么想问或要求的」——
   *  选项题问不到的东西（机构名、必须有的板块、要避开什么）都从这里进来 */
  const [note, setNote] = useState('')
  /** 问到第几轮了。用来给问题 id 加前缀，见 ask 的 onSuccess */
  const rounds = useRef(0)

  /* 输入框上挂的附件。**从节点上读**而不是当 props 传：
     弹窗开着时用户仍可能在底下的输入框里加减附件，传值会定格在打开那一刻 */
  const attachments = node?.attachments ?? []
  const carried = useMemo<SetAttachment[]>(
    () =>
      attachments.map((a) => ({
        kind: a.kind,
        name: a.name ?? '',
        media_asset_id: a.media_asset_id,
        asset_id: a.asset_id,
      })),
    [attachments],
  )

  /** 能用来做规划的模型。用户点名要「选调研的 AI」 */
  const models = useQuery({
    queryKey: ['cfg-model-deployments', 'set-plan'],
    queryFn: () => apiConfig.modelDeployments({ enabled: true }),
  })

  const answered = useMemo<SetAnswer[]>(
    () =>
      questions
        .filter((q) => answers.has(q.id))
        .map((q) => ({ id: q.id, title: q.title, answer: answers.get(q.id) ?? '' })),
    [questions, answers],
  )

  const ask = useMutation({
    mutationFn: (more: boolean = false) =>
      apiStudio.setAsk({
        idea,
        answered,
        upstream_images: upstreamImages,
        attachments: carried,
        note,
        more,
        // 已问未答的也回传：只发答过的话，它不知道自己问过什么
        asked: questions.filter((q) => !answers.has(q.id)).map((q) => q.title),
        alias,
      }),
    onSuccess: (r) => {
      if (r.enough || r.questions.length === 0) {
        // 没什么可问的了，直接出方案
        draft.mutate()
        return
      }
      /* 追加而不是替换：第二轮的问题接在第一轮后面，答过的还看得见。
         **入列时按轮次改写 id**——模型每轮都从 q1 编起，直接按 id 去重的话
         第二轮四个问题会被当成重复全部丢掉，界面上按了「再问我几个」
         什么都不发生（实测：接口 200、四个全新问题，一个都没显示出来）。
         id 是 answers / skipped 的索引键，所以必须在这一刻改写，之后全程用新的。 */
      setQuestions((prev) => {
        const round = prev.length === 0 ? 1 : rounds.current + 1
        rounds.current = round
        const seen = new Set(prev.map((p) => p.id))
        const next: SetQuestion[] = []
        for (const q of r.questions) {
          const id = `r${round}:${q.id}`
          // seen 边过滤边补：同一轮里模型给重了的话，两条会共用一个答案键
          if (seen.has(id)) continue
          seen.add(id)
          next.push({ ...q, id })
        }
        return [...prev, ...next]
      })
      setPhase('ask')
    },
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : '问不出来'),
  })

  const draft = useMutation({
    mutationFn: () =>
      apiStudio.setDraft({
        idea,
        answered,
        upstream_images: upstreamImages,
        attachments: carried,
        note,
        want: null,
        alias,
      }),
    onSuccess: (r) => {
      setPlan(r)
      setPhase('plan')
    },
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : '出方案失败'),
  })

  /** 局部改动。一档在服务端本地算完就回来，**不进模型**，所以是瞬时的 */
  const patch = useMutation({
    mutationFn: (ops: Record<string, unknown>[]) =>
      apiStudio.setPatch({ plan: plan as SetPlan, ops }),
    onSuccess: (r) => {
      if (r.tier === 1) {
        setPlan(r.plan)
        return
      }
      // 二档三档要回模型重排，交给 draft
      toast.info(r.tier === 3 ? '目标变了，重新规划一份' : '结构变了，重排一下步骤')
      draft.mutate()
    },
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : '改不动'),
  })

  const pending = ask.isPending || draft.isPending || patch.isPending

  /* 「自动」档打开时直接开跑规划。用 ref 守而不是靠依赖数组：
     `ask` 每次渲染都是新对象，进依赖会反复触发；而 StrictMode 下 effect 会跑两次，
     光判「有没有跑过」也不够（本仓记过 useRef 首帧守卫在 StrictMode 下失效那条），
     所以守的是「这一次开启有没有发过」，关掉再开是新的一次。 */
  const autoFired = useRef(false)
  useEffect(() => {
    if (!autoStart || autoFired.current) return
    if (phase !== 'idea' || idea.trim() === '' || pending) return
    autoFired.current = true
    ask.mutate(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoStart, phase, idea, pending])

  if (node === undefined) return null

  /* ---------- 方案的本地编辑 ---------- */

  const editStep = (id: string, patchStep: Partial<PlanStep>): void =>
    setPlan((p) =>
      p === null ? p : { ...p, steps: p.steps.map((s) => (s.id === id ? { ...s, ...patchStep } : s)) },
    )

  const moveStep = (index: number, delta: number): void =>
    setPlan((p) => {
      if (p === null) return p
      const to = index + delta
      if (to < 0 || to >= p.steps.length) return p
      const steps = [...p.steps]
      ;[steps[index], steps[to]] = [steps[to], steps[index]]
      return { ...p, steps }
    })

  /* 删一步走服务端的分档判据（`change_tier`），不在前端另写一套。
     两处各判一次的话迟早分叉——一边认为要重规划、一边认为不用。 */
  const removeStep = (id: string): void => {
    if (plan === null || plan.steps.length <= 1) return
    patch.mutate([{ op: 'removeStep', id }])
  }

  const addStep = (): void =>
    setPlan((p) =>
      p === null
        ? p
        : {
            ...p,
            steps: [
              ...p.steps,
              {
                id: `s${Date.now() % 100000}`,
                title: `第 ${p.steps.length + 1} 步`,
                prompt: '',
                dependsOn: p.intent === 'consistent' ? [p.steps[p.steps.length - 1]?.id ?? ''] : [],
              },
            ],
          },
    )

  /* ---------- 执行 ---------- */

  const run = (): void => {
    if (plan === null) return
    const consistent = plan.intent !== 'varied'
    snapshot()
    updateNode(nodeId, {
      title: plan.goal.slice(0, 20) || '成套',
      mode: consistent ? 'serial' : 'parallel',
      count: Math.max(1, Math.min(plan.steps.length, LOOP_MAX)),
      loop_start: 1,
      variable_prompts: plan.steps.map((s) => s.prompt),
      image_input: false,
      image_batch_size: 1,
      // 方案整份存在节点上：下次打开还能接着改，而不是从头再问一遍
      set_plan: plan,
    })
    toast.success(`按方案出 ${plan.steps.length} 张：${consistent ? '一致成套' : '多样备选'}`)
    onRun(plan)
    onClose()
  }

  const unanswered = questions.filter((q) => !answers.has(q.id))

  return (
    <Overlay onClose={onClose} card="stp-card" labelledBy="stp-title">
      <header className="stp-head">
        <div>
          <h3 id="stp-title">成套出图</h3>
          <p className="stp-sub">
            说清楚要什么，剩下的交给它：轮数、并发、每轮的词都由方案推出来，你不用填
          </p>
        </div>
        <button className="btn btn-ghost-sm" aria-label="关闭" onClick={onClose}>
          <X />
        </button>
      </header>

      <div className="stp-body">
        {/* ── 第一步：说需求 ── */}
        <section className="stp-sec">
          {/* 编号是真的：这三段就是一个先后顺序，跳着走会缺前提。
              不是为了装饰才给序号——那种编号读起来像模板 */}
          <h4 className="stp-h">
            <i className="stp-h-no">1</i>
            <Sparkles /> 你想要什么
          </h4>
          <textarea
            className="stp-idea"
            rows={3}
            value={idea}
            disabled={pending}
            placeholder="例如：做一套移动端登录界面，风格要统一 / 给这个封面来几个不同方向的方案"
            onChange={(e) => setIdea(e.target.value)}
          />
          <div className="stp-row">
            <label className="stp-field">
              让谁来规划
              <Picker
                size="sm"
                value={alias}
                disabled={pending}
                onChange={setAlias}
                options={[
                  { value: 'explain-standard', label: '默认（跟随全局）' },
                  ...(models.data ?? []).map((m) => ({
                    value: m.upstream_model_id,
                    label: m.display_name || m.upstream_model_id,
                  })),
                ]}
              />
            </label>
            <button
              className="btn btn-primary btn-sm"
              disabled={idea.trim() === '' || pending}
              onClick={() => ask.mutate(false)}
            >
              {ask.isPending ? '正在想要问什么…' : draft.isPending ? '正在出方案…' : '开始'}
            </button>
            <span className="stp-note">
              {upstreamImages > 0
                ? `会带上你选的 ${upstreamImages} 张参考图一起规划`
                : '没有参考图，完全按文字规划'}
            </span>
          </div>

          <CarryPanel refs={refs} attachments={attachments} prompt={node.prompt_draft ?? ''} />
        </section>

        {/* ── 第二步：AI 反问 ── */}
        {phase !== 'idea' && questions.length > 0 && (
          <section className="stp-sec">
            <h4 className="stp-h">
              <i className="stp-h-no">2</i>
              先确认几件事
              <em className="stp-count">
                {answered.length}/{questions.length} 已答
              </em>
            </h4>
            <ol className="stp-questions">
              {questions.map((q) => {
                const done = answers.has(q.id)
                const away = skipped.has(q.id)
                if (away && !done) {
                  return (
                    <li key={q.id} className="stp-q stp-q-skipped">
                      <span className="stp-q-title">{q.title}</span>
                      {/* 关掉的问题能重开——这正是 elicitation 里 cancel 与 decline 的区别 */}
                      <button
                        className="stp-chip"
                        onClick={() => setSkipped((p) => new Set([...p].filter((x) => x !== q.id)))}
                      >
                        <RotateCcw /> 重新回答
                      </button>
                    </li>
                  )
                }
                return (
                  <li key={q.id} className={done ? 'stp-q stp-q-done' : 'stp-q'}>
                    <div className="stp-q-head">
                      <span className="stp-q-title">{q.title}</span>
                      <button
                        className="stp-q-skip"
                        aria-label="先跳过这一问"
                        title="先跳过。之后还能回来答"
                        onClick={() => setSkipped((p) => new Set(p).add(q.id))}
                      >
                        <X />
                      </button>
                    </div>
                    {q.hint !== '' && <p className="stp-note">{q.hint}</p>}

                    {q.type === 'text' ? (
                      <input
                        className="stp-text"
                        value={String(answers.get(q.id) ?? '')}
                        placeholder={q.placeholder}
                        onChange={(e) =>
                          setAnswers((p) => new Map(p).set(q.id, e.target.value))
                        }
                      />
                    ) : (
                      <Options
                        q={q}
                        value={answers.get(q.id)}
                        onPick={(next) => setAnswers((p) => new Map(p).set(q.id, next))}
                      />
                    )}
                  </li>
                )
              })}
            </ol>

            {/* 选项题问不到的东西从这里进来。
                固定放在问题列表末尾——选项永远盖不全，没有这一格的话
                用户想说"机构名叫临江市"只能塞回上面的需求框重来一轮。 */}
            <div className="stp-more">
              <label className="stp-more-label" htmlFor="stp-note">
                你还有什么想问或要求的？
              </label>
              <p className="stp-note">上面几个选项没覆盖到的都写这儿，比如必须有的板块、要避开什么</p>
              <input
                id="stp-note"
                className="stp-text"
                value={note}
                placeholder="例如：机构名是临江市民政局 / 别用蓝色 / 参考 xx 网站的信息密度"
                onChange={(e) => setNote(e.target.value)}
              />
              <div className="stp-row">
                <button
                  className="btn btn-primary btn-sm"
                  disabled={pending}
                  onClick={() => draft.mutate()}
                >
                  {draft.isPending ? '正在出方案…' : '按这些出方案'}
                </button>
                {/* 再问一轮。服务端在这一轮不许回"够了"，否则按了没反应像坏了 */}
                <button
                  className="btn btn-outline btn-sm"
                  disabled={pending}
                  onClick={() => ask.mutate(true)}
                >
                  <MessageCircleQuestion /> {ask.isPending ? '正在想…' : '再问我几个'}
                </button>
                <button
                  className="stp-chip"
                  disabled={pending}
                  title="剩下的都由它自己判断"
                  onClick={() => draft.mutate()}
                >
                  你来定
                </button>
              </div>
              {unanswered.length > 0 && (
                <span className="stp-note">
                  还有 {unanswered.length} 个没答，不答也能出——没说的地方由它自己发挥
                </span>
              )}
            </div>
          </section>
        )}

        {/* ── 第三步：实施方案 ── */}
        {plan !== null && (
          <section className="stp-sec">
            <h4 className="stp-h">
              <i className="stp-h-no">3</i>
              实施方案
              <em className="stp-count">{plan.steps.length} 步</em>
            </h4>

            <div className="stp-plan-head">
              <div className="stp-seg">
                {(['consistent', 'varied'] as const).map((k) => (
                  <button
                    key={k}
                    className={plan.intent === k ? 'stp-seg-btn stp-seg-on' : 'stp-seg-btn'}
                    onClick={() => setPlan((p) => (p === null ? p : { ...p, intent: k }))}
                  >
                    {INTENT_COPY[k].label}
                  </button>
                ))}
              </div>
              <p className="stp-note">{INTENT_COPY[plan.intent].hint}</p>
            </div>

            {plan.rationale !== '' && <p className="stp-why">它的理由：{plan.rationale}</p>}

            <ol className="stp-steps">
              {plan.steps.map((s, i) => (
                <li key={s.id} className="stp-step">
                  <span className="stp-step-no">{i + 1}</span>
                  <div className="stp-step-body">
                    <input
                      className="stp-step-title"
                      value={s.title}
                      onChange={(e) => editStep(s.id, { title: e.target.value })}
                    />
                    <textarea
                      className="stp-step-prompt"
                      rows={2}
                      value={s.prompt}
                      placeholder="这一步实际发给模型的提示词"
                      onChange={(e) => editStep(s.id, { prompt: e.target.value })}
                    />
                  </div>
                  <span className="stp-step-act">
                    <button aria-label="上移" title="上移" disabled={i === 0} onClick={() => moveStep(i, -1)}>
                      <ArrowUp />
                    </button>
                    <button
                      aria-label="下移"
                      title="下移"
                      disabled={i === plan.steps.length - 1}
                      onClick={() => moveStep(i, 1)}
                    >
                      <ArrowDown />
                    </button>
                    <button
                      aria-label="删掉这一步"
                      title="删掉这一步"
                      disabled={plan.steps.length <= 1}
                      onClick={() => removeStep(s.id)}
                    >
                      <X />
                    </button>
                  </span>
                </li>
              ))}
            </ol>

            <div className="stp-row">
              <button className="stp-chip" onClick={addStep}>
                <Plus /> 加一步
              </button>
              <span className="stp-note">
                改张数只改这里的步数，<b>不会重新规划</b>——加一步就多一张图
              </span>
            </div>

            {/* 跟 AI 说改哪里 */}
            <div className="stp-tweak">
              <input
                className="stp-text"
                value={tweak}
                placeholder="想让它改哪里？例如：第 3 步太素了，加点氛围"
                onChange={(e) => setTweak(e.target.value)}
              />
              <button
                className="btn btn-outline btn-sm"
                disabled={tweak.trim() === '' || pending}
                onClick={() => {
                  setIdea((prev) => `${prev}\n补充要求：${tweak.trim()}`)
                  setTweak('')
                  draft.mutate()
                }}
              >
                让它改
              </button>
            </div>

            {/* 底层参数：默认收起，展开也**只读** */}
            <div className="stp-run">
              <button
                className="stp-run-toggle"
                aria-expanded={showRun}
                onClick={() => setShowRun((v) => !v)}
              >
                看看底层怎么配的
                <ChevronDown className={showRun ? 'stp-chev stp-chev-open' : 'stp-chev'} />
              </button>
              {showRun && (
                <dl className="stp-run-list">
                  <div>
                    <dt>运行方式</dt>
                    <dd>{plan.intent === 'varied' ? '并发（各步同时跑）' : '串行（一步跟一步）'}</dd>
                  </div>
                  <div>
                    <dt>轮数</dt>
                    <dd>{plan.steps.length}</dd>
                  </div>
                  <div>
                    <dt>每轮提示词</dt>
                    <dd>按上面的步骤逐条取</dd>
                  </div>
                  <div>
                    <dt>预计出图</dt>
                    <dd>{plan.steps.length} 次</dd>
                  </div>
                </dl>
              )}
              {showRun && (
                <p className="stp-note">
                  这些是<b>方案推出来的</b>，只读。要改就改上面的步骤——
                  参数是方案的投影，不是另一处真相。
                </p>
              )}
            </div>
          </section>
        )}
      </div>

      <footer className="stp-foot">
        <span className="stp-note">
          {plan === null ? '还没出方案' : `确认后立刻出 ${plan.steps.length} 张，逐张落在画布上`}
        </span>
        <span className="stp-foot-act">
          <button className="btn btn-outline btn-sm" onClick={onClose}>
            取消
          </button>
          <button className="btn btn-primary btn-sm" disabled={plan === null} onClick={run}>
            {plan === null ? '出图' : `出这 ${plan.steps.length} 张`}
          </button>
        </span>
      </footer>
    </Overlay>
  )
}
