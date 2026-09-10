/* 中译英模式：显示中文 → 键入英文 → 与原句逐词 diff + 相似度%；
   AI 语法点评（对用户译句走 /analyze/grammar 流式，显式触发，BR-03）。 */

import { useEffect, useMemo, useState } from 'react'
import type { KeyboardEvent } from 'react'

import { IconSparkle } from '../../components/icons'
import type { CueV2 } from '../../lib/api-video'
import type { GrammarAnalysis } from '../../lib/api'
import { useStreamAnalyze } from '../reader/streaming'
import { GrammarVoiceButton } from '../grammar/GrammarVoice'
import { VIconArrowLeft, VIconArrowRight, VIconPlaySolid } from './icons'
import { diffWords } from './videoUtils'
import type { DiffResult } from './videoUtils'

interface TranslatePanelProps {
  cues: CueV2[]
  idx: number
  setIdx: (i: number) => void
  playSegment: (i: number) => void
  zhOf: (cue: CueV2) => string | undefined
  textOf: (cue: CueV2) => string
}

export function TranslatePanel({ cues, idx, setIdx, playSegment, zhOf, textOf }: TranslatePanelProps) {
  const cue = cues[idx] as CueV2 | undefined
  const [input, setInput] = useState('')
  const [result, setResult] = useState<DiffResult | null>(null)
  const [doneCues, setDoneCues] = useState<Set<number>>(new Set())
  const grammar = useStreamAnalyze<GrammarAnalysis>('grammar')
  const [analyzed, setAnalyzed] = useState<{ cueId: number; sentence: string } | null>(null)

  const refText = cue !== undefined ? textOf(cue) : ''
  const zh = cue !== undefined ? zhOf(cue) : undefined

  useEffect(() => {
    setInput('')
    setResult(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cue?.id])

  /* 相似度：正确词 / max(参考词数, 用户词数) */
  const similarity = useMemo(() => {
    if (result === null) return null
    const denom = Math.max(result.total, result.correct + result.extra, 1)
    return Math.round((result.correct / denom) * 100)
  }, [result])

  if (cue === undefined) {
    return <div className="panel-empty">本视频暂无字幕，无法练习中译英</div>
  }

  const submit = () => {
    if (input.trim() === '' || result !== null) return
    setResult(diffWords(refText, input))
    setDoneCues((s) => new Set(s).add(cue.id))
  }

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      if (result !== null && idx < cues.length - 1) setIdx(idx + 1)
      else submit()
    }
  }

  const simClass = similarity === null ? '' : similarity >= 80 ? 'hi' : similarity >= 50 ? 'mid' : 'lo'
  const gState = grammar.state
  const currentAnalysis = analyzed?.cueId === cue.id && analyzed.sentence === input
  const gShown = currentAnalysis ? gState.data?.result ?? (gState.status === 'streaming' ? gState.partial : null) : null

  return (
    <>
      <div className="vm-panel-head">
        <h3>中译英</h3>
        <GrammarVoiceButton sentence={currentAnalysis && analyzed ? analyzed.sentence : input.trim() || refText}
          analysis={currentAnalysis && gState.data ? { analysis: gState.data.result, reference: refText, referenceTranslation: zh } : undefined}
          source="字幕中译英语法点评" />
        <span className="chip accent">
          第 {idx + 1} 句 / {cues.length}
        </span>
        <div style={{ flex: 1 }} />
      </div>
      <div className="vm-mode-body">
        <div className="card vm-tr-zh">
          <span className="lbl">把这句译成英文</span>
          {zh ?? (
            <span style={{ color: 'var(--ink-faint)' }}>
              本句暂无中文（可先生成中文字幕轨），可听原声后复述
            </span>
          )}
        </div>

        <div>
          <textarea
            className="vm-dict-input"
            spellCheck={false}
            placeholder="键入你的英文译句，Enter 提交对比…"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKey}
          />
          <div className="vm-dict-keys">
            <span>
              <kbd>Enter</kbd> {result !== null ? '下一句' : '提交对比'}
            </span>
            <span>
              <kbd>Shift Enter</kbd> 换行
            </span>
          </div>
        </div>

        {result !== null && (
          <div className="card vm-dict-result">
            <div className="vm-dr-head">
              <span className="ttl">与原句逐词对比</span>
              <div style={{ flex: 1 }} />
              <span className={`vm-sim ${simClass}`}>
                相似度 <b>{similarity}%</b>
              </span>
            </div>
            <div className="vm-dr-words">
              {result.items.map((w, i) => (
                <span key={i} className={`vm-dw ${w.status}`}>
                  {w.word}
                  {w.status === 'wrong' && w.got !== undefined && <s>→{w.got}</s>}
                </span>
              ))}
            </div>
            <div className="vm-tr-ref" style={{ marginTop: 10 }}>
              参考原句：{refText}
            </div>
            <div className="vm-dr-legend" style={{ marginTop: 8 }}>
              <span>相似度按词面对齐计算，意译不同词序会偏低，仅供参考</span>
            </div>
          </div>
        )}

        {result !== null && (
          <div>
            {gShown !== null && gShown !== undefined ? (
              <div className="wc-ai">
                <b>AI 语法点评（针对你的译句）</b>
                {gShown.quick !== undefined && <div style={{ marginTop: 6 }}>{gShown.quick}</div>}
                {gShown.backbone !== undefined && gShown.backbone !== '' && (
                  <div style={{ marginTop: 6 }}>句子主干：{gShown.backbone}</div>
                )}
                {gShown.difficulty_note !== undefined && gShown.difficulty_note !== '' && (
                  <div className="wc-hint">{gShown.difficulty_note}</div>
                )}
                {gState.status === 'streaming' && <span className="stream-caret" />}
              </div>
            ) : gState.status === 'streaming' ? (
              <div className="wc-muted">
                AI 分析中…<span className="stream-caret" />
              </div>
            ) : gState.status === 'error' ? (
              <div className="panel-error">
                {gState.gateway ? 'AI 网关未配置，暂不可用' : `点评失败：${gState.error}`}
              </div>
            ) : (
              <button
                className="btn btn-soft btn-sm"
                onClick={() => {
                  setAnalyzed({ cueId: cue.id, sentence: input })
                  grammar.start({ sentence: input })
                }}
              >
                <IconSparkle />
                AI 语法点评
              </button>
            )}
          </div>
        )}

        <div className="vm-mode-acts">
          <button className="btn btn-outline" onClick={() => playSegment(idx)}>
            <VIconPlaySolid style={{ width: 14, height: 14 }} />
            听原句
          </button>
          <div style={{ flex: 1 }} />
          <button className="btn" disabled={idx <= 0} onClick={() => setIdx(idx - 1)}>
            <VIconArrowLeft />
            上一句
          </button>
          <button
            className="btn btn-primary"
            disabled={idx >= cues.length - 1}
            onClick={() => setIdx(idx + 1)}
          >
            下一句
            <VIconArrowRight />
          </button>
        </div>

        <div className="divider" />
        <div className="vm-mode-stats">
          <span>
            本次已练 <b>{doneCues.size}</b> 句
          </span>
          <div className="vm-sess-bar">
            <i style={{ width: `${cues.length > 0 ? (doneCues.size / cues.length) * 100 : 0}%` }} />
          </div>
          <span>
            {doneCues.size} / {cues.length}
          </span>
        </div>
      </div>
    </>
  )
}
