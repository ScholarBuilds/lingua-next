/* 批注面板：一条批注的笔记 + AI 分析。

   三种分析各答一个不同的问题，所以是三个入口而不是一个「问 AI」：
   语法看结构、讲透看意思、翻译看中文对应。结果服务端按 kind 缓存，
   同一条重复点不会重复烧钱；想重算走「重新分析」。 */

import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'

import { Markdown } from '@/components/Markdown'
import type { AnalyzeKind, AnnColor, DocAnnotation } from '../../../lib/api-grammar-docs'
import { GrammarVoiceButton } from '../GrammarVoice'
import { annApi, streamAnnAnalyze } from '../../../lib/api-grammar-docs'
import { playTts } from '../../../lib/audio'

const KINDS: { key: AnalyzeKind; label: string; hint: string }[] = [
  { key: 'grammar', label: '语法分析', hint: '拆结构：成分、时态、从句' },
  { key: 'explain', label: '讲透', hint: '这段在说什么，为什么这么说' },
  { key: 'translate', label: '精准中译', hint: '按语境给中文，不逐字硬翻' },
]

const COLORS: { value: AnnColor; label: string }[] = [
  { value: 'yellow', label: '黄' },
  { value: 'green', label: '绿' },
  { value: 'blue', label: '蓝' },
  { value: 'pink', label: '粉' },
]

/* 引文里有没有可分析的英文。判据只要两个词——**批注是用户主动选的**，
   不是右键落点的猜测，该更信任他：「I go」「went home」都值得拆。
   纯中文才真的无从下手，那时才收掉「语法分析」这个死项。 */
const EN_RUN = /[A-Za-z'’-]+[\s,]+[A-Za-z]/

export function AnnotationPane({ ann, onClose }: { ann: DocAnnotation; onClose: () => void }) {
  const qc = useQueryClient()
  const [note, setNote] = useState(ann.note ?? '')
  const [kind, setKind] = useState<AnalyzeKind | null>(null)
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const acRef = useRef<AbortController | null>(null)

  // 换一条批注 = 换一套内容：不重置的话会把上一条的笔记与分析带过来
  useEffect(() => {
    setNote(ann.note ?? '')
    setKind(ann.ai_kind as AnalyzeKind | null)
    setText(ann.ai_result?.text ?? '')
    setError('')
    acRef.current?.abort()
    setBusy(false)
  }, [ann.id, ann.note, ann.ai_kind, ann.ai_result])

  useEffect(() => () => acRef.current?.abort(), [])

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ['glib-anns', ann.doc_path] })
  }

  const save = useMutation({
    mutationFn: (body: { note?: string; color?: AnnColor }) => annApi.update(ann.id, body),
    onSuccess: invalidate,
    onError: (e: Error) => toast.error(e.message),
  })

  const remove = useMutation({
    mutationFn: () => annApi.remove(ann.id),
    onSuccess: () => {
      invalidate()
      onClose()
    },
    onError: (e: Error) => toast.error(e.message),
  })

  const analyze = (k: AnalyzeKind, refresh: boolean) => {
    acRef.current?.abort()
    const ac = new AbortController()
    acRef.current = ac
    setKind(k)
    setText('')
    setError('')
    setBusy(true)
    void streamAnnAnalyze(
      ann.id,
      { kind: k, ...(refresh ? { refresh: true } : {}) },
      {
        onDelta: (t) => setText((prev) => prev + t),
        onDone: (full) => {
          setText(full)
          setBusy(false)
          invalidate()
        },
        onError: (msg) => {
          setError(msg)
          setBusy(false)
        },
      },
      ac.signal,
    )
  }

  const hasEnglish = EN_RUN.test(ann.quote)
  const lost = ann.resolved_start === null

  return (
    <div className="glib-ann-pane">
      <blockquote className="glib-ann-quote glib-nowords">
        {ann.quote}
        {hasEnglish && (
          <button className="glib-ann-speak" title="朗读" onClick={() => playTts(ann.quote)}>
            朗读
          </button>
        )}
      </blockquote>
      {lost && (
        <p className="glib-ann-lost">
          原文已改动，这条批注在正文里找不到落点——内容还在，只是不再高亮。
        </p>
      )}

      <div className="glib-ann-colors">
        {COLORS.map((c) => (
          <button
            key={c.value}
            className={`glib-ann-color ${c.value} ${ann.color === c.value ? 'on' : ''}`}
            title={c.label}
            onClick={() => save.mutate({ color: c.value })}
          />
        ))}
        <button
          className="glib-ann-del"
          onClick={() => remove.mutate()}
          disabled={remove.isPending}
        >
          删除
        </button>
      </div>

      <textarea
        className="glib-ann-note"
        placeholder="写点什么…（失焦即存）"
        value={note}
        rows={3}
        onChange={(e) => setNote(e.target.value)}
        onBlur={() => {
          if (note !== (ann.note ?? '')) save.mutate({ note })
        }}
      />

      <div className="glib-ann-kinds">
        <GrammarVoiceButton sentence={ann.quote} analysis={!busy && !error && text ? text : undefined} source="语法讲义批注" />
        {KINDS.map((k) => {
          const dead = k.key === 'grammar' && !hasEnglish
          return (
            <button
              key={k.key}
              className={`btn btn-soft btn-sm ${kind === k.key ? 'is-on' : ''}`}
              title={dead ? '这段没有成句的英文，语法分析无从下手' : k.hint}
              disabled={busy || dead}
              onClick={() => analyze(k.key, false)}
            >
              {k.label}
            </button>
          )
        })}
      </div>

      {error !== '' && <p className="glib-improve-error">{error}</p>}
      {busy && text === '' && <p className="glib-ann-wait">分析中…</p>}
      {text !== '' && (
        <div className="glib-ann-result">
          <Markdown text={text} />
          {!busy && kind !== null && (
            <div className="glib-ann-result-foot">
              <button className="btn-ghost-sm" onClick={() => analyze(kind, true)}>
                重新分析
              </button>
              <button
                className="btn-ghost-sm"
                onClick={() => {
                  void navigator.clipboard.writeText(text)
                  toast.success('已复制')
                }}
              >
                复制
              </button>
              {ann.ai_result !== null && <span>{ann.ai_result.model}</span>}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
