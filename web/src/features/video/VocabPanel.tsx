/* 词卡模式：GET /videos/{id}/vocab 重点词汇卡片流（word/释义/CEFR/出处句），
   一键收藏入生词本（带 video_id+cue_id 出处，FR-17）。 */

import { useMutation, useQuery } from '@tanstack/react-query'
import { toast } from 'sonner'

import { IconSpeaker, IconStar } from '../../components/icons'
import { apiVideo, VideoApiError } from '../../lib/api-video'
import type { CueV2, VideoVocabItem } from '../../lib/api-video'
import { playTts } from '../../lib/audio'
import { useVocabCollectionStore } from '../../lib/vocabCollectionStore'
import { VIconArrowLeft, VIconArrowRight, VIconPlaySolid, VIconRefresh } from './icons'

/** 出处句里高亮该词（词边界，退化前缀匹配容纳屈折形） */
function highlightWord(text: string, word: string): React.ReactNode {
  const re = new RegExp(`(?<![A-Za-z])(${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[a-z]*)`, 'i')
  const m = re.exec(text)
  if (m === null || m.index === undefined) return text
  return (
    <>
      {text.slice(0, m.index)}
      <b>{m[1]}</b>
      {text.slice(m.index + m[1].length)}
    </>
  )
}

interface VocabPanelProps {
  videoId: string
  cues: CueV2[]
  idx: number
  setIdx: (i: number) => void
  /** 出处回跳：按句 ordinal 定位并播放 */
  onJumpOrdinal: (ordinal: number) => void
  onEnrichVocab: () => void
}

export function VocabPanel({ videoId, cues, idx, setIdx, onJumpOrdinal, onEnrichVocab }: VocabPanelProps) {
  const collected = useVocabCollectionStore((state) => state.collected)
  const addCollected = useVocabCollectionStore((state) => state.addCollected)

  const vocabQuery = useQuery({
    queryKey: ['video-vocab', videoId],
    queryFn: () => apiVideo.videoVocab(videoId),
    retry: false,
    staleTime: Infinity,
  })

  const items = vocabQuery.data?.items ?? []
  const item = items[Math.min(idx, Math.max(0, items.length - 1))] as VideoVocabItem | undefined
  const cueOf = (it: VideoVocabItem): CueV2 | undefined =>
    it.cue_ordinal !== null ? cues.find((c) => c.ordinal === it.cue_ordinal) : undefined

  const collect = useMutation({
    mutationFn: (it: VideoVocabItem) => {
      const cue = cueOf(it)
      return apiVideo.collectVocab({
        word: it.word.toLowerCase(),
        video_id: Number(videoId),
        ...(cue !== undefined ? { cue_id: cue.id } : {}),
        context_text: cue?.text ?? it.meaning_zh,
      })
    },
    onSuccess: (_, it) => {
      addCollected(it.word.toLowerCase())
      toast.success(`已收藏 ${it.word}`)
    },
    onError: (err) => toast.error(`收藏失败：${err instanceof Error ? err.message : '未知错误'}`),
  })

  const collectAll = useMutation({
    mutationFn: async () => {
      const pending = items.filter((it) => !collected.has(it.word.toLowerCase()))
      let ok = 0
      for (const it of pending) {
        const cue = cueOf(it)
        try {
          await apiVideo.collectVocab({
            word: it.word.toLowerCase(),
            video_id: Number(videoId),
            ...(cue !== undefined ? { cue_id: cue.id } : {}),
            context_text: cue?.text ?? it.meaning_zh,
          })
          addCollected(it.word.toLowerCase())
          ok += 1
        } catch {
          /* 单词失败继续，末尾统计 */
        }
      }
      return { ok, total: pending.length }
    },
    onSuccess: ({ ok, total }) =>
      ok === total
        ? toast.success(`已全部收藏 ${ok} 个词`)
        : toast.warning(`收藏 ${ok}/${total} 个词，其余失败可重试`),
  })

  /* 词汇表尚未生成（404）：引导触发加工 */
  const notReady =
    vocabQuery.error instanceof VideoApiError && vocabQuery.error.status === 404

  if (vocabQuery.isPending) {
    return (
      <>
        <div className="vm-panel-head">
          <h3>词卡模式</h3>
        </div>
        <div className="vm-mode-body">
          <div className="skeleton" style={{ height: 220, borderRadius: 'var(--radius-lg)' }} />
        </div>
      </>
    )
  }

  if (notReady || items.length === 0) {
    return (
      <>
        <div className="vm-panel-head">
          <h3>词卡模式</h3>
        </div>
        <div className="panel-empty">
          <IconStar />
          <div>
            重点词汇表尚未生成
            <br />
            触发 AI 加工后自动产出 20-40 个重点词
          </div>
          <button className="btn btn-soft" onClick={onEnrichVocab}>
            <VIconRefresh />
            生成词汇表
          </button>
        </div>
      </>
    )
  }

  if (vocabQuery.isError && !notReady) {
    return (
      <>
        <div className="vm-panel-head">
          <h3>词卡模式</h3>
        </div>
        <div className="panel-empty">
          <div className="panel-error">{(vocabQuery.error as Error).message}</div>
          <button className="btn btn-outline" onClick={() => void vocabQuery.refetch()}>
            重试
          </button>
        </div>
      </>
    )
  }

  const cur = item as VideoVocabItem
  const curCue = cueOf(cur)
  const isCollected = collected.has(cur.word.toLowerCase())
  const collectedCount = items.reduce(
    (n, it) => n + (collected.has(it.word.toLowerCase()) ? 1 : 0),
    0,
  )

  return (
    <>
      <div className="vm-panel-head">
        <h3>词卡模式</h3>
        <span className="chip accent">
          {Math.min(idx + 1, items.length)} / {items.length}
        </span>
        <div style={{ flex: 1 }} />
        <span className="chip ok">已收藏 {collectedCount}</span>
      </div>
      <div className="vm-mode-body">
        <div className="card vm-vocab-card">
          <div style={{ display: 'flex', justifyContent: 'center', gap: 6 }}>
            {cur.level !== null && <span className="chip accent">{cur.level}</span>}
            {isCollected && <span className="chip ok">已在生词本</span>}
          </div>
          <div className="vm-vocab-word">{cur.word}</div>
          <div className="vm-vocab-meaning">{cur.meaning_zh}</div>
          {curCue !== undefined && (
            <div className="vm-vocab-src">
              {highlightWord(curCue.text, cur.word)}
              <span
                className="src-jump"
                role="button"
                onClick={() => onJumpOrdinal(curCue.ordinal)}
              >
                <VIconPlaySolid style={{ width: 10, height: 10 }} />
                回到出处
              </span>
            </div>
          )}
          <div className="vm-vocab-acts">
            <button className="btn" onClick={() => playTts(cur.word, 'video')}>
              <IconSpeaker />
              发音
            </button>
            <button
              className={`btn${isCollected ? ' btn-soft' : ' btn-primary'}`}
              disabled={isCollected || collect.isPending}
              onClick={() => collect.mutate(cur)}
            >
              <IconStar filled={isCollected} />
              {isCollected ? '已收藏' : '收藏'}
            </button>
          </div>
        </div>

        <div className="vm-vocab-nav">
          <button className="btn" disabled={idx <= 0} onClick={() => setIdx(idx - 1)}>
            <VIconArrowLeft />
            上一个
          </button>
          <span className="pos">
            {Math.min(idx + 1, items.length)} / {items.length}
          </span>
          <button
            className="btn"
            disabled={idx >= items.length - 1}
            onClick={() => setIdx(idx + 1)}
          >
            下一个
            <VIconArrowRight />
          </button>
        </div>

        <div className="vm-mode-acts" style={{ justifyContent: 'center' }}>
          <button
            className="btn btn-soft"
            disabled={collectAll.isPending || collectedCount >= items.length}
            onClick={() => collectAll.mutate()}
          >
            <IconStar />
            {collectAll.isPending
              ? '批量收藏中…'
              : `一键收藏剩余 ${items.length - collectedCount} 个`}
          </button>
        </div>

        <div className="vm-mode-stats">
          <span>
            AI 提取重点词 <b>{items.length}</b> 个
          </span>
          <div className="vm-sess-bar">
            <i style={{ width: `${(collectedCount / Math.max(1, items.length)) * 100}%` }} />
          </div>
          <span>收藏 {collectedCount}</span>
        </div>
      </div>
    </>
  )
}
