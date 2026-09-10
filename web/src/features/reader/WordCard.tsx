import { Link } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState, type ReactNode } from 'react'

import { IconClose, IconSparkle, IconSpeaker, IconStar, IconVoice } from '../../components/icons'
import { WordVoicePicker } from '../../components/WordVoicePicker'
import { api, ApiError, request } from '../../lib/api'
import type { WordAnalysis } from '../../lib/api'
import type { VocabSource } from '../../lib/api'
import type { AnalyzeDone } from '../../lib/api-reader-m5'
import { playTts } from '../../lib/audio'
import { ClickableEn } from './ClickableEn'
import { VersionsButton } from './VersionsButton'
import { WordBreakdown } from './WordBreakdown'
import { useReaderStore } from './readerStore'
import { useVocabCollectionStore } from '../../lib/vocabCollectionStore'
import type { WordSelection } from './readerStore'
import { ModelPicker } from '@/components/model-picker/ModelPicker'
import { useAnalyzeModel } from './useAnalyzeModel'
import { useStreamAnalyze } from './streaming'
import { GrammarVoiceButton } from '../grammar/GrammarVoice'
import { apiScene, MARK_LABELS, type WordMark } from '../../lib/api-deck'
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from '../../components/ui/dropdown-menu'

/** 外部查词（FR-132）：只放本地词典与 AI 语境释义补不了的三件事——
    真实语料双语例句、权威学习型释义与真人发音、具象词的图像记忆。
    Google/Bing 翻译这类与本地能力重复的一律不放，七个彩色圆点是噪音不是功能。 */
const EXTERNAL_LOOKUPS: Array<{ key: string; label: string; hint: string; url: (w: string) => string }> = [
  {
    key: 'linguee',
    label: 'Linguee',
    hint: '真实语料双语例句',
    url: (w) => `https://www.linguee.com/english-chinese/search?query=${encodeURIComponent(w)}`,
  },
  {
    key: 'cambridge',
    label: 'Cambridge',
    hint: '学习型释义 + 英美真人发音',
    url: (w) =>
      `https://dictionary.cambridge.org/dictionary/english-chinese-simplified/${encodeURIComponent(w)}`,
  },
  {
    key: 'images',
    label: '图片',
    hint: '具象词看图记忆',
    url: (w) => `https://www.google.com/search?tbm=isch&q=${encodeURIComponent(w)}`,
  },
]

const TAG_LABELS: Record<string, string> = {
  zk: '中考',
  gk: '高考',
  cet4: 'CET4',
  cet6: 'CET6',
  ky: '考研',
  toefl: 'TOEFL',
  ielts: 'IELTS',
  gre: 'GRE',
}

function softwareSourceLink(locator: Record<string, string>): string {
  if (locator.library && locator.document) {
    const params = new URLSearchParams({ tab: 'software', software: locator.library, doc: locator.document })
    if (locator.anchor) params.set('anchor', locator.anchor)
    return `/grammar?${params}`
  }
  return `/software-english?${new URLSearchParams(locator)}`
}

/** 从 ECDICT exchange 字段解析原形（"0:xxx" 段） */
function lemmaOf(exchange: string | null | undefined, word: string): string | null {
  if (!exchange) return null
  for (const part of exchange.split('/')) {
    const idx = part.indexOf(':')
    if (idx <= 0) continue
    if (part.slice(0, idx) === '0') {
      const lemma = part.slice(idx + 1)
      return lemma && lemma !== word ? lemma : null
    }
  }
  return null
}

function MultiLine({
  text,
  render,
}: {
  text: string
  render?: (line: string) => ReactNode
}) {
  const lines = text.split('\n').filter((l) => l.trim() !== '')
  return (
    <>
      {lines.map((line, i) => (
        <div key={i}>{render ? render(line) : line}</div>
      ))}
    </>
  )
}

interface WordCardProps {
  sel: WordSelection
  /** 收藏时关联的文章 id；视频等无文章上下文的场景省略 */
  articleId?: number
  /** 视频场景收藏出处（video_id + cue_id，复习卡回跳时间点） */
  videoId?: number
  cueId?: number
  source?: VocabSource
  /** 关闭回调；缺省清全局选择（右栏学习卡用法） */
  onClose?: () => void
  /** 卡内英文可点词：'store' 跟随右栏开关，'force' 恒可点（中央词卡内）；缺省纯文本 */
  clickable?: 'store' | 'force'
}


/* ECDICT 的英文释义来自 WordNet，义项按数据库顺序排，不按常用度——
   simple 的 `n. any herbaceous plant...`（草药，古义）会排在最前面，
   而 pos 字段明写着 j:99/n:1（99% 用作形容词）。这份分布现成的，拿来排序。

   WordNet 的 `s.`（satellite adjective，从属形容词）对学习者是天书，并入 `a.`。 */
const POS_ALIAS: Record<string, string> = { s: 'a', j: 'a' }

function posKey(line: string): string {
  const m = /^([a-z])\.\s/.exec(line.trim())
  const raw = m?.[1] ?? ''
  return POS_ALIAS[raw] ?? raw
}

/** pos 形如 "j:99/n:1" → { a: 99, n: 1 }，数字是该词性的出现占比 */
function posWeights(pos: string | null | undefined): Record<string, number> {
  const out: Record<string, number> = {}
  for (const part of (pos ?? '').split('/')) {
    const [k, v] = part.split(':')
    if (k && v) out[POS_ALIAS[k] ?? k] = Number(v) || 0
  }
  return out
}

const POS_LABEL: Record<string, string> = {
  a: '形容词', n: '名词', v: '动词', r: '副词', d: '限定词',
  i: '介词', c: '连词', p: '代词', u: '感叹词', x: '其他',
}

/** `j:99/n:1` 直接显示是天书，翻成「多作形容词 · 偶作名词」 */
function posSummary(pos: string | null | undefined): string {
  const w = posWeights(pos)
  const parts = Object.entries(w)
    .filter(([k]) => POS_LABEL[k] !== undefined)
    .sort((a, b) => b[1] - a[1])
  if (parts.length === 0) return ''
  return parts
    .map(([k, v], i) => `${i === 0 ? (v >= 80 ? '多作' : '常作') : '偶作'}${POS_LABEL[k]}`)
    .slice(0, 3)
    .join(' · ')
}

/** 常用词性的义项排前面；同词性保持原顺序（稳定排序） */
function sortSenses(text: string, pos: string | null | undefined): string {
  const w = posWeights(pos)
  if (Object.keys(w).length === 0) return text
  const lines = text.split('\n').filter((l) => l.trim() !== '')
  return lines
    .map((line, i) => ({ line, i, weight: w[posKey(line)] ?? 0 }))
    .sort((x, y) => y.weight - x.weight || x.i - y.i)
    .map((x) => x.line.replace(/^s\.\s/, 'a. '))
    .join('\n')
}

export function WordCard({ sel, articleId, videoId, cueId, source, onClose, clickable }: WordCardProps) {
  const queryClient = useQueryClient()
  const collected = useVocabCollectionStore((state) => state.collected)
  const addCollected = useVocabCollectionStore((state) => state.addCollected)
  const setCollectedStatus = useVocabCollectionStore((state) => state.setCollectedStatus)
  const clearSelection = useReaderStore((s) => s.clearSelection)
  const [voiceOpen, setVoiceOpen] = useState(false)

  const dictQuery = useQuery({
    queryKey: ['dict', sel.word],
    queryFn: () => api.dict(sel.word),
    retry: false,
    staleTime: Infinity,
  })
  const collectionQuery = useQuery({
    queryKey: ['vocab-status', sel.word],
    queryFn: () => api.vocabStatus([sel.word]),
    staleTime: 30_000,
  })
  const learning = useQuery({
    queryKey: ['word-stage', sel.word],
    queryFn: () => request<{ stages: Record<string, string> }>(`/api/vocab/status?words=${encodeURIComponent(sel.word)}`),
    refetchInterval: 3000,
  })
  const mark = useMutation({
    mutationFn: (value: WordMark) => apiScene.mark([sel.word], value),
    onSuccess: async () => {
      await Promise.all(['word-stage', 'deck-words', 'deck-words-all', 'deck-scenes', 'decks', 'vocab-overview'].map(key =>
        queryClient.invalidateQueries({ queryKey: [key] })))
    },
  })
  useEffect(() => {
    if (collectionQuery.data) {
      setCollectedStatus(sel.word, collectionQuery.data.collected.includes(sel.word))
    }
  }, [collectionQuery.data, sel.word, setCollectedStatus])

  const isCollected = collected.has(sel.word)
  const softwareSources = useQuery({
    queryKey: ['vocab-software-sources', sel.word],
    queryFn: () => request<{ items: Array<{ id: number; label: string; locator: Record<string, string>; context: string }> }>(`/api/vocab/software-sources?word=${encodeURIComponent(sel.word)}`),
    enabled: isCollected,
    staleTime: 30_000,
  })
  const model = useAnalyzeModel('explain-standard')
  const cacheKey = JSON.stringify([sel.word, sel.sentenceText, model.deploymentId])
  const cachedQuery = useQuery({
    queryKey: ['word-analysis-cache', cacheKey],
    enabled: !model.loading,
    queryFn: () => request<AnalyzeDone<WordAnalysis> | { result: null; cached: false }>('/api/analyze/word?cached_only=true', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ word: sel.word, context: sel.sentenceText, deployment_id: model.deploymentId }),
    }),
    retry: false,
  })
  // AI 语境释义走 SSE 流式：delta 打字机，done 结构化落定
  const stream = useStreamAnalyze<WordAnalysis>('word', (data) => queryClient.setQueryData(['word-analysis-cache', cacheKey], data))
  const cached = cachedQuery.data?.result ? cachedQuery.data : null
  const analysis = stream.state.data ?? (stream.state.status === 'idle' ? (cached ?? null) : null)
  const partial = stream.state.status === 'streaming' ? stream.state.partial : null
  const streaming = stream.state.status === 'streaming'

  // 「这次用哪个模型」只在本次调用生效，不改设置里的绑定
  const runAnalyze = (refresh: boolean, deploymentId = model.deploymentId) =>
    stream.start({
      word: sel.word,
      context: sel.sentenceText,
      ...(refresh ? { refresh: true } : {}),
      ...(deploymentId === null ? {} : { deployment_id: deploymentId }),
    })

  const softwareSourceKey = JSON.stringify([sel.word, source?.locator])
  const [savedSoftwareSource, setSavedSoftwareSource] = useState('')
  const softwareSourceSaved = savedSoftwareSource === softwareSourceKey || !!softwareSources.data?.items.some(item =>
    ['collection', 'page', 'capture', 'entry'].every(key => item.locator[key] === source?.locator?.[key]))
  const collect = useMutation({
    mutationFn: () =>
      api.collectVocab({
        word: sel.word,
        ...(articleId !== undefined ? { article_id: articleId } : {}),
        ...(sel.sentenceId !== null ? { sentence_id: sel.sentenceId } : {}),
        ...(videoId !== undefined ? { video_id: videoId } : {}),
        ...(cueId !== undefined ? { cue_id: cueId } : {}),
        context_text: sel.sentenceText,
        source: source ?? (videoId !== undefined
          ? { kind: 'video', locator: { video_id: videoId, ...(cueId !== undefined ? { cue_id: cueId } : {}) } }
          : articleId !== undefined
            ? { kind: 'reader', locator: { article_id: articleId, ...(sel.sentenceId !== null ? { sentence_id: sel.sentenceId } : {}) } }
            : { kind: 'manual' }),
      }),
    onSuccess: () => {
      if (source?.kind === 'software') setSavedSoftwareSource(softwareSourceKey)
      addCollected(sel.word)
      queryClient.setQueryData(['vocab-status', sel.word], { collected: [sel.word] })
      void queryClient.invalidateQueries({ queryKey: ['vocab-overview'] })
      void queryClient.invalidateQueries({ queryKey: ['vocab-software-sources', sel.word] })
    },
  })

  const dict = dictQuery.data
  const dictMissing =
    dictQuery.error instanceof ApiError && dictQuery.error.status === 404
  const lemma = lemmaOf(dict?.exchange, sel.word)

  const chips: string[] = []
  if (dict?.tags?.length) {
    for (const tag of dict.tags) {
      chips.push(TAG_LABELS[tag] ?? tag.toUpperCase())
    }
  }
  if (dict?.collins) chips.push(`柯林斯 ${'★'.repeat(Math.min(dict.collins, 5))}`)

  const gatewayMissing = stream.state.status === 'error' && stream.state.gateway
  const analyzeErrorMsg =
    stream.state.status === 'error' && !stream.state.gateway ? stream.state.error : null

  const shown = analysis?.result ?? partial

  // 卡内英文词元化：语境统一传该词所在句
  const en = (text: string): ReactNode =>
    clickable !== undefined ? (
      <ClickableEn text={text} context={sel.sentenceText} force={clickable === 'force'} />
    ) : (
      text
    )

  return (
    <>
      <div className="wc-head">
        {/* 单词+音标+喇叭整块即朗读热区：查词就是想听音，喇叭只作视觉提示
            （欧路 / Google Dictionary / Kindle 同范式） */}
        <div
          className="wc-say"
          role="button"
          tabIndex={0}
          title="点击朗读"
          onClick={() => {
            // 拖选复制单词时不该顺带朗读
            if ((window.getSelection()?.toString() ?? '').trim() !== '') return
            playTts(sel.surface, 'word')
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault()
              playTts(sel.surface, 'word')
            }
          }}
        >
          <div className="wc-word">
            {sel.surface}
            <IconSpeaker />
          </div>
          <div className="wc-phon">
            {dict?.phonetic ? `/${dict.phonetic}/` : null}
            {lemma && <span className="wc-lemma">原形 {lemma}</span>}
          </div>
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button className={`wc-stage ${learning.data?.stages[sel.word] ?? 'unseen'}`} disabled={mark.isPending || learning.isPending}
              aria-label="切换学习状态">
              {mark.isPending ? '保存中' : learning.isPending ? '读取中' : learning.isError ? '读取失败' : ({ unseen: '未学', learning: '学习中', tested: '学习中', hard: '困难词', mastered: '已掌握' }[learning.data?.stages[sel.word] ?? 'unseen'])}
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="wc-stage-menu" onEscapeKeyDown={event => event.stopPropagation()}>
            {(['learning', 'hard', 'mastered'] as const).map(value => <DropdownMenuItem key={value}
              onSelect={() => mark.mutate(value)}>{MARK_LABELS[value]}</DropdownMenuItem>)}
          </DropdownMenuContent>
        </DropdownMenu>
        <button
          className="icon-btn wc-voice"
          title="换个声音：只换这一个词的发音"
          onClick={() => setVoiceOpen(true)}
        >
          <IconVoice />
        </button>
        <button className="icon-btn wc-close" title="关闭" onClick={onClose ?? clearSelection}>
          <IconClose />
        </button>
      </div>
      {voiceOpen && <WordVoicePicker word={sel.surface} onClose={() => setVoiceOpen(false)} />}
      {mark.error && <p className="wc-sec" role="alert">{mark.error.message}</p>}

      {chips.length > 0 && (
        <div className="wc-chips">
          {chips.map((c) => (
            <span key={c} className="chip">
              {c}
            </span>
          ))}
        </div>
      )}

      <div className="wc-sec">
        <div className="wc-label">
          词典释义
          {dict?.source && (
            <span className="re" style={{ color: 'var(--ink-faint)' }}>
              {dict.source}
            </span>
          )}
        </div>
        {dictQuery.isPending && (
          <>
            <div className="skeleton skeleton-line" style={{ width: '90%' }} />
            <div className="skeleton skeleton-line" style={{ width: '65%', marginTop: 6 }} />
          </>
        )}
        {dictMissing && <div className="wc-muted">本地词典未收录</div>}
        {dictQuery.isError && !dictMissing && (
          <div className="panel-error">词典查询失败：{(dictQuery.error as Error).message}</div>
        )}
        {dict && (
          <div className="wc-def">
            {dict.pos && posSummary(dict.pos) !== '' && (
              <span className="pos" title={`词性分布 ${dict.pos}`}>
                {posSummary(dict.pos)}
              </span>
            )}
            {dict.translation ? <MultiLine text={dict.translation} render={en} /> : null}
            {dict.definition && (
              <div className="wc-def-en">
                {/* 加标签与中文释义区分（FR-364）：两份数据挤在同一个"词典释义"下看不出差别 */}
                <div className="wc-def-en-label">英文释义</div>
                <MultiLine text={sortSenses(dict.definition, dict.pos)} render={en} />
              </div>
            )}
          </div>
        )}
      </div>

      {/* 拆开记（FR-321~329）：音节离线即时，词素按需 AI + 缓存 */}
      <WordBreakdown word={lemma ?? sel.surface} />

      <div className="wc-sec">
        <div className="wc-label">
          <IconSparkle />
          AI 语境释义
          <GrammarVoiceButton sentence={sel.sentenceText || sel.word}
            analysis={analysis?.result ? { word: sel.word, ...analysis.result } : undefined} source="单词卡片语境与语法" />
          {analysis && (
            <VersionsButton<WordAnalysis>
              scope="word"
              kind="word_explain"
              content={sel.word}
              context={sel.sentenceText}
              version={analysis.version}
              onActivated={(d) => {
                queryClient.setQueryData(['word-analysis-cache', cacheKey], d)
                stream.settle(d)
              }}
            />
          )}
          {analysis && (
            <button
              className="btn-ghost-sm re"
              disabled={streaming}
              onClick={() => runAnalyze(true)}
            >
              重新分析
            </button>
          )}
        </div>

        <ModelPicker
          open={model.open}
          onClose={() => model.setOpen(false)}
          options={model.options}
          value={model.deploymentId}
          usage="这次分析"
          onPick={(deployment) => {
            model.pin(deployment.id)
            runAnalyze(false, deployment.id)
          }}
          followDefault={{
            modelName: model.boundModel,
            active: model.deploymentId === null,
            onFollow: () => {
              model.pin(null)
              runAnalyze(false, null)
            },
          }}
        />
        {shown ? (
          <div className="wc-ai">
            {shown.context_meaning !== undefined && <b>{en(shown.context_meaning)}</b>}
            {shown.pos_in_context !== undefined &&
              shown.pos_in_context !== '' &&
              `（${shown.pos_in_context}）`}
            {shown.phonetic_in_context !== undefined && shown.phonetic_in_context !== '' && (
              <span className="wc-ai-phon" title="该词在本句语境下的读法（多音词按语境判）">
                /{shown.phonetic_in_context.replace(/^\/|\/$/g, '')}/
              </span>
            )}
            {shown.explanation !== undefined && (
              <div style={{ marginTop: 6 }}>{en(shown.explanation)}</div>
            )}
            {shown.memory_hint !== undefined && shown.memory_hint !== '' && (
              <div className="wc-hint">记忆提示：{en(shown.memory_hint)}</div>
            )}
            {streaming && <span className="stream-caret" />}
            {analysis && (
              <div className="wc-ai-meta">
                {analysis.cached && <span className="chip">已缓存</span>}
                {/* 「模型」位只放上游真名，能力以中文露出（核心原则 6）。
                    analysis.provider 是 `llm:explain-standard` 这种路由键，不能摆到用户眼前 */}
                <button
                  className="wc-ai-model"
                  title="换个模型重新分析，只影响这一次，不改设置里的绑定"
                  onClick={() => model.setOpen(true)}
                >
                  {model.label} · {analysis.model}
                </button>
                {model.pinned && <span className="chip">临时换的</span>}
              </div>
            )}
          </div>
        ) : streaming ? (
          <div className="wc-muted">
            AI 分析中…<span className="stream-caret" />
          </div>
        ) : gatewayMissing ? (
          <div className="wc-muted">AI 网关未配置，暂不可用</div>
        ) : analyzeErrorMsg !== null ? (
          <div className="panel-error">
            分析失败：{analyzeErrorMsg}{' '}
            <button className="btn-ghost-sm" onClick={() => runAnalyze(false)}>
              重试
            </button>
          </div>
        ) : (
          <button className="btn btn-soft btn-sm" onClick={() => runAnalyze(false)}>
            <IconSparkle />
            AI 解释
          </button>
        )}
      </div>

      {source?.kind === 'software' && source.locator && (
        <div className="wc-section">
          <Link to={softwareSourceLink(Object.fromEntries(Object.entries(source.locator).map(([key, value]) => [key, String(value)])))} onClick={onClose}>
            返回出处：{source.label ?? '软件界面原句'}
          </Link>
        </div>
      )}
      {!!softwareSources.data?.items.length && <details className="wc-section">
        <summary>软件中的用法 · {softwareSources.data.items.length}</summary>
        {softwareSources.data.items.map(item => <p key={item.id}>
          <Link to={softwareSourceLink(item.locator)} onClick={onClose}>{item.label || '返回软件页面'}</Link>
          <small className="wc-muted">{item.context}</small>
        </p>)}
      </details>}
      <div className="wc-foot">
        <button
          className={`btn${isCollected ? ' btn-soft' : ''}`}
          disabled={collect.isPending || (isCollected && (source?.kind !== 'software' || softwareSourceSaved))}
          onClick={() => collect.mutate()}
        >
          <IconStar filled={isCollected} />
          {collect.isPending ? '收藏中…' : source?.kind === 'software' ? (softwareSourceSaved ? '已收藏此处用法' : '收藏此处用法') : isCollected ? '已收藏' : '收藏'}
        </button>
        {collect.isError && (
          <span className="panel-error" style={{ fontSize: 'var(--text-xs)' }}>
            收藏失败
          </span>
        )}
        <div className="spacer" />
        <div className="wc-links">
          {EXTERNAL_LOOKUPS.map((x) => (
            <a
              key={x.key}
              className="wc-link"
              href={x.url(sel.word)}
              target="_blank"
              rel="noreferrer noopener"
              title={x.hint}
            >
              {x.label}
            </a>
          ))}
        </div>
      </div>
    </>
  )
}
