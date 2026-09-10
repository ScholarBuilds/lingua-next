/* 创作台（模块 16 · 生图控制台第五轮，FR-446 / FR-447）。

   四轮时这里叫「提示词工作台」，只管中文意图与英文提示词两栏。真正的问题在它外面：
   画风在侧栏另一个弹窗里选，而**画风一变提示词就得重写**——因果被两个弹窗切断，
   用户改了画风、界面显示新画风、出来的图还是旧的，从界面上找不出原因。

   所以画风搬进来了。左栏是「你给的两个输入」（意图 + 画风），中栏是「由它们推出的
   产物」（英文提示词），因果关系一眼可见，改哪边会影响什么也不用猜。

   中栏底下常驻中文解读：出图之前先看懂这段英文要画什么，尤其是 missing 那一段——
   把中文意图和最终提示词逐条比对，列出「你说了但提示词里没有」的要点。
   这件事光看英文提示词看不出来，而它恰恰决定了出来的图为什么不是你想要的那张。

   右栏是对话改词：用中文说「再暗一点」「加点雾」，AI 直接改出新的英文提示词并说清
   改了什么。它和 AI 补细节的区别是**有来有回**——补细节是一次性加厚，对话能持续收敛。

   不提供自动优化开关（模块 16 已否掉的做法）：静默改写输入之后，「改了词但出图
   没变」就无法归因。改写只在显式操作时发生。 */

import {
  ArrowRight,
  Ban,
  Braces,
  Check,
  ChevronRight,
  Copy,
  CornerDownLeft,
  Crop,
  Eraser,
  Languages,
  Lightbulb,
  ListTree,
  LoaderCircle,
  MessageSquare,
  Palette,
  PenLine,
  ScanText,
  TriangleAlert,
  Wand2,
  WandSparkles,
  X,
} from '@/components/NexusIcon'
import { useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import type { ChatTurn, PromptExplain, StylePreset } from '@/lib/api-image'

import type { PromptState } from './consoleStore'
import './PromptStudio.css'

/** 七段式的字段顺序与中文名。顺序固定，缺哪段就显式标出来，不静默省略 */
const SEGMENTS: { key: string; label: string; hint: string }[] = [
  { key: 'type', label: '类型', hint: '这张图属于哪一类' },
  { key: 'goal', label: '立意', hint: '要让人一眼看懂的那件事' },
  { key: 'subject', label: '主体', hint: '画面中心是什么' },
  { key: 'scene', label: '场景', hint: '环境、时间、氛围' },
  { key: 'layout', label: '构图', hint: '画布比例与元素位置' },
  { key: 'style', label: '画风', hint: '渲染、配色、材质' },
  { key: 'constraints', label: '约束', hint: '不要出现什么' },
]

const SEGMENT_KEYS = new Set(SEGMENTS.map((s) => s.key))

/** 提示词框的 DOM id。两段式 Esc 要拿到这个元素判断焦点在不在框里 */
const PROMPT_BOX_ID = 'pstu-prompt-box'
const IDEA_BOX_ID = 'pstu-idea-box'
const CHAT_BOX_ID = 'pstu-chat-box'

/** 结构里的值形态不固定（字符串 / 数组 / 嵌套对象都出现过），按运行时类型分支渲染 */
function ValueView({ value }: { value: unknown }): JSX.Element {
  if (value === null || value === undefined) return <span className="pstu-empty">—</span>

  if (typeof value === 'string') {
    return value.trim() === '' ? (
      <span className="pstu-empty">空字符串</span>
    ) : (
      <span className="pstu-val">{value}</span>
    )
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    return <span className="pstu-val pstu-num">{String(value)}</span>
  }

  if (Array.isArray(value)) {
    if (value.length === 0) return <span className="pstu-empty">空数组</span>
    return (
      <ul className="pstu-arr">
        {value.map((item, i) => (
          <li key={i}>
            <ValueView value={item} />
          </li>
        ))}
      </ul>
    )
  }

  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
    if (entries.length === 0) return <span className="pstu-empty">空对象</span>
    return (
      <dl className="pstu-kv">
        {entries.map(([k, v]) => (
          <div className="pstu-kv-row" key={k}>
            <dt>{k}</dt>
            <dd>
              <ValueView value={v} />
            </dd>
          </div>
        ))}
      </dl>
    )
  }

  return <span className="pstu-empty">—</span>
}

export interface StudioBusy {
  preview: boolean
  enhance: boolean
  explain: boolean
  chat: boolean
}

export function PromptStudio({
  open,
  idea,
  prompt,
  structure,
  style,
  noStyle,
  ratioLabel,
  ratioSub,
  autoRatio,
  ratioLocked,
  promptState,
  staleStyleLabel,
  explain,
  chat,
  busy,
  onIdea,
  onPrompt,
  onPreview,
  onEnhance,
  onExplain,
  onChat,
  onClearChat,
  onOpenStyle,
  onOpenRatio,
  onPickNoStyle,
  onPickAutoRatio,
  onClose,
}: {
  open: boolean
  idea: string
  prompt: string
  structure: Record<string, unknown> | null
  /** 当前生效的画风。查不到（库还没加载）时按未知处理，不编一个名字出来 */
  style: StylePreset | undefined
  /** 当前是不是「明确不指定画风」 */
  noStyle: boolean
  ratioLabel: string
  ratioSub: string
  /** 画幅没钉住，由立意按画面内容挑 */
  autoRatio: boolean
  /** 应用锁死的画幅；非 null 时不给改 */
  ratioLocked: string | null
  promptState: PromptState
  staleStyleLabel: string
  explain: PromptExplain | null
  chat: ChatTurn[]
  busy: StudioBusy
  onIdea: (v: string) => void
  onPrompt: (v: string) => void
  onPreview: () => void
  onEnhance: () => void
  onExplain: () => void
  onChat: (text: string) => void
  onClearChat: () => void
  onOpenStyle: () => void
  onOpenRatio: () => void
  onPickNoStyle: () => void
  onPickAutoRatio: () => void
  onClose: () => void
}): JSX.Element | null {
  const [view, setView] = useState<'prompt' | 'structure'>('prompt')
  const [raw, setRaw] = useState(false)
  const [shut, setShut] = useState<string[]>([])
  const [copied, setCopied] = useState<'prompt' | 'json' | null>(null)
  /** 提示词框被手改过。两段式 Esc 只对手改过且焦点还在框里的情况生效 */
  const [edited, setEdited] = useState(false)
  /** 最近一次自己敲进去的内容。用来区分「父组件回传我打的字」和「外部覆盖了内容」 */
  const [typed, setTyped] = useState<string | null>(null)
  const [say, setSay] = useState('')

  const chatEnd = useRef<HTMLDivElement>(null)

  // 关掉时清掉临时态，下次打开不带上一轮的复制提示与手改标记（STD-UI-005）
  useEffect(() => {
    if (open) return
    setCopied(null)
    setEdited(false)
    setTyped(null)
    setSay('')
  }, [open])

  // 内容被外部换掉（写提示词 / 补细节 / 对话改词的返回），手改标记作废
  useEffect(() => {
    if (typed === prompt) return
    setTyped(null)
    setEdited(false)
  }, [prompt, typed])

  // 结构被清空时退回提示词页，避免停在一个空标签页上
  useEffect(() => {
    if (structure === null) setView('prompt')
  }, [structure])

  useEffect(() => {
    if (copied === null) return
    const timer = window.setTimeout(() => setCopied(null), 1800)
    return () => window.clearTimeout(timer)
  }, [copied])

  // 新一轮对话进来就滚到底。smooth 在内嵌浏览器面板里会被整个吞掉，一律 auto
  useEffect(() => {
    if (!open) return
    chatEnd.current?.scrollIntoView({ block: 'nearest', behavior: 'auto' })
  }, [chat.length, busy.chat, open])

  const json = useMemo(
    () => (structure === null ? '' : JSON.stringify(structure, null, 2)),
    [structure],
  )

  // 七段式之外的字段照样列出来，别让后端多返回的东西在界面上消失
  const extra = useMemo(() => {
    if (structure === null) return []
    return Object.entries(structure).filter(([k]) => !SEGMENT_KEYS.has(k))
  }, [structure])

  const words = useMemo(() => {
    const text = prompt.trim()
    return text === '' ? 0 : text.split(/\s+/).length
  }, [prompt])

  if (!open) return null

  const anyBusy = busy.preview || busy.enhance || busy.chat
  const canWrite = !anyBusy && idea.trim() !== ''
  const canEnhance = !anyBusy && prompt.trim() !== ''
  const canSay = !anyBusy && say.trim() !== '' && prompt.trim() !== ''
  const allShut = shut.length >= SEGMENTS.length

  function toggleSeg(key: string): void {
    setShut((prev) => (prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]))
  }

  async function copyText(text: string, tag: 'prompt' | 'json'): Promise<void> {
    if (text === '') return
    try {
      await navigator.clipboard.writeText(text)
      setCopied(tag)
    } catch {
      toast.error('复制失败：浏览器拒绝了剪贴板权限')
    }
  }

  function send(): void {
    if (!canSay) return
    onChat(say.trim())
    setSay('')
  }

  /* STD-UI-002b 两段式 Esc：框里有手打的内容且焦点就在框里时，
     第一下 Esc 只失焦，第二下才关弹窗——打了半天的字不该被一下 Esc 带走。 */
  function handleEscape(e: KeyboardEvent): void {
    const chatBox = document.getElementById(CHAT_BOX_ID)
    if (chatBox !== null && document.activeElement === chatBox && say.trim() !== '') {
      e.preventDefault()
      chatBox.blur()
      return
    }
    if (!edited) return
    const el = document.getElementById(PROMPT_BOX_ID)
    if (el === null || document.activeElement !== el) return
    e.preventDefault()
    el.blur()
  }

  /* 提示词与画风的关系有四种，说法必须跟着状态走。
     只写一句「画风决定风格」在 hand / stale 这两种情况下是**错的**——
     管线看到非空 prompt_override 就原样发，画风一点都不参与（STD-UI-006）。 */
  const bond = (() => {
    switch (promptState.kind) {
      case 'empty':
        return {
          tone: 'wait' as const,
          text: '还没有提示词。点左边的按钮，把中文意图按当前画风译写成英文。',
        }
      case 'fresh':
        return {
          tone: 'ok' as const,
          text: `这份提示词就是按「${style?.label ?? '当前画风'}」写的，出图直接用它。`,
        }
      case 'stale':
        return {
          tone: 'warn' as const,
          // wasStyle 为空表示是画幅变了而不是画风变了——画布句写在提示词正文里，
          // 同样得重写，但不能说成「画风换了」
          text: promptState.wasStyle
            ? `下面这份是按「${staleStyleLabel}」写的，画风换了它就作废——出图时会按当前画风重写。`
            : '下面这份是按上一个画幅写的（画布比例就写在提示词正文里），出图时会按当前画幅重写。',
        }
      default:
        return {
          tone: 'warn' as const,
          // 手打的和跟 AI 聊出来的都算「你定的」：都承载着明确指令，
          // 都会原样发出去，也都因此让画风不参与
          text: '这份提示词是你定的（手写，或跟 AI 改过），出图原样发出去，画风不参与。要让画风重新生效，把它清空再写一份。',
        }
    }
  })()

  const styleName = noStyle ? '不指定画风' : (style?.label ?? '未选')
  const styleHint = noStyle
    ? '不注入任何风格描述词，画面风格由你的意图和模型自己决定'
    : (style?.hint ?? '决定这批图看起来像同一个人画的')

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose()
      }}
    >
      <DialogContent
        className="pstu-shell"
        showCloseButton={false}
        onEscapeKeyDown={handleEscape}
        onOpenAutoFocus={(e) => {
          e.preventDefault()
          document.getElementById(IDEA_BOX_ID)?.focus()
        }}
      >
        <header className="pstu-head">
          <span className="pstu-mark" aria-hidden="true">
            <WandSparkles />
          </span>
          <div className="pstu-head-text">
            <DialogTitle className="pstu-title">创作台</DialogTitle>
            <DialogDescription className="pstu-sub">
              你给意图和画风，AI 写英文提示词；看不懂就让它讲，不满意就跟它说。
            </DialogDescription>
          </div>
          <ol className="pstu-flow">
            <li className="pstu-step">
              <b>1</b>
              <span>意图 + 画风</span>
            </li>
            <li className="pstu-arrow" aria-hidden="true">
              <ArrowRight />
            </li>
            <li className="pstu-step">
              <b>2</b>
              <span>英文提示词</span>
            </li>
            <li className="pstu-arrow" aria-hidden="true">
              <ArrowRight />
            </li>
            <li className="pstu-step pstu-step-final">
              <b>3</b>
              <span>出图只读这一份</span>
            </li>
          </ol>
          <button type="button" className="pstu-x" onClick={onClose} aria-label="关闭创作台">
            <X />
          </button>
        </header>

        <div className="pstu-body">
          {/* ---------- 左：你给的两个输入 ---------- */}
          <section className="pstu-col pstu-col-in">
            <header className="pstu-col-head">
              <h3 className="pstu-col-title">
                <PenLine />
                你想画什么
              </h3>
              <span className="pstu-count">{idea.length} 字</span>
            </header>

            <Textarea
              id={IDEA_BOX_ID}
              className="pstu-idea"
              value={idea}
              spellCheck={false}
              placeholder="一句话说清要画什么、给谁看、用在哪里。中文即可。"
              onChange={(e) => onIdea(e.target.value)}
            />

            <div className="pstu-style">
              <span className="pstu-style-lab">
                <Palette />
                画风
              </span>
              <button type="button" className="pstu-style-card" onClick={onOpenStyle}>
                <b>{styleName}</b>
                <em>{styleHint}</em>
                <span className="pstu-style-go">换 ›</span>
              </button>
              {!noStyle && (
                <button type="button" className="pstu-style-none" onClick={onPickNoStyle}>
                  <Ban />
                  不指定画风
                </button>
              )}
            </div>

            <div className="pstu-style">
              <span className="pstu-style-lab">
                <Crop />
                画幅
              </span>
              {ratioLocked !== null ? (
                <div className="pstu-style-card pstu-style-locked">
                  <b>{ratioLabel}</b>
                  <em>这个应用锁定 {ratioLocked}——画幅由展示它的那块 UI 决定，不是偏好</em>
                </div>
              ) : (
                <>
                  <button type="button" className="pstu-style-card" onClick={onOpenRatio}>
                    <b>{ratioLabel}</b>
                    <em>{ratioSub}</em>
                    <span className="pstu-style-go">换 ›</span>
                  </button>
                  {!autoRatio && (
                    <button type="button" className="pstu-style-none" onClick={onPickAutoRatio}>
                      <Wand2 />
                      不指定，让 AI 按想法挑
                    </button>
                  )}
                </>
              )}
            </div>

            <p className="pstu-tip">
              <Lightbulb />
              先由 AI 把中文意图想成画面，再按画风与画幅渲染成中间那份英文提示词。
              画幅写在提示词的 `layout.canvas` 里，所以换了它提示词也要重写。
            </p>

            <div className="pstu-act">
              <Button className="pstu-btn-main" disabled={!canWrite} onClick={onPreview}>
                {busy.preview ? <LoaderCircle className="pstu-spin" /> : <ScanText />}
                {busy.preview ? '正在写…' : '按意图和画风写提示词'}
              </Button>
              {idea.trim() === '' ? <p className="pstu-warn">先写一句中文意图。</p> : null}
            </div>
          </section>

          {/* ---------- 中：产物 + 中文解读 ---------- */}
          <section className="pstu-col pstu-col-out">
            <header className="pstu-col-head">
              <div className="pstu-tablist" role="tablist" aria-label="提示词视图">
                <button
                  type="button"
                  role="tab"
                  aria-selected={view === 'prompt'}
                  className={view === 'prompt' ? 'pstu-tab on' : 'pstu-tab'}
                  onClick={() => setView('prompt')}
                >
                  最终提示词
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={view === 'structure'}
                  className={view === 'structure' ? 'pstu-tab on' : 'pstu-tab'}
                  disabled={structure === null}
                  onClick={() => setView('structure')}
                >
                  七段式结构
                </button>
              </div>
              <span className="pstu-count">
                {prompt.length} 字符 · {words} 词
              </span>
              <Button
                variant="ghost"
                size="sm"
                disabled={prompt === ''}
                onClick={() => void copyText(prompt, 'prompt')}
              >
                {copied === 'prompt' ? <Check /> : <Copy />}
                {copied === 'prompt' ? '已复制' : '复制'}
              </Button>
            </header>

            <p className={`pstu-bond pstu-bond-${bond.tone}`}>
              {bond.tone === 'warn' ? <TriangleAlert /> : <Check />}
              {bond.text}
            </p>

            {view === 'prompt' ? (
              <div className="pstu-pane">
                <Textarea
                  id={PROMPT_BOX_ID}
                  className="pstu-prompt"
                  value={prompt}
                  spellCheck={false}
                  placeholder="点左边「按意图和画风写提示词」由 AI 写一份，或直接在这里手写英文提示词。"
                  onChange={(e) => {
                    setTyped(e.target.value)
                    setEdited(true)
                    onPrompt(e.target.value)
                  }}
                />

                <div className="pstu-under">
                  <Button variant="outline" size="sm" disabled={!canEnhance} onClick={onEnhance}>
                    {busy.enhance ? <LoaderCircle className="pstu-spin" /> : <WandSparkles />}
                    {busy.enhance ? '扩写中…' : 'AI 补细节'}
                  </Button>
                  <span className="pstu-under-note">一次性把当前提示词补厚，覆盖上面这一框。</span>
                </div>

                {/* ---- 中文解读：出图之前先看懂这段英文要画什么 ---- */}
                <div className="pstu-explain">
                  <header className="pstu-explain-head">
                    <Languages />
                    <b>中文解读</b>
                    {busy.explain ? (
                      <span className="pstu-explain-busy">
                        <LoaderCircle className="pstu-spin" />
                        正在读…
                      </span>
                    ) : (
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={prompt.trim() === ''}
                        onClick={onExplain}
                      >
                        {explain === null ? '让 AI 讲讲' : '重新读一遍'}
                      </Button>
                    )}
                  </header>

                  {explain === null ? (
                    <p className="pstu-explain-idle">
                      {prompt.trim() === ''
                        ? '有了提示词就能让 AI 用中文讲清它要画什么。'
                        : '正在读，或点右边让 AI 把这段英文讲成人话。'}
                    </p>
                  ) : (
                    <>
                      <p className="pstu-explain-sum">{explain.summary}</p>
                      {explain.points.length > 0 && (
                        <dl className="pstu-explain-pts">
                          {explain.points.map((pt) => (
                            <div key={pt.label}>
                              <dt>{pt.label}</dt>
                              <dd>{pt.text}</dd>
                            </div>
                          ))}
                        </dl>
                      )}
                      {explain.missing.length > 0 && (
                        <div className="pstu-miss">
                          <b>
                            <TriangleAlert />
                            你说了、但提示词里没有
                          </b>
                          <ul>
                            {explain.missing.map((item) => (
                              <li key={item}>{item}</li>
                            ))}
                          </ul>
                          <span>
                            这几点不补进去，出来的图就不会有。到右边跟 AI 说一声，或者自己在上面加。
                          </span>
                        </div>
                      )}
                    </>
                  )}
                </div>
              </div>
            ) : (
              <div className="pstu-pane">
                <div className="pstu-struct-bar">
                  <span className="pstu-struct-hint">
                    <ListTree />
                    立意后渲染出的字段，顺序固定
                  </span>
                  <div className="pstu-struct-tools">
                    {raw ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={json === ''}
                        onClick={() => void copyText(json, 'json')}
                      >
                        {copied === 'json' ? <Check /> : <Copy />}
                        {copied === 'json' ? '已复制' : '复制 JSON'}
                      </Button>
                    ) : (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setShut(allShut ? [] : SEGMENTS.map((s) => s.key))}
                      >
                        {allShut ? '全部展开' : '全部折叠'}
                      </Button>
                    )}
                    <label className="pstu-raw" htmlFor="pstu-raw-switch">
                      <Braces />
                      原样 JSON
                      <Switch id="pstu-raw-switch" checked={raw} onCheckedChange={setRaw} />
                    </label>
                  </div>
                </div>

                {raw ? (
                  <pre className="pstu-json">{json}</pre>
                ) : (
                  <div className="pstu-segs">
                    {SEGMENTS.map((seg) => {
                      const has = structure !== null && seg.key in structure
                      const closed = shut.includes(seg.key)
                      return (
                        <section
                          className={has ? 'pstu-seg' : 'pstu-seg pstu-seg-miss'}
                          key={seg.key}
                        >
                          <button
                            type="button"
                            className="pstu-seg-head"
                            aria-expanded={!closed}
                            aria-controls={`pstu-seg-${seg.key}`}
                            onClick={() => toggleSeg(seg.key)}
                          >
                            <ChevronRight
                              className={closed ? 'pstu-seg-arrow' : 'pstu-seg-arrow pstu-open'}
                            />
                            <span className="pstu-seg-label">{seg.label}</span>
                            <code className="pstu-seg-key">{seg.key}</code>
                            <span className="pstu-seg-hint">{seg.hint}</span>
                          </button>
                          {closed ? null : (
                            <div className="pstu-seg-body" id={`pstu-seg-${seg.key}`}>
                              {has && structure !== null ? (
                                <ValueView value={structure[seg.key]} />
                              ) : (
                                <span className="pstu-empty">
                                  {seg.key === 'style' && noStyle
                                    ? '这次没指定画风，所以没有这一段'
                                    : '这次的结构里没有这一段'}
                                </span>
                              )}
                            </div>
                          )}
                        </section>
                      )
                    })}

                    {extra.length > 0 ? (
                      <section className="pstu-seg pstu-seg-extra">
                        <header className="pstu-seg-head pstu-seg-static">
                          <span className="pstu-seg-label">其他字段</span>
                          <span className="pstu-seg-hint">七段式之外，后端一并返回的内容</span>
                        </header>
                        <div className="pstu-seg-body">
                          <dl className="pstu-kv">
                            {extra.map(([k, v]) => (
                              <div className="pstu-kv-row" key={k}>
                                <dt>{k}</dt>
                                <dd>
                                  <ValueView value={v} />
                                </dd>
                              </div>
                            ))}
                          </dl>
                        </div>
                      </section>
                    ) : null}
                  </div>
                )}
              </div>
            )}
          </section>

          {/* ---------- 右：对话改词 ---------- */}
          <section className="pstu-col pstu-col-chat">
            <header className="pstu-col-head">
              <h3 className="pstu-col-title">
                <MessageSquare />
                跟 AI 说怎么改
              </h3>
              {chat.length > 0 && (
                <Button variant="ghost" size="sm" onClick={onClearChat} disabled={busy.chat}>
                  <Eraser />
                  清空
                </Button>
              )}
            </header>

            <div className="pstu-chat">
              {chat.length === 0 ? (
                <div className="pstu-chat-idle">
                  <p>用中文说想改什么，AI 直接改中间那份英文提示词，并告诉你改了哪儿。</p>
                  <ul>
                    <li>再暗一点，改成黄昏</li>
                    <li>人物换成侧脸，别正对镜头</li>
                    <li>背景太满了，留白多一些</li>
                  </ul>
                  <span>它每次都拿当前提示词当底稿，所以可以一句一句慢慢收敛。</span>
                </div>
              ) : (
                chat.map((turn, i) => (
                  <div key={i} className={turn.role === 'user' ? 'pstu-turn mine' : 'pstu-turn ai'}>
                    <p>{turn.content}</p>
                    {turn.role === 'assistant' && turn.prompt ? (
                      <span className="pstu-turn-tag">
                        <Check />
                        已改写提示词
                      </span>
                    ) : null}
                  </div>
                ))
              )}
              {busy.chat && (
                <div className="pstu-turn ai pstu-turn-busy">
                  <LoaderCircle className="pstu-spin" />
                  正在改…
                </div>
              )}
              <div ref={chatEnd} />
            </div>

            <div className="pstu-say">
              <Textarea
                id={CHAT_BOX_ID}
                className="pstu-say-box"
                value={say}
                spellCheck={false}
                placeholder={prompt.trim() === '' ? '先有提示词才能改它' : '想改什么？中文说就行'}
                disabled={prompt.trim() === ''}
                onChange={(e) => setSay(e.target.value)}
                onKeyDown={(e) => {
                  // Enter 发送、Shift+Enter 换行：聊天框的通行做法
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault()
                    send()
                  }
                }}
              />
              <Button size="sm" disabled={!canSay} onClick={send}>
                {busy.chat ? <LoaderCircle className="pstu-spin" /> : <CornerDownLeft />}
                发送
              </Button>
            </div>
          </section>
        </div>

        <footer className="pstu-foot">
          <p className="pstu-foot-note">
            这里所有按钮都只调文本模型，不出图；改完关掉，回控制台点出图才真的开始画。
          </p>
          <Button variant="outline" onClick={onClose}>
            关闭
          </Button>
        </footer>
      </DialogContent>
    </Dialog>
  )
}
