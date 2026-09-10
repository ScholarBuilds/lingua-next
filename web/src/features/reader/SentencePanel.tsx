import { useMemo, useState } from 'react'
import { GrammarVoiceButton } from '../grammar/GrammarVoice'
import { toast } from 'sonner'

import { IconClose, IconSparkle, IconSpeaker } from '../../components/icons'
import { SendToSentenceLab } from '@/components/SendToSentenceLab'
import { Picker } from '@/components/ui/picker'
import type { GrammarAnalysis, TranslateEngine } from '../../lib/api'
import type { AnalyzeDone, SentenceDeepResult, TranslateStreamDone } from '../../lib/api-reader-m5'
import { playTts } from '../../lib/audio'
import { askAboutSentence } from '../companion/askAi'
import { ClickableEn } from './ClickableEn'
import { VersionsButton } from './VersionsButton'
import { useReaderStore } from './readerStore'
import { layoutComponents, sliceRange, topParts, walkRoles } from './grammarTree'
import { normalizeRole, roleClass, roleNote, ROLE_COLOR } from './grammarRole'
import type { GramRole } from './grammarRole'
import type { SentenceSelection } from './readerStore'
import { useStreamAnalyze, useTranslateStream } from './streaming'

/* 会话级缓存：同一句重开面板直接展示上次结果 */
const transCache = new Map<string, TranslateStreamDone>()
const gramCache = new Map<string, AnalyzeDone<GrammarAnalysis>>()
const deepCache = new Map<string, AnalyzeDone<SentenceDeepResult>>()

const ENGINES: Array<{ value: TranslateEngine; label: string }> = [
  { value: 'auto', label: '自动' },
  { value: 'bing', label: 'Bing' },
  { value: 'google', label: 'Google' },
  { value: 'llm', label: 'LLM' },
]

/* 成分块的悬停说明：角色收敛成枚举后，模型原来写在 role 里的那半解释
   （「后置定语，修饰 ladies」）不能丢，挂到 title 上 */
function roleTitle(node: { role: string; note?: string }): string {
  const note = roleNote(node.role, node.note)
  const r = normalizeRole(node.role)
  return note === '' ? r : `${r} · ${note}`
}

type SentTab = 'analysis' | 'deep'

export function SentencePanel(props: Parameters<typeof SentencePanelContent>[0]) {
  return <SentencePanelContent key={props.sel.hash} {...props} />
}

function SentencePanelContent({
  sel,
  onAskAi,
  onClose,
  transContext,
}: {
  sel: SentenceSelection
  /* 关闭这一层。不传时退回阅读器语义（清掉选区）——
     词库的例句语法浮层没有「阅读器选区」这回事，
     不接的话那个 ✕ 点了什么都不会发生，是个死按钮。 */
  onClose?: () => void
  /** 问 AI 后切到陪读面板 */
  onAskAi?: () => void
  /** 素材背景（书名/篇名），让翻译按语境选词 */
  transContext?: string
}) {
  const clearSelection = useReaderStore((s) => s.clearSelection)
  const [tab, setTab] = useState<SentTab>('analysis')
  const [engine, setEngine] = useState<TranslateEngine>('auto')

  // 翻译走 SSE 流式：delta 打字机 → done 落定 engine 与缓存标注
  const transStream = useTranslateStream((d) => transCache.set(sel.hash, d))
  const trans =
    transStream.state.data ??
    (transStream.state.status === 'idle' ? (transCache.get(sel.hash) ?? null) : null)
  const transPartial =
    transStream.state.status === 'streaming' ? transStream.state.text : null
  const runTranslate = (refresh: boolean) =>
    transStream.start({
      text: sel.text,
      engine,
      ...(transContext ? { context: transContext } : {}),
      ...(refresh ? { refresh: true } : {}),
    })

  // 语法分析 / 精讲均走 SSE 流式（M5）
  const gramStream = useStreamAnalyze<GrammarAnalysis>('grammar', (d) =>
    gramCache.set(sel.hash, d),
  )
  const deepStream = useStreamAnalyze<SentenceDeepResult>('sentence_deep', (d) =>
    deepCache.set(sel.hash, d),
  )

  const gram =
    gramStream.state.data ??
    (gramStream.state.status === 'idle' ? (gramCache.get(sel.hash) ?? null) : null)
  const gramPartial =
    gramStream.state.status === 'streaming' ? gramStream.state.partial : null
  const deep =
    deepStream.state.data ??
    (deepStream.state.status === 'idle' ? (deepCache.get(sel.hash) ?? null) : null)
  const deepPartial =
    deepStream.state.status === 'streaming' ? deepStream.state.partial : null

  const runGrammar = (refresh: boolean) =>
    gramStream.start({ sentence: sel.text, ...(refresh ? { refresh: true } : {}) })
  const runDeep = (refresh: boolean) =>
    deepStream.start({ sentence: sel.text, ...(refresh ? { refresh: true } : {}) })

  const gramShown = gram?.result ?? gramPartial
  const deepShown = deep?.result ?? deepPartial

  /* `components` 是一棵先序拍平的树，还原后再渲染（见 grammarTree.ts）。
     直接按列表平铺会让分句和它内部的成分各出现一次，整句重复两遍。 */
  const gramTree = useMemo(
    () => layoutComponents(sel.text, gramShown?.components),
    [sel.text, gramShown?.components],
  )
  /* 图例按**枚举**去重：原先按原始 role 串去重，模型 108 个成分能吐 70 种串，
     图例跟着列一长条，颜色还按下标轮换。收敛后固定不超过 9 条，且色↔角色恒定。 */
  const roleLegend: Array<{ role: GramRole; color: string }> = []
  {
    const seen = new Set<GramRole>()
    for (const n of walkRoles(gramTree)) {
      const r = normalizeRole(n.role)
      if (!seen.has(r)) {
        seen.add(r)
        roleLegend.push({ role: r, color: ROLE_COLOR[r] })
      }
    }
  }

  return (
    <>
      <div className="panel-head sentence-analysis-head">
        <h3>当前句</h3>
        <div className="seg sent-tabs">
          <button
            className={tab === 'analysis' ? 'active' : undefined}
            onClick={() => setTab('analysis')}
          >
            解析
          </button>
          <button className={tab === 'deep' ? 'active' : undefined} onClick={() => setTab('deep')}>
            精讲
          </button>
        </div>
        <div style={{ flex: 1 }} />
        <GrammarVoiceButton sentence={sel.text} analysis={tab === 'analysis' ? gram?.result : deep?.result}
          source={transContext ? `${transContext} · ${tab === 'analysis' ? '语法分析' : '句子精讲'}` : tab === 'analysis' ? '句子语法分析' : '句子精讲'} />
        {onAskAi && <button
          className="icon-btn"
          title="把这句交给 AI 陪读讲解"
          onClick={() => {
            askAboutSentence({ id: sel.sentenceId ?? sel.text, text: sel.text })
            onAskAi?.()
            toast.success('已加入陪读上下文')
          }}
        >
          <IconSparkle />
        </button>}
        <button className="icon-btn" title="朗读本句" onClick={() => playTts(sel.text)}>
          <IconSpeaker />
        </button>
        <button className="icon-btn" title="关闭" onClick={onClose ?? clearSelection}>
          <IconClose />
        </button>
      </div>

      <div className="panel-body">
        <SendToSentenceLab text={sel.text} />
        <div className="p-sent">
          <ClickableEn text={sel.text} context={sel.text} />
        </div>

        {tab === 'analysis' && (
          <>
            {/* 翻译 */}
            <div>
              <div className="wc-label" style={{ marginBottom: 8 }}>
                翻译
                <span className="re">
                  <Picker
                    size="sm"
                    className="engine-select"
                    value={engine}
                    onChange={(v) => setEngine(v as TranslateEngine)}
                    options={ENGINES.map((eg) => ({ value: eg.value, label: eg.label }))}
                  />
                </span>
              </div>

              {trans ? (
                <div className="p-trans">
                  <ClickableEn text={trans.result.text} context={sel.text} />
                  <div className="src">
                    <span>
                      {trans.result.engine}
                      {trans.cached ? ' · 已缓存' : ''}
                    </span>
                    <button className="btn-ghost-sm" onClick={() => runTranslate(true)}>
                      重新翻译
                    </button>
                  </div>
                </div>
              ) : transPartial !== null ? (
                <div className="p-trans">
                  {transPartial === '' ? (
                    '翻译中…'
                  ) : (
                    <ClickableEn text={transPartial} context={sel.text} />
                  )}
                  <span className="stream-caret" />
                </div>
              ) : transStream.state.status === 'error' ? (
                transStream.state.gateway ? (
                  <div className="panel-hint">AI 网关未配置，暂不可用</div>
                ) : (
                  <div className="panel-error">
                    翻译失败：{transStream.state.error}{' '}
                    <button className="btn-ghost-sm" onClick={() => runTranslate(false)}>
                      重试
                    </button>
                  </div>
                )
              ) : (
                <button className="btn btn-soft btn-sm" onClick={() => runTranslate(false)}>
                  翻译
                </button>
              )}
            </div>

            {/* 语法分析（流式） */}
            <div>
              <div className="wc-label" style={{ marginBottom: 8 }}>
                <IconSparkle />
                语法分析
                {gram && (
                  <VersionsButton<GrammarAnalysis>
                    scope="sentence"
                    kind="grammar"
                    content={sel.text}
                    version={gram.version}
                    onActivated={(d) => {
                      gramCache.set(sel.hash, d)
                      gramStream.settle(d)
                    }}
                  />
                )}
                {gram && (
                  <button
                    className="btn-ghost-sm re"
                    disabled={gramStream.state.status === 'streaming'}
                    onClick={() => runGrammar(true)}
                  >
                    重新分析
                  </button>
                )}
              </div>

              {gramShown ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  {gramShown.translation !== undefined && gramShown.translation !== '' && (
                    <div className="p-trans">
                      <ClickableEn text={gramShown.translation} context={sel.text} />
                      {gram && (
                        <div className="src">
                          <span>语法分析{gram.cached ? ' · 已缓存' : ''}</span>
                        </div>
                      )}
                    </div>
                  )}
                  {gramTree.length > 0 ? (
                    <>
                      <div className="gram-core">
                        {topParts(sel.text, gramTree).map((part, i) =>
                          part.node === null ? (
                            <ClickableEn key={i} text={part.text} context={sel.text} />
                          ) : part.node.children.length === 0 ? (
                            <span
                              key={i}
                              className={`gr ${roleClass(part.node.role)}`}
                              title={roleTitle(part.node)}
                            >
                              <ClickableEn text={part.text} context={sel.text} />
                            </span>
                          ) : (
                            /* 带下级的成分（分句一类）：自己只画一条底线标出范围，
                               内部由下级各自着色。父子都填色会糊成一团，
                               也会让人以为是两段不同的文字 */
                            <span
                              key={i}
                              className={`gr-wrap ${roleClass(part.node.role)}`}
                              title={roleTitle(part.node)}
                            >
                              {sliceRange(
                                sel.text,
                                part.node.start,
                                part.node.end,
                                part.node.children,
                              ).map((sub, j) =>
                                sub.node === null ? (
                                  <ClickableEn key={j} text={sub.text} context={sel.text} />
                                ) : (
                                  <span
                                    key={j}
                                    className={`gr ${roleClass(sub.node.role)}`}
                                    title={roleTitle(sub.node)}
                                  >
                                    <ClickableEn text={sub.text} context={sel.text} />
                                  </span>
                                ),
                              )}
                            </span>
                          ),
                        )}
                      </div>
                      <div className="legend">
                        {roleLegend.map(({ role, color }) => (
                          <span key={role}>
                            <i style={{ background: color }} />
                            {role}
                          </span>
                        ))}
                      </div>
                    </>
                  ) : (
                    gramShown.backbone !== undefined &&
                    gramShown.backbone !== '' && (
                      <div className="gram-core">
                        <ClickableEn text={gramShown.backbone} context={sel.text} />
                      </div>
                    )
                  )}
                  {gramShown.quick !== undefined && gramShown.quick !== '' && (
                    <div className="gram-note">
                      <b>快速理解</b>：<ClickableEn text={gramShown.quick} context={sel.text} />
                    </div>
                  )}
                  {gramShown.tenses !== undefined && gramShown.tenses !== '' && (
                    <div className="gram-note">
                      <b>时态</b>：<ClickableEn text={gramShown.tenses} context={sel.text} />
                    </div>
                  )}
                  {gramShown.difficulty_note !== undefined && gramShown.difficulty_note !== '' && (
                    <div className="gram-note">
                      <b>难点</b>：
                      <ClickableEn text={gramShown.difficulty_note} context={sel.text} />
                    </div>
                  )}
                  {gramStream.state.status === 'streaming' && <span className="stream-caret" />}
                </div>
              ) : gramStream.state.status === 'streaming' ? (
                <div className="panel-hint">
                  分析中…<span className="stream-caret" />
                </div>
              ) : gramStream.state.status === 'error' ? (
                gramStream.state.gateway ? (
                  <div className="panel-hint">AI 网关未配置，暂不可用</div>
                ) : (
                  <div className="panel-error">
                    分析失败：{gramStream.state.error}{' '}
                    <button className="btn-ghost-sm" onClick={() => runGrammar(false)}>
                      重试
                    </button>
                  </div>
                )
              ) : (
                <button className="btn btn-soft btn-sm" onClick={() => runGrammar(false)}>
                  <IconSparkle />
                  语法分析
                </button>
              )}
            </div>

            <div style={{ display: 'flex', gap: 6 }}>
              <button
                className="btn btn-soft"
                style={{ flex: 1, justifyContent: 'center' }}
                onClick={() => playTts(sel.text)}
              >
                <IconSpeaker />
                朗读本句
              </button>
            </div>
          </>
        )}

        {tab === 'deep' && (
          <div>
            <div className="wc-label" style={{ marginBottom: 8 }}>
              <IconSparkle />
              句子精讲
              {deep && (
                <VersionsButton<SentenceDeepResult>
                  scope="sentence"
                  kind="sentence_deep"
                  content={sel.text}
                  version={deep.version}
                  onActivated={(d) => {
                    deepCache.set(sel.hash, d)
                    deepStream.settle(d)
                  }}
                />
              )}
              {deep && (
                <button
                  className="btn-ghost-sm re"
                  disabled={deepStream.state.status === 'streaming'}
                  onClick={() => runDeep(true)}
                >
                  重新分析
                </button>
              )}
            </div>

            {deepShown ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                {deepShown.translation !== undefined && deepShown.translation !== '' && (
                  <div className="p-trans">
                    <ClickableEn text={deepShown.translation} context={sel.text} />
                  </div>
                )}
                {deepShown.chunks !== undefined && deepShown.chunks.length > 0 && (
                  <div className="deep-chunks">
                    {deepShown.chunks.map((c, i) =>
                      c?.en !== undefined ? (
                        <div className="deep-chunk" key={i}>
                          <div className="deep-en">
                            <ClickableEn text={c.en} context={sel.text} />
                          </div>
                          <div className="deep-zh">
                            <ClickableEn text={c.zh ?? ''} context={sel.text} />
                          </div>
                        </div>
                      ) : null,
                    )}
                  </div>
                )}
                {deepShown.collocations !== undefined && deepShown.collocations.length > 0 && (
                  <div>
                    <div className="deep-sub">值得积累的搭配</div>
                    <div className="deep-colls">
                      {deepShown.collocations.map((c, i) =>
                        c?.phrase !== undefined ? (
                          <div className="deep-coll" key={i}>
                            <b>
                              <ClickableEn text={c.phrase} context={sel.text} />
                            </b>
                            <span>
                              <ClickableEn text={c.meaning ?? ''} context={sel.text} />
                            </span>
                          </div>
                        ) : null,
                      )}
                    </div>
                  </div>
                )}
                {deepShown.structure_note !== undefined && deepShown.structure_note !== '' && (
                  <div className="gram-note">
                    <b>结构</b>：<ClickableEn text={deepShown.structure_note} context={sel.text} />
                  </div>
                )}
                {deepShown.culture_note !== undefined && deepShown.culture_note !== '' && (
                  <div className="gram-note">
                    <b>文化背景</b>：
                    <ClickableEn text={deepShown.culture_note} context={sel.text} />
                  </div>
                )}
                {deepStream.state.status === 'streaming' && <span className="stream-caret" />}
                {deep && (
                  <div className="wc-ai-meta" style={{ marginTop: 0 }}>
                    {deep.cached && <span className="chip">已缓存</span>}
                    <span>
                      {deep.provider} · {deep.model}
                    </span>
                  </div>
                )}
              </div>
            ) : deepStream.state.status === 'streaming' ? (
              <div className="panel-hint">
                逐块拆解中…<span className="stream-caret" />
              </div>
            ) : deepStream.state.status === 'error' ? (
              deepStream.state.gateway ? (
                <div className="panel-hint">AI 网关未配置，暂不可用</div>
              ) : (
                <div className="panel-error">
                  精讲失败：{deepStream.state.error}{' '}
                  <button className="btn-ghost-sm" onClick={() => runDeep(false)}>
                    重试
                  </button>
                </div>
              )
            ) : (
              <button className="btn btn-soft btn-sm" onClick={() => runDeep(false)}>
                <IconSparkle />
                开始精讲
              </button>
            )}
          </div>
        )}
      </div>
    </>
  )
}
