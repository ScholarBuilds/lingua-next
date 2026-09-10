/* 练习引擎的渲染层（[组件：练习引擎]）。

   判分在服务端的纯函数里，这里**只负责渲染与收集作答**——
   这是那份组件设计里唯一的硬约束：评分与渲染分离，判分才可回归测试。
   所以本文件不含任何 `answer === picked` 之类的比较。 */

import { useEffect, useMemo, useRef, useState } from 'react'

import { getSessionVoice, playUrl, ttsUrl } from '@/lib/audio'
import { toast } from 'sonner'

import './exercise.css'

export interface Question {
  id: string
  widget: string
  prompt?: string
  sentence?: string
  choices?: string[]
  tokens?: string[]
  statements?: string[]
  occurrences?: { id: number; text: string; snippet: string }[]
  audio?: { text: string; voice?: string }
  meta?: Record<string, unknown>
}

export interface WidgetProps {
  question: Question
  /** 已提交后的判分结果；未提交为 null。渲染层只用它决定样式，不参与判分 */
  verdict: { correct: boolean; detail?: Record<string, unknown> } | null
  disabled?: boolean
  onSubmit: (response: unknown) => void
}

/* ─────────── 音频 ─────────── */

export function useAudio() {
  const ref = useRef<HTMLAudioElement | null>(null)
  useEffect(
    () => () => {
      ref.current?.pause()
      ref.current = null
    },
    [],
  )
  return (text: string, voice?: string) => {
    ref.current?.pause()
    const el = playUrl(ttsUrl(text, 'sentence', voice ?? getSessionVoice()))
    ref.current = el
    el.addEventListener('error', () => toast.error('练习音频播放失败，请重试或检查语音配置'), { once: true })
  }
}

export function PlayButton({
  text,
  voice,
  label = '播放',
  big,
}: {
  text: string
  voice?: string
  label?: string
  big?: boolean
}) {
  const play = useAudio()
  return (
    <button className={`ex-play${big === true ? ' big' : ''}`} onClick={() => play(text, voice)}>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
        <path d="M8 5.5v13l10-6.5z" fill="currentColor" stroke="none" />
      </svg>
      {label}
    </button>
  )
}

/* ─────────── 单选题（听辨 / 认读 / 指称型） ─────────── */

function ChoiceWidget({ question, verdict, disabled, onSubmit }: WidgetProps) {
  const [picked, setPicked] = useState<number | null>(null)
  useEffect(() => {
    setPicked(null)
  }, [question.id])

  const answered = verdict !== null
  // 判分结果里带回正确答案（服务端在答错时放进 detail.answer），
  // 渲染层只负责把它标出来，不参与「谁是正确答案」的判断
  const answerIdx = answered ? (verdict.detail?.answer as number | undefined) : undefined

  return (
    <div className="ex-choices">
      {(question.choices ?? []).map((c, i) => {
        const isPicked = picked === i
        let cls = 'ex-choice'
        if (answered && isPicked) cls += verdict.correct ? ' right' : ' wrong'
        if (answered && answerIdx === i && !verdict.correct) cls += ' answer'
        return (
          <button
            key={`${question.id}-${i}`}
            className={cls}
            disabled={disabled === true || answered}
            onClick={() => {
              setPicked(i)
              onSubmit(i)
            }}
          >
            <span className="ex-choice-key">{String.fromCharCode(65 + i)}</span>
            <span className="ex-choice-text">{c}</span>
          </button>
        )
      })}
    </div>
  )
}

/* ─────────── 词块排序 ─────────── */

function WordOrderWidget({ question, verdict, disabled, onSubmit }: WidgetProps) {
  const pool = question.tokens ?? []
  const [order, setOrder] = useState<number[]>([])
  useEffect(() => {
    setOrder([])
  }, [question.id])

  const remaining = pool.map((_, i) => i).filter((i) => !order.includes(i))
  const answered = verdict !== null

  return (
    <div className="ex-order">
      <div className="ex-order-slot">
        {order.length === 0 && <span className="ex-hint">点下面的词块，按顺序排成一句话</span>}
        {order.map((i, pos) => (
          <button
            key={`p-${i}`}
            className="ex-token placed"
            disabled={answered}
            onClick={() => setOrder(order.filter((_, k) => k !== pos))}
          >
            {pool[i]}
          </button>
        ))}
      </div>
      <div className="ex-order-pool">
        {remaining.map((i) => (
          <button
            key={`t-${i}`}
            className="ex-token"
            disabled={disabled === true || answered}
            onClick={() => setOrder([...order, i])}
          >
            {pool[i]}
          </button>
        ))}
      </div>
      <button
        className="btn btn-primary"
        disabled={disabled === true || answered || order.length !== pool.length}
        onClick={() => onSubmit({ order: order.map((i) => pool[i]) })}
      >
        提交
      </button>
    </div>
  )
}

/* ─────────── 文本作答（句型转换 / 找错改正 / 产出型） ─────────── */

function TextWidget({ question, verdict, disabled, onSubmit }: WidgetProps) {
  const [text, setText] = useState('')
  useEffect(() => {
    setText('')
  }, [question.id])
  const answered = verdict !== null
  return (
    <div className="ex-text">
      {question.sentence !== undefined && question.sentence !== '' && (
        <p className="ex-source">{question.sentence}</p>
      )}
      <textarea
        value={text}
        disabled={disabled === true || answered}
        placeholder="用英文作答"
        rows={3}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && text.trim() !== '') {
            onSubmit({ text })
          }
        }}
      />
      <button
        className="btn btn-primary"
        disabled={disabled === true || answered || text.trim() === ''}
        onClick={() => onSubmit({ text })}
      >
        提交
        <kbd>⌘↵</kbd>
      </button>
    </div>
  )
}

/* ─────────── 情感型（无对错，不进 SRS） ─────────── */

function AffectiveWidget({ question, verdict, onSubmit }: WidgetProps) {
  const [picked, setPicked] = useState<number[]>([])
  const answered = verdict !== null
  return (
    <div className="ex-affective">
      <p className="ex-hint">勾出符合你自己情况的句子。这类题没有对错，也不计入复习。</p>
      {(question.statements ?? []).map((s, i) => (
        <label key={i} className="ex-statement">
          <input
            type="checkbox"
            checked={picked.includes(i)}
            disabled={answered}
            onChange={() =>
              setPicked(picked.includes(i) ? picked.filter((k) => k !== i) : [...picked, i])
            }
          />
          <span>{s}</span>
        </label>
      ))}
      <button className="btn btn-outline" disabled={answered} onClick={() => onSubmit({ picked })}>
        完成
      </button>
    </div>
  )
}

/* ─────────── 语料定位题 ─────────── */

function LocateWidget({ question, verdict, disabled, onSubmit }: WidgetProps) {
  const [picked, setPicked] = useState<number | null>(null)
  useEffect(() => {
    setPicked(null)
  }, [question.id])
  const answered = verdict !== null
  return (
    <div className="ex-locate">
      {(question.occurrences ?? []).map((o) => {
        const isPicked = picked === o.id
        let cls = 'ex-locate-item'
        if (answered && isPicked) cls += verdict.correct ? ' right' : ' wrong'
        return (
          <button
            key={o.id}
            className={cls}
            disabled={disabled === true || answered}
            onClick={() => {
              setPicked(o.id)
              onSubmit(String(o.id))
            }}
          >
            {o.text}
          </button>
        )
      })}
    </div>
  )
}

/* ─────────── 分发 ─────────── */

const REGISTRY: Record<string, (p: WidgetProps) => JSX.Element> = {
  'minimal-pair': ChoiceWidget,
  'audio-choice': ChoiceWidget,
  'phoneme-decode': ChoiceWidget,
  'referential-input': ChoiceWidget,
  'sentence-transform': TextWidget,
  'error-correction': TextWidget,
  production: TextWidget,
  'word-order': WordOrderWidget,
  'affective-input': AffectiveWidget,
  locate: LocateWidget,
}

export function ExerciseWidget(props: WidgetProps) {
  const Impl = useMemo(() => REGISTRY[props.question.widget], [props.question.widget])
  if (Impl === undefined) {
    return <p className="ex-hint">这台前端还不认识题型 {props.question.widget}</p>
  }
  return <Impl {...props} />
}

export function widgetExists(widget: string): boolean {
  return REGISTRY[widget] !== undefined
}
