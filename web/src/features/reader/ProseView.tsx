import { Fragment, useMemo } from 'react'
import type { ReactNode } from 'react'

import { IconPause, IconPlay } from '../../components/icons'
import type { Article, Paragraph, Token } from '../../lib/api'
import type { Annotation } from '../../lib/api-reader-m5'
import { playTts } from '../../lib/audio'
import { usePlayerStore } from './playerStore'
import { useReaderStore } from './readerStore'
import type { ViewMode } from './readerStore'
import { useVocabCollectionStore } from '../../lib/vocabCollectionStore'

interface ProseViewProps {
  article: Article
  mode: ViewMode
  /** sentenceId(字符串键) → 中文译文 */
  translations: Record<string, string>
  /** 本文批注（M5），按段落区间切 span 渲染底色 */
  annotations?: Annotation[]
  onAnnotationClick?: (annotation: Annotation, el: HTMLElement) => void
  /** 章内搜索命中区间：paragraphId → [[start, end]...]（FR-376） */
  searchMarks?: Map<number, Array<[number, number]>>
  /** 已插书签的段落 id（FR-377），段首挂旗标 */
  bookmarked?: Set<number>
  /** 生词小译（FR-381）：词元小写 → 极短中文，只给已收藏的生词挂 */
  gloss?: Record<string, string>
}

export function ProseView({
  article,
  mode,
  translations,
  annotations,
  onAnnotationClick,
  searchMarks,
  bookmarked,
  gloss,
}: ProseViewProps) {
  const first = article.paragraphs[0]
  // 首段若是与文章标题相同的 heading，跳过以免与顶部大标题重复
  const skipFirstHeading =
    first !== undefined &&
    first.kind === 'heading' &&
    first.text.trim() === article.title.trim()

  return (
    <div className="prose">
      {article.paragraphs.map((p, i) =>
        i === 0 && skipFirstHeading ? null : (
          <ParagraphView
            key={p.id}
            para={p}
            mode={mode}
            translations={translations}
            annotations={annotations}
            onAnnotationClick={onAnnotationClick}
            marks={searchMarks?.get(p.id)}
            bookmarked={bookmarked?.has(p.id) ?? false}
            gloss={gloss}
          />
        ),
      )}
    </div>
  )
}

/** 译文骨架宽度：按原句长度估算，夹在 18%-96% */
function skeletonWidth(len: number): string {
  return `${Math.max(18, Math.min(96, Math.round(len * 0.42)))}%`
}

interface ParagraphViewProps {
  para: Paragraph
  mode: ViewMode
  translations: Record<string, string>
  annotations?: Annotation[]
  onAnnotationClick?: (annotation: Annotation, el: HTMLElement) => void
  /** 本段的搜索命中区间 */
  marks?: Array<[number, number]>
  bookmarked?: boolean
  gloss?: Record<string, string>
}

function ParagraphView({
  para,
  mode,
  translations,
  annotations,
  onAnnotationClick,
  marks,
  bookmarked = false,
  gloss,
}: ParagraphViewProps) {
  const selection = useReaderStore((s) => s.selection)
  const collected = useVocabCollectionStore((state) => state.collected)
  const selectWord = useReaderStore((s) => s.selectWord)
  const selectSentence = useReaderStore((s) => s.selectSentence)
  // 整章连读的当前句（含暂停态），驱动 .s-reading 高亮
  const readingSentenceId = usePlayerStore((s) => {
    const cur = s.sentences[s.index]
    return s.status !== 'idle' && cur !== undefined && cur.paragraphId === para.id
      ? cur.sentenceId
      : null
  })
  // 正在出声的句子（不含暂停态），驱动句末按钮的暂停态图标
  const playingSentenceId = usePlayerStore((s) => {
    const cur = s.sentences[s.index]
    return s.status === 'playing' && cur !== undefined && cur.paragraphId === para.id
      ? cur.sentenceId
      : null
  })

  const tokens = useMemo(
    () => [...para.tokens].sort((a, b) => a[0] - b[0]),
    [para.tokens],
  )
  const sentences = useMemo(
    () => [...para.sentences].sort((a, b) => a[1] - b[1]),
    [para.sentences],
  )
  // 本段批注，起点排序；重叠区间渲染时取最新（id 大）的一条
  const paraAnnotations = useMemo(
    () =>
      (annotations ?? [])
        .filter((a) => a.paragraph_id === para.id)
        .sort((a, b) => a.char_start - b.char_start),
    [annotations, para.id],
  )

  const selectedStart =
    selection?.kind === 'word' && selection.word.paragraphId === para.id
      ? selection.word.start
      : -1
  const selectedSentenceId =
    selection?.kind === 'sentence' && selection.sentence.paragraphId === para.id
      ? selection.sentence.sentenceId
      : null

  const handleWordClick = (token: Token) => {
    // 拖选松开落在词元上时不当作点词（选区交给批注/词组工具条）
    const winSel = window.getSelection()
    if (winSel !== null && !winSel.isCollapsed) return
    const [start, end, lower] = token
    const surface = para.text.slice(start, end)
    const sent = sentences.find(([, cs, ce]) => start >= cs && start < ce) ?? null
    selectWord({
      word: lower,
      surface,
      paragraphId: para.id,
      start,
      end,
      sentenceId: sent ? sent[0] : null,
      sentenceHash: sent ? sent[3] : null,
      sentenceText: sent ? para.text.slice(sent[1], sent[2]) : para.text,
    })
    playTts(surface, 'word')
  }

  /** 把 [from, to) 区间按词元切成 span，非词元文本原样输出。
      批注边界可能落在词元中间：surface 按区间裁剪，避免半个词元被重复渲染 */
  const renderRange = (from: number, to: number, keyPrefix: string): ReactNode[] => {
    const out: ReactNode[] = []
    let pos = from
    for (const token of tokens) {
      const [start, end, lower, learnable] = token
      if (end <= from) continue
      if (start >= to) break
      if (start > pos) out.push(para.text.slice(Math.max(pos, from), start))
      const surface = para.text.slice(Math.max(start, from), Math.min(end, to))
      if (learnable) {
        const cls = [
          'w',
          collected.has(lower) ? 'vocab' : '',
          selectedStart === start ? 'w-selected' : '',
        ]
          .filter(Boolean)
          .join(' ')
        const lens = gloss?.[lower]
        out.push(
          <span
            key={`${keyPrefix}-${start}`}
            className={lens !== undefined ? `${cls} w-lens` : cls}
            data-w={lower}
            data-ws={start}
            data-we={end}
            data-lens={lens}
            onClick={(e) => {
              e.stopPropagation()
              handleWordClick(token)
            }}
          >
            {surface}
          </span>,
        )
      } else {
        out.push(surface)
      }
      pos = end
    }
    if (pos < to) out.push(para.text.slice(pos, to))
    return out
  }

  /** 批注感知渲染：[from, to) 先按批注边界切段，命中段包一层底色 span（词元 span 嵌套其内） */
  const renderAnnotated = (from: number, to: number, keyPrefix: string): ReactNode[] => {
    const hits = paraAnnotations.filter((a) => a.char_start < to && a.char_end > from)
    // 搜索命中与批注共用同一套区间切段：各自贡献切点，命中段再包一层 <mark>
    const found = (marks ?? []).filter(([ms, me]) => ms < to && me > from)
    if (hits.length === 0 && found.length === 0) return renderRange(from, to, keyPrefix)
    const points = new Set<number>([from, to])
    for (const a of hits) {
      points.add(Math.max(from, a.char_start))
      points.add(Math.min(to, a.char_end))
    }
    for (const [ms, me] of found) {
      points.add(Math.max(from, ms))
      points.add(Math.min(to, me))
    }
    const sorted = [...points].sort((x, y) => x - y)
    const out: ReactNode[] = []
    for (let i = 0; i < sorted.length - 1; i++) {
      const s = sorted[i]
      const e = sorted[i + 1]
      if (s >= e) continue
      let ann: Annotation | null = null
      for (const a of hits) {
        if (a.char_start <= s && a.char_end >= e && (ann === null || a.id > ann.id)) ann = a
      }
      const raw = renderRange(s, e, `${keyPrefix}-c${s}`)
      const isHit = found.some(([ms, me]) => ms <= s && me >= e)
      const chunk = isHit
        ? [
            <mark key={`${keyPrefix}-m${s}`} className="rs-hit">
              {raw}
            </mark>,
          ]
        : raw
      if (ann === null) {
        out.push(<Fragment key={`${keyPrefix}-f${s}`}>{chunk}</Fragment>)
      } else {
        const picked = ann
        // 笔记圆点只标在批注区间的末段，避免跨句拆段后重复
        const noted = picked.note !== null && picked.note !== '' && e >= picked.char_end
        out.push(
          <span
            key={`${keyPrefix}-ann-${s}`}
            className={`ann ann-${picked.color}${noted ? ' ann-noted' : ''}`}
            data-ann={picked.id}
            onClick={(ev) => {
              ev.stopPropagation()
              onAnnotationClick?.(picked, ev.currentTarget)
            }}
          >
            {chunk}
          </span>,
        )
      }
    }
    return out
  }

  // 译文模式：只渲染译文行，缺失句用骨架占位；标题句缺译时回退原文
  if (mode === 'trans' && sentences.length > 0) {
    const rows = sentences.map(([sid, cs, ce]) => {
      const t = translations[String(sid)]
      if (para.kind === 'heading') {
        return (
          <span key={sid} style={{ display: 'block' }}>
            {t ?? para.text.slice(cs, ce)}
          </span>
        )
      }
      if (t !== undefined) {
        return (
          <span key={sid} className="trans trans-lg">
            {t}
          </span>
        )
      }
      return (
        <span
          key={sid}
          className="skeleton trans-skel"
          style={{ width: skeletonWidth(ce - cs) }}
        />
      )
    })
    if (para.kind === 'heading') {
      return (
        <h2 className="ch-title" data-pid={para.id}>
          {rows}
        </h2>
      )
    }
    return (
      <p data-pid={para.id} data-bm={bookmarked ? 1 : undefined}>
        {rows}
      </p>
    )
  }

  const nodes: ReactNode[] = []
  let cursor = 0
  for (const sent of sentences) {
    const [sid, cs, ce, hash] = sent
    if (cs > cursor) {
      nodes.push(
        <Fragment key={`gap-${cursor}`}>{renderAnnotated(cursor, cs, `g${cursor}`)}</Fragment>,
      )
    }
    nodes.push(
      <span
        key={`s-${sid}`}
        data-sid={sid}
        className={
          selectedSentenceId === sid || readingSentenceId === sid ? 's-reading' : undefined
        }
        onClick={() => {
          // 拖选松开不当作点句
          const winSel = window.getSelection()
          if (winSel !== null && !winSel.isCollapsed) return
          selectSentence({
            sentenceId: sid,
            hash,
            paragraphId: para.id,
            text: para.text.slice(cs, ce),
          })
        }}
      >
        {renderAnnotated(cs, ce, `s${sid}`)}
        <button
          className={`s-play${playingSentenceId === sid ? ' on' : ''}`}
          title={playingSentenceId === sid ? '暂停朗读' : '朗读本句'}
          onClick={(e) => {
            e.stopPropagation()
            // 与点句文字一致的右栏联动：切"句子"面板加载本句
            selectSentence({
              sentenceId: sid,
              hash,
              paragraphId: para.id,
              text: para.text.slice(cs, ce),
            })
            usePlayerStore.getState().playSentence(sid)
          }}
        >
          {playingSentenceId === sid ? <IconPause /> : <IconPlay />}
        </button>
      </span>,
    )
    // 双语模式：译文行紧跟本句
    const t = translations[String(sid)]
    if (mode === 'both' && t !== undefined) {
      nodes.push(
        <span key={`t-${sid}`} className="trans">
          {t}
        </span>,
      )
    }
    cursor = Math.max(cursor, ce)
  }
  if (cursor < para.text.length) {
    nodes.push(
      <Fragment key="tail">{renderAnnotated(cursor, para.text.length, 'tail')}</Fragment>,
    )
  }

  if (para.kind === 'heading') {
    return (
      <h2 className="ch-title" data-pid={para.id}>
        {nodes}
      </h2>
    )
  }
  return (
    <p data-pid={para.id} data-bm={bookmarked ? 1 : undefined}>
      {nodes}
    </p>
  )
}
