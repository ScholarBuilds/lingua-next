/* 屏幕中央模态卡（M5 反馈迭代）：复用 WordCard / PhrasePanel 完整数据流
   （词典 + AI 语境释义 + 发音 + 收藏），卡内英文递归点词压栈，
   面包屑回退，Esc / 遮罩 / X 关闭。阅读器与视频学习页共用。 */

import { useEffect, useMemo, useRef } from 'react'
import { Fragment } from 'react'

import { useFullscreenElement } from '../../components/FullscreenPortal'
import { Dialog, DialogContent, DialogTitle } from '../../components/ui/dialog'
import { playTts } from '../../lib/audio'
import { usePrefStore } from '../../lib/prefStore'

import { PhrasePanel } from './PhrasePanel'
import { WordCard } from './WordCard'
import type { PhraseSelection, WordSelection } from './readerStore'
import { entryLabel, useWordModalStore } from './wordModalStore'
import { useStopTtsOnClose } from '../../lib/useStopTtsOnClose'
import { useListenStore } from '../vocab/listenStore'
import './wordDialog.css'

interface WordModalProps {
  /** 收藏出处：文章场景传 articleId，视频场景传 videoId（cueId 随条目走） */
  articleId?: number
  videoId?: number
}

export function WordModal({ articleId, videoId }: WordModalProps) {
  const stack = useWordModalStore((s) => s.stack)
  const backTo = useWordModalStore((s) => s.backTo)
  const close = useWordModalStore((s) => s.close)
  const open = stack.length > 0
  const followListen = useWordModalStore((s) => s.followListen)
  const current = useListenStore((s) => s.items[s.order[s.pos]])
  const deckName = useListenStore((s) => s.deckName)
  const deckKey = useListenStore((s) => s.deckKey)
  const playing = useListenStore((s) => s.status === 'playing')
  const listen = useListenStore.getState()
  useEffect(() => {
    if (!followListen || !current) return
    useWordModalStore.getState().replaceWord(current.word, current.example_en ?? `${deckName}：${current.word}`, current.source ?? {
      kind: 'wordlist', label: deckName, locator: { deck: deckKey, word: current.word },
    })
  }, [followListen, current, deckKey, deckName])
  const fullscreen = useFullscreenElement()
  const trigger = useRef<HTMLElement | null>(null)
  // 本组件常驻不卸载，必须按打开态停声（FR-350）
  useStopTtsOnClose(open && !followListen)
  const top = stack[stack.length - 1]

  /* 弹出即朗读（FR-310）：点词就是想知道它怎么念，还要再点一次喇叭是多余的一步。
     卡内递归点词压栈时每压一层读新词；受「自动发音」偏好控制。 */
  const autoplay = usePrefStore((s) => s.prefs.vocab.autoplay)
  const speakKey = top === undefined ? '' : top.kind === 'word' ? top.surface : top.text
  useEffect(() => {
    if (followListen || !autoplay || speakKey === '') return
    playTts(speakKey, top?.kind === 'phrase' ? 'sentence' : 'word')
  }, [speakKey, autoplay, top?.kind, followListen])

  const wordSel = useMemo<WordSelection | null>(
    () =>
      top === undefined || top.kind !== 'word'
        ? null
        : {
            word: top.word,
            surface: top.surface,
            // 非正文选词：段落定位字段用占位值，仅 WordCard 数据流用到的字段有效
            paragraphId: -1,
            start: 0,
            end: 0,
            sentenceId: null,
            sentenceHash: null,
            sentenceText: top.context,
          },
    [top],
  )

  const phraseSel = useMemo<PhraseSelection | null>(
    () =>
      top === undefined || top.kind !== 'phrase'
        ? null
        : { text: top.text, context: top.context, paragraphId: top.cueId ?? -1 },
    [top],
  )

  if (top === undefined) return null

  return (
    <Dialog open onOpenChange={(value) => { if (!value) close() }}>
      <DialogContent className="word-dialog" overlayClassName="word-dialog-overlay" portalContainer={fullscreen}
        onKeyDownCapture={(event) => {
          if (!event.currentTarget.contains(event.target as Node)) return
          if (!followListen || event.nativeEvent.isComposing || event.altKey || event.ctrlKey || event.metaKey) return
          if (event.target instanceof Element && event.target.closest('input, textarea, select, [contenteditable="true"]')) return
          if (![' ', 'ArrowLeft', 'ArrowRight'].includes(event.key)) return
          event.preventDefault()
          event.stopPropagation()
          if (event.key === ' ') listen.toggle()
          else if (event.key === 'ArrowRight') listen.next()
          else listen.prev()
        }}
        onOpenAutoFocus={() => { trigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : null }}
        onCloseAutoFocus={(event) => { event.preventDefault(); trigger.current?.focus({ preventScroll: true }) }}
        showCloseButton={false} aria-describedby={undefined} onEscapeKeyDown={(event) => event.stopPropagation()}>
        <DialogTitle className="sr-only">{entryLabel(top)}</DialogTitle>
        <div
          className="wm-card"
        >
          {followListen && <div className="wm-listen" aria-label="词卡听读控制">
            <span>听读 · 沿用播放设置</span>
            <button className="btn btn-outline" onClick={listen.prev}>上一词</button>
            <button className="btn btn-primary" onClick={listen.toggle}>{playing ? '暂停听读' : '继续听读'}</button>
            <button className="btn btn-outline" onClick={listen.next}>下一词</button>
          </div>}
          {stack.length > 1 && (
            <div className="wm-crumbs">
              {stack.map((entry, i) =>
                i === stack.length - 1 ? (
                  <b key={`${i}-${entryLabel(entry)}`}>{entryLabel(entry)}</b>
                ) : (
                  <Fragment key={`${i}-${entryLabel(entry)}`}>
                    <button className="wm-crumb" title="返回该条" onClick={() => backTo(i)}>
                      {entryLabel(entry)}
                    </button>
                    <span className="wm-sep">›</span>
                  </Fragment>
                ),
              )}
            </div>
          )}
          {wordSel !== null && (
            <WordCard
              key={`w:${wordSel.word}::${top.context}`}
              sel={wordSel}
              articleId={articleId}
              videoId={videoId}
              cueId={top.cueId}
              source={top.source}
              onClose={close}
              clickable="force"
            />
          )}
          {phraseSel !== null && (
            <PhrasePanel
              key={`p:${phraseSel.text}::${top.context}`}
              sel={phraseSel}
              onClose={close}
            />
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
