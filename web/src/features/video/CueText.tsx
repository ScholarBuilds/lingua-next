/* 字幕句文本渲染：词组三色高亮（蓝=短语动词 绿=搭配 粉=习语）+ 词元可点。
   词点击 → 中央词卡；词组点击 → phrase 流式分析。 */

import { useMemo } from 'react'
import type { ReactNode } from 'react'

import type { CuePhrase } from '../../lib/api-video'
import { useReaderStore } from '../reader/readerStore'
import type { WordSelection } from '../reader/readerStore'
import { useVocabCollectionStore } from '../../lib/vocabCollectionStore'
import { phraseColorClass, segmentCue, tokenizeCue } from './videoUtils'

/** 词组高亮的宿主：cue 与语法句都满足此形状（三级模型下两者都要渲染） */
export interface PhraseHost {
  id: number
  text: string
  phrases: CuePhrase[] | null
}

export interface CueTextProps {
  cue: PhraseHost
  /** 本地编辑后的文本覆盖；与原文不同时词组区间失效不再高亮 */
  text?: string
  onWord?: (sel: WordSelection) => void
  onPhrase?: (phrase: CuePhrase, cue: PhraseHost) => void
  /** 关闭词组高亮（英语/中文单语模式等场景） */
  showPhrases?: boolean
  /** 词级卡拉OK（v8 FR-105）：当前词的 UTF-16 区间；命中词高亮、其前的词淡染 */
  karaoke?: [number, number] | null
}

export function CueText({
  cue,
  text,
  onWord,
  onPhrase,
  showPhrases = true,
  karaoke = null,
}: CueTextProps) {
  const collected = useVocabCollectionStore((state) => state.collected)
  const selectedStart = useReaderStore((s) =>
    s.selection?.kind === 'word' && s.selection.word.paragraphId === cue.id
      ? s.selection.word.start
      : -1,
  )

  const content = text ?? cue.text
  const edited = content !== cue.text
  const segments = useMemo(
    () => segmentCue(content, edited || !showPhrases ? null : cue.phrases),
    [content, edited, showPhrases, cue.phrases],
  )

  /* 词组区间内的词不各自响应点击——整个词组是一个语义单元，点击走 phrase 分析
     （词组释义卡内的英文仍可逐词点查）；区间外的词照常点词开卡。 */
  const renderWords = (segStart: number, segEnd: number, inPhrase: boolean): ReactNode[] => {
    const slice = content.slice(segStart, segEnd)
    const tokens = tokenizeCue(slice)
    const nodes: ReactNode[] = []
    let pos = 0
    for (const t of tokens) {
      if (t.start > pos) nodes.push(slice.slice(pos, t.start))
      const absStart = segStart + t.start
      const cls = [
        'vw',
        collected.has(t.word) ? 'vocab' : '',
        selectedStart === absStart ? 'selected' : '',
        karaoke !== null && absStart >= karaoke[0] && absStart < karaoke[1] ? 'kara' : '',
      ]
        .filter(Boolean)
        .join(' ')
      nodes.push(
        <span
          key={absStart}
          className={cls}
          onClick={
            inPhrase
              ? undefined
              : (e) => {
                  if (onWord === undefined) return
                  e.stopPropagation()
                  onWord({
                    word: t.word,
                    surface: t.surface,
                    paragraphId: cue.id,
                    start: absStart,
                    end: segStart + t.end,
                    sentenceId: null,
                    sentenceHash: null,
                    sentenceText: content,
                  })
                }
          }
        >
          {t.surface}
        </span>,
      )
      pos = t.end
    }
    if (pos < slice.length) nodes.push(slice.slice(pos))
    return nodes
  }

  return (
    <>
      {segments.map((seg) =>
        seg.phrase !== null ? (
          <span
            key={`p${seg.start}`}
            className={`vm-hl ${phraseColorClass(seg.phrase[2])}`}
            title={seg.phrase[3]}
            onClick={(e) => {
              if (onPhrase === undefined) return
              e.stopPropagation()
              onPhrase(seg.phrase!, cue)
            }}
          >
            {renderWords(seg.start, seg.end, true)}
          </span>
        ) : (
          <span key={`t${seg.start}`}>{renderWords(seg.start, seg.end, false)}</span>
        ),
      )}
    </>
  )
}
