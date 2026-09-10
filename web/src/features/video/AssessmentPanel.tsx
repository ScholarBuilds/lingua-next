/* 发音诊断面板（FR-398 前端）。

   > [!info] 音素级那一层已于 2026-08-30 随本地音素模型一起下线
   >
   > 它靠一个 1.5GB 的 wav2vec2-espeak ONNX 出音素后验，本地推理外包给 API 时
   > 这一项没有对应上游——任何 ASR API 都不返回逐帧音素概率。
   > 面板上的「音素级提示」折叠区、`accuracy_source` 的 model/heuristic 分支、
   > 以及顶部的「第 N 层」标签都随之删掉：**永不触发的 UI 分支比没有更糟**，
   > 它让读代码的人以为那一层还在、只是这次没数据。
   >
   > 留下的三个指标一个都不依赖那个模型：完整度是纯文本比对，
   > 流利度与词级置信度来自 CTC 强制对齐（另一个模型，仍在）。
   > 顺带 BR-90（音素结论一律弱视觉、禁红叉）在这个文件里失去了约束对象。

   分数由服务端的确定性算法给，LLM 只负责把它翻译成中文说明（FR-398j）——
   所以这里的「AI 讲解」区块不显示任何数字。 */

import { useRef, useState } from 'react'

import { Markdown } from '@/components/Markdown'

import './assessment.css'

export interface WordScore {
  word: string
  start: number
  end: number
  raw_score: number
  norm_score: number
  confidence: number
  status: string
}

export interface BreakEvent {
  kind: 'UnexpectedBreak' | 'MissingBreak'
  index: number
  ms: number
  word: string
}

export interface Assessment {
  completeness: number
  fluency: number
  /** 0-100 的发音准确度：词级 CTC 置信度的均值，未经人工标注校准 */
  accuracy: number
  words: WordScore[]
  breaks: BreakEvent[]
  notes?: string[]
}

const BREAK_LABEL: Record<string, string> = {
  UnexpectedBreak: '不该断的地方停了',
  MissingBreak: '该停的地方没停',
}

function Metric({ label, value, hint }: { label: string; value: number; hint: string }) {
  return (
    <div className="pa-metric" title={hint}>
      <div className="pa-metric-val">{Math.round(value)}</div>
      <div className="pa-metric-bar">
        <div style={{ width: `${Math.max(0, Math.min(100, value))}%` }} />
      </div>
      <div className="pa-metric-label">{label}</div>
    </div>
  )
}

export function AssessmentPanel({
  data,
  recordingId,
  onNarrate,
}: {
  data: Assessment
  recordingId: number
  onNarrate?: (id: number, onDelta: (t: string) => void) => Promise<void>
}) {
  const [narration, setNarration] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const bufRef = useRef('')

  const run = async () => {
    if (onNarrate === undefined) return
    setBusy(true)
    bufRef.current = ''
    setNarration('')
    try {
      await onNarrate(recordingId, (t) => {
        bufRef.current += t
        setNarration(bufRef.current)
      })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="pa-panel">
      <div className="pa-head">
        <span className="pa-title">发音诊断</span>
      </div>

      {/* 句子级：信号最可靠，给绝对值 */}
      <div className="pa-metrics">
        <Metric
          label="完整度"
          value={data.completeness}
          hint="读到的词占原句的比例，漏读多读都算。来自逐词比对，不依赖发音模型"
        />
        <Metric
          label="流利度"
          value={data.fluency}
          hint="停顿分布与语速。停在从句边界正常，停在短语中间扣分"
        />
        <Metric
          label="发音准确度"
          value={data.accuracy}
          hint="词级 CTC 置信度的均值。没有人工标注做校准，只能自己跟自己比"
        />
      </div>

      {/* 词级：中等权重，用底色深浅表达置信度 */}
      {data.words.length > 0 && (
        <div className="pa-words">
          {data.words.map((w, i) => {
            const weak = w.confidence < 45
            return (
              <span
                key={`${w.word}-${i}`}
                className={`pa-w${weak ? ' weak' : ''}${w.status !== 'ok' ? ' off' : ''}`}
                title={`置信度 ${w.confidence} · ${w.start.toFixed(2)}s–${w.end.toFixed(2)}s`}
              >
                {w.word}
              </span>
            )
          })}
        </div>
      )}

      {data.breaks.length > 0 && (
        <ul className="pa-breaks">
          {data.breaks.slice(0, 6).map((b, i) => (
            <li key={i}>
              <span className={`pa-break-kind ${b.kind}`}>{BREAK_LABEL[b.kind]}</span>
              <code>{b.word}</code>
              <i>{b.ms} ms</i>
            </li>
          ))}
        </ul>
      )}


      {(data.notes ?? []).length > 0 && (
        <p className="pa-notes">{(data.notes ?? []).join('；')}</p>
      )}

      {onNarrate !== undefined && (
        <div className="pa-narrate">
          <button className="btn btn-soft btn-sm" disabled={busy} onClick={() => void run()}>
            {busy ? '生成中…' : narration !== null ? '重新讲解' : '让 AI 讲讲怎么改'}
          </button>
          {narration !== null && narration !== '' && (
            <div className="pa-narration">
              <Markdown text={narration} />
            </div>
          )}
        </div>
      )}
    </div>
  )
}
