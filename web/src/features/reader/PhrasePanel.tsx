/* 词组解释面板（M5-FA）：拖选 ≤6 词的相邻词元 → phrase 流式分析。 */

import { useEffect } from 'react'

import { IconClose, IconSparkle, IconSpeaker } from '../../components/icons'
import type { AnalyzeDone, PhraseResult } from '../../lib/api-reader-m5'
import { playTts } from '../../lib/audio'
import { ClickableEn } from './ClickableEn'
import { VersionsButton } from './VersionsButton'
import { useReaderStore } from './readerStore'
import type { PhraseSelection } from './readerStore'
import { useStreamAnalyze } from './streaming'
import { GrammarVoiceButton } from '../grammar/GrammarVoice'

/* 会话级缓存：同一词组+语境重开面板直接展示 */
const phraseCache = new Map<string, AnalyzeDone<PhraseResult>>()

interface PhrasePanelProps {
  sel: PhraseSelection
  /** 关闭回调；缺省清全局选择（右栏面板用法），中央模态卡传关闭弹层 */
  onClose?: () => void
}

export function PhrasePanel({ sel, onClose }: PhrasePanelProps) {
  const clearSelection = useReaderStore((s) => s.clearSelection)
  const cacheKey = `${sel.text}::${sel.context}`
  const stream = useStreamAnalyze<PhraseResult>('phrase', (data) => phraseCache.set(cacheKey, data))
  const { state } = stream

  // 打开即分析（有缓存直接落定）
  useEffect(() => {
    const cached = phraseCache.get(cacheKey)
    if (cached) stream.settle(cached)
    else stream.start({ phrase: sel.text, context: sel.context })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cacheKey])

  const result = state.data?.result ?? (state.status === 'streaming' ? state.partial : null)
  const streamingCaret = state.status === 'streaming' && <span className="stream-caret" />

  return (
    <>
      <div className="panel-head">
        <h3>词组解释</h3>
        <GrammarVoiceButton sentence={sel.context || sel.text}
          analysis={state.data ? { phrase: sel.text, ...state.data.result } : undefined} source="词组语境解释" />
        <div style={{ flex: 1 }} />
        <button className="icon-btn" title="关闭" onClick={onClose ?? clearSelection}>
          <IconClose />
        </button>
      </div>
      <div className="panel-body">
        {/* 词组+喇叭整块即朗读，与词卡同构；点具体单词仍走点词查询 */}
        <div
          className="p-sent wc-say"
          role="button"
          tabIndex={0}
          title="点击朗读词组"
          onClick={(e) => {
            if ((e.target as HTMLElement).closest('.rt-w') !== null) return
            if ((window.getSelection()?.toString() ?? '').trim() !== '') return
            playTts(sel.text, 'word')
          }}
        >
          <ClickableEn text={sel.text} context={sel.context} />
          <IconSpeaker />
        </div>

        <div>
          <div className="wc-label" style={{ marginBottom: 8 }}>
            <IconSparkle />
            AI 语境解释
            {state.data && (
              <VersionsButton<PhraseResult>
                scope="phrase"
                kind="phrase"
                content={sel.text}
                context={sel.context}
                version={state.data.version}
                onActivated={(d) => {
                  phraseCache.set(cacheKey, d)
                  stream.settle(d)
                }}
              />
            )}
            {state.data && (
              <button
                className="btn-ghost-sm re"
                onClick={() => stream.start({ phrase: sel.text, context: sel.context, refresh: true })}
              >
                重新分析
              </button>
            )}
          </div>

          {result ? (
            <div className="wc-ai">
              {result.meaning !== undefined && (
                <b>
                  <ClickableEn text={result.meaning} context={sel.context} />
                </b>
              )}
              {result.literal_vs_idiomatic !== undefined && (
                <div style={{ marginTop: 6 }}>
                  <ClickableEn text={result.literal_vs_idiomatic} context={sel.context} />
                </div>
              )}
              {Array.isArray(result.usage_scenes) && result.usage_scenes.length > 0 && (
                <div className="phr-scenes">
                  <span className="phr-sub">使用场景</span>
                  <ul>
                    {result.usage_scenes.map((s, i) => (
                      <li key={i}>
                        <ClickableEn text={s} context={sel.context} />
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {result.example?.en !== undefined && (
                <div className="phr-example">
                  <span className="phr-sub">例句</span>
                  <div className="phr-en">
                    <ClickableEn text={result.example.en} />
                  </div>
                  {result.example.zh !== undefined && (
                    <div className="phr-zh">
                      <ClickableEn text={result.example.zh} context={result.example.en} />
                    </div>
                  )}
                </div>
              )}
              {streamingCaret}
              {state.data && (
                <div className="wc-ai-meta">
                  {state.data.cached && <span className="chip">已缓存</span>}
                  <span>
                    {state.data.provider} · {state.data.model}
                  </span>
                </div>
              )}
            </div>
          ) : state.status === 'streaming' ? (
            <div className="wc-muted">
              AI 分析中…<span className="stream-caret" />
            </div>
          ) : state.status === 'error' ? (
            state.gateway ? (
              <div className="wc-muted">AI 网关未配置，暂不可用</div>
            ) : (
              <div className="panel-error">
                分析失败：{state.error}{' '}
                <button
                  className="btn-ghost-sm"
                  onClick={() => stream.start({ phrase: sel.text, context: sel.context })}
                >
                  重试
                </button>
              </div>
            )
          ) : null}
        </div>

        <div className="panel-hint">
          语境：
          <ClickableEn text={sel.context} context={sel.context} />
        </div>
      </div>
    </>
  )
}
