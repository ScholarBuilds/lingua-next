/* 听读连播条（FR-485~494、FR-503、FR-504）：范围就是网格当前筛选，控件按「用户想干的事」拆开命名（BR-65）。

   快捷键：注册表与帮助面板同一份 `LISTEN_KEYS`。让路规则不靠开关状态（选项弹层点外面关掉时
   本地 state 会卡住），而是看事件从哪来：弹层、radix Dialog（词卡、音色弹窗不进 Overlay 栈）、
   输入框里的按键一律不接；Overlay 开着时整体停。 */

import { useEffect, useState } from 'react'
import { useHotkeys } from 'react-hotkeys-hook'

import {
  IconClose,
  IconHelp,
  IconPause,
  IconPlay,
  IconRepeatOne,
  IconSettings,
  IconSkipBack,
  IconSkipForward,
  IconSpeaker,
  IconVoice,
} from '../../components/icons'
import { Overlay, useOverlayOpen } from '../../components/Overlay'
import { RatePicker, SPEECH_RATES } from '../../components/RatePicker'
import { PopoverPicker } from '@/components/ui/picker'
import { setPlaybackRate } from '../../lib/audio'
import {
  LISTEN_CONTENTS,
  LISTEN_GAPS,
  LISTEN_MEANING_SCOPES,
  LISTEN_RECALL_GAPS,
  LISTEN_REPEATS,
  LISTEN_STOP_AFTER,
  usePrefStore,
  type ListenContent,
  type ListenMeaningScope,
} from '../../lib/prefStore'
import { useWordModalStore } from '../reader/wordModalStore'
import { LISTEN_KEYS, type ListenAction } from './listenKeys'
import { useListenStore, type ListenStep } from './listenStore'
import { spokenMeaning } from './spokenMeaning'
import './listen.css'

const CONTENT_LABEL: Record<ListenContent, string> = {
  word: '只念词',
  word_meaning: '词 + 释义',
  word_meaning_example: '词 + 释义 + 例句',
}
const SCOPE_LABEL: Record<ListenMeaningScope, string> = {
  first: '只念第一个词性',
  all: '念全部词性',
}
const STEP_LABEL: Record<ListenStep, string> = { word: '单词', meaning: '释义', example: '例句' }
/** 按键来自这些地方时不接：弹层里的分段按钮、词卡 / 音色弹窗、输入框 */
const IGNORE_WITHIN = '.ui-picker-pop, [role="dialog"], input, textarea, select'

interface ListenBarProps {
  deckName: string
  /** 范围内一共多少词（装载进度的分母） */
  total: number
  loadedCount: number
  onOpenWord: (word: string) => void
  onChangeVoice: (word: string) => void
}

function stepRate(rate: number, delta: number): number {
  const rates: readonly number[] = SPEECH_RATES
  const i = rates.indexOf(rate)
  const at = i < 0 ? rates.indexOf(1) : i
  return rates[Math.min(rates.length - 1, Math.max(0, at + delta))]
}

export function ListenBar({ deckName, total, loadedCount, onOpenWord, onChangeVoice }: ListenBarProps) {
  const status = useListenStore((s) => s.status)
  const currentWord = useListenStore((s) => s.currentWord)
  const pos = useListenStore((s) => s.pos)
  const count = useListenStore((s) => s.order.length)
  const loaded = useListenStore((s) => s.loaded)
  const loopOne = useListenStore((s) => s.loopOne)
  const step = useListenStore((s) => s.step)
  const quotaHit = useListenStore((s) => s.quotaHit)
  const resumeWord = useListenStore((s) => s.resumeWord)
  const current = useListenStore((s) => {
    const idx = s.order[s.pos]
    return idx === undefined ? undefined : s.items[idx]
  })
  const {
    play,
    pause,
    toggle,
    next,
    prev,
    close,
    readAgain,
    toggleLoopOne,
    reorder,
    restart,
    setBarMounted,
  } = useListenStore.getState()

  const prefs = usePrefStore((s) => s.prefs.listen)
  const hideZh = usePrefStore((s) => s.prefs.study.hideZh)
  const hideEn = usePrefStore((s) => s.prefs.study.hideEn)
  const update = usePrefStore((s) => s.update)

  // 条在页面上就由它管播放器，不在时 App 级迷你条接管（BR-184）
  useEffect(() => {
    setBarMounted(true)
    return () => setBarMounted(false)
  }, [setBarMounted])

  const modalOpen = useWordModalStore((s) => s.stack.length > 0)
  const overlayOpen = useOverlayOpen()
  const [helpOpen, setHelpOpen] = useState(false)
  const cardFromBar = useWordModalStore((s) => s.followListen)

  const setShuffle = (on: boolean) => {
    if (prefs.shuffle === on) return
    update({ listen: { shuffle: on } })
    reorder()
  }
  const setRate = (rate: number) => {
    update({ listen: { rate } })
    setPlaybackRate(rate)
  }
  const cycleContent = () => {
    const at = LISTEN_CONTENTS.indexOf(prefs.content)
    update({ listen: { content: LISTEN_CONTENTS[(at + 1) % LISTEN_CONTENTS.length] } })
  }
  const actions: Record<ListenAction, () => void> = {
    toggle,
    next,
    prev,
    again: readAgain,
    loopOne: toggleLoopOne,
    shuffle: () => setShuffle(!prefs.shuffle),
    loopAll: () => update({ listen: { loopAll: !prefs.loopAll } }),
    content: cycleContent,
    repeat1: () => update({ listen: { repeat: 1 } }),
    repeat2: () => update({ listen: { repeat: 2 } }),
    repeat3: () => update({ listen: { repeat: 3 } }),
    repeat5: () => update({ listen: { repeat: 5 } }),
    slower: () => setRate(stepRate(prefs.rate, -1)),
    faster: () => setRate(stepRate(prefs.rate, 1)),
    card: () => {
      if (current === undefined) return
      onOpenWord(current.word)
      useWordModalStore.setState({ followListen: true })
    },
    voice: () => {
      if (current === undefined) return
      pause()
      onChangeVoice(current.word)
    },
    help: () => setHelpOpen((v) => !v),
    close: () => (helpOpen ? setHelpOpen(false) : close()),
  }
  const keyOptions = {
    enabled: !modalOpen && !overlayOpen,
    preventDefault: true,
    ignoreEventWhen: (e: KeyboardEvent) =>
      e.target instanceof Element && e.target.closest(IGNORE_WITHIN) !== null,
  }
  /* 18 个键合成一次注册，靠库回传的 `hotkey`（注册时写的那个串，如 'left'）反查动作。
     别拿 `handler.keys` 拼：库内部把 left 解析成 arrowleft、[ 解析成 bracketleft，拼出来对不上表 */
  useHotkeys(
    LISTEN_KEYS.map((k) => k.keys).join(', '),
    (e, handler) => {
      const entry = LISTEN_KEYS.find((k) =>
        k.keys.split(',').some((alias) => alias.trim() === handler.hotkey),
      )
      if (entry === undefined) return
      e.preventDefault()
      actions[entry.action]()
    },
    keyOptions,
    [actions],
  )

  // 词卡开着时其它键都让路，只留 W 关卡（焦点在词卡的输入框里不接）
  useHotkeys(
    'w',
    (e) => {
      e.preventDefault()
      useWordModalStore.getState().close()
    },
    {
      enabled: modalOpen && cardFromBar,
      ignoreEventWhen: (e: KeyboardEvent) =>
        e.target instanceof Element &&
        e.target.closest('input, textarea, select, [contenteditable="true"]') !== null,
    },
    [modalOpen, cardFromBar],
  )

  const meaning =
    current === undefined ? '' : spokenMeaning(current.translation, { scope: prefs.meaningScope })
  const playing = status === 'playing'

  return (
    <div className="lsn-bar" role="region" aria-label="听读连播">
      <div className="lsn-transport">
        <button className="icon-btn" title="上一个词 ←" onClick={prev} disabled={!loaded}>
          <IconSkipBack />
        </button>
        <button
          className="lsn-play"
          title={playing ? '暂停 空格' : '播放 空格'}
          onClick={playing ? pause : play}
          disabled={!loaded || count === 0}
        >
          {playing ? <IconPause /> : <IconPlay />}
        </button>
        <button className="icon-btn" title="下一个词 →" onClick={next} disabled={!loaded}>
          <IconSkipForward />
        </button>
      </div>

      <div className="lsn-now">
        <div className="lsn-word">
          {current === undefined ? (
            <b>{loaded ? '范围内没有词' : '正在装载词表…'}</b>
          ) : (
            <>
              {!hideEn && (
                <button
                  className="lsn-word-btn"
                  title="打开词卡 W"
                  onClick={() => actions.card()}
                >
                  {current.word}
                </button>
              )}
              {!hideEn && current.phonetic && <span className="lsn-phon">/{current.phonetic}/</span>}
              {hideEn && <b>{meaning || '（无释义）'}</b>}
              {playing && currentWord !== null && <span className="lsn-step">{STEP_LABEL[step]}</span>}
              {!playing && resumeWord !== null && currentWord === resumeWord && (
                <span className="lsn-resume">
                  上次念到这里
                  <button className="btn-ghost-sm" onClick={restart}>
                    从头
                  </button>
                </span>
              )}
              {!playing && quotaHit && (
                <span className="lsn-resume">已念满 {prefs.stopAfter} 词，停一下</span>
              )}
            </>
          )}
        </div>
        {current !== undefined && !hideEn && !hideZh && meaning !== '' && (
          <div className="lsn-meaning">{meaning}</div>
        )}
      </div>

      <span className="lsn-count">
        {loaded ? `${Math.min(pos + 1, count)} / ${count}` : `装载 ${loadedCount} / ${total}`}
      </span>

      <div className="lsn-acts">
        <button className="icon-btn" title="再读一遍这个词 R" onClick={readAgain} disabled={!loaded}>
          <IconSpeaker />
        </button>
        <button
          className={`icon-btn${loopOne ? ' active' : ''}`}
          title={`单词循环：一直念当前这个词，切词后对新词继续 L（${loopOne ? '开' : '关'}）`}
          aria-pressed={loopOne}
          onClick={toggleLoopOne}
        >
          <IconRepeatOne />
        </button>
        <PopoverPicker
          hover={false}
          align="end"
          trigger={
            <button className="icon-btn" title="念什么、几遍、停顿、语速、顺序">
              <IconSettings />
            </button>
          }
        >
          <div className="lsn-opts">
            <div className="lsn-opt-row">
              <span className="lsn-opt-name">念什么</span>
              <div className="seg">
                {LISTEN_CONTENTS.map((c) => (
                  <button
                    key={c}
                    className={prefs.content === c ? 'active' : undefined}
                    onClick={() => update({ listen: { content: c } })}
                  >
                    {CONTENT_LABEL[c]}
                  </button>
                ))}
              </div>
              <span className="lsn-opt-hint">M</span>
            </div>
            <div className="lsn-opt-row">
              <span className="lsn-opt-name">释义</span>
              <div className="seg">
                {LISTEN_MEANING_SCOPES.map((c) => (
                  <button
                    key={c}
                    className={prefs.meaningScope === c ? 'active' : undefined}
                    onClick={() => update({ listen: { meaningScope: c } })}
                  >
                    {SCOPE_LABEL[c]}
                  </button>
                ))}
              </div>
            </div>
            <div className="lsn-opt-row">
              <span className="lsn-opt-name">每词几遍</span>
              <div className="seg">
                {LISTEN_REPEATS.map((n) => (
                  <button
                    key={n}
                    className={prefs.repeat === n ? 'active' : undefined}
                    onClick={() => update({ listen: { repeat: n } })}
                  >
                    {n}
                  </button>
                ))}
              </div>
              <span className="lsn-opt-hint">1 / 2 / 3 / 5</span>
            </div>
            <div className="lsn-opt-row">
              <span className="lsn-opt-name">回想停顿</span>
              <div className="seg">
                {LISTEN_RECALL_GAPS.map((g) => (
                  <button
                    key={g}
                    className={prefs.recallGapS === g ? 'active' : undefined}
                    onClick={() => update({ listen: { recallGapS: g } })}
                  >
                    {g === 0 ? '不留' : `${g} 秒`}
                  </button>
                ))}
              </div>
              <span className="lsn-opt-hint">单词念完先想一下再听释义</span>
            </div>
            <div className="lsn-opt-row">
              <span className="lsn-opt-name">词间停顿</span>
              <div className="seg">
                {LISTEN_GAPS.map((g) => (
                  <button
                    key={g}
                    className={prefs.gapS === g ? 'active' : undefined}
                    onClick={() => update({ listen: { gapS: g } })}
                  >
                    {g} 秒
                  </button>
                ))}
              </div>
            </div>
            <div className="lsn-opt-row">
              <span className="lsn-opt-name">语速</span>
              <RatePicker value={prefs.rate} onChange={setRate} />
              <span className="lsn-opt-hint">[ ]</span>
            </div>
            <div className="lsn-opt-row">
              <span className="lsn-opt-name">顺序</span>
              <div className="seg">
                {[false, true].map((on) => (
                  <button
                    key={String(on)}
                    className={prefs.shuffle === on ? 'active' : undefined}
                    onClick={() => setShuffle(on)}
                  >
                    {on ? '随机' : '按列表'}
                  </button>
                ))}
              </div>
              <span className="lsn-opt-hint">S · 随机只改念的顺序，网格不动</span>
            </div>
            <div className="lsn-opt-row">
              <span className="lsn-opt-name">播完</span>
              <div className="seg">
                {[false, true].map((on) => (
                  <button
                    key={String(on)}
                    className={prefs.loopAll === on ? 'active' : undefined}
                    onClick={() => update({ listen: { loopAll: on } })}
                  >
                    {on ? '从头再来' : '停下'}
                  </button>
                ))}
              </div>
              <span className="lsn-opt-hint">A</span>
            </div>
            <div className="lsn-opt-row">
              <span className="lsn-opt-name">念满就停</span>
              <div className="seg">
                {LISTEN_STOP_AFTER.map((n) => (
                  <button
                    key={n}
                    className={prefs.stopAfter === n ? 'active' : undefined}
                    onClick={() => update({ listen: { stopAfter: n } })}
                  >
                    {n === 0 ? '不限' : `${n} 词`}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </PopoverPicker>
        <button
          className="icon-btn"
          title="换个声音：只换当前这个词的发音 V"
          disabled={current === undefined}
          onClick={() => actions.voice()}
        >
          <IconVoice />
        </button>
        <button className="btn-ghost-sm" disabled={current === undefined} onClick={() => actions.card()}>
          词卡
        </button>
        <button className="icon-btn" title="快捷键 ?" onClick={() => setHelpOpen(true)}>
          <IconHelp />
        </button>
        <button className="icon-btn" title="关闭听读 Esc" onClick={close}>
          <IconClose />
        </button>
      </div>

      {helpOpen && (
        <Overlay onClose={() => setHelpOpen(false)} card="lsn-help">
          <div className="overlay-head">
            <div className="overlay-title">听读快捷键</div>
            <div style={{ flex: 1 }} />
            <button className="icon-btn" onClick={() => setHelpOpen(false)}>
              <IconClose />
            </button>
          </div>
          <div className="lsn-help-list">
            {LISTEN_KEYS.map((k) => (
              <div key={k.action} className="lsn-help-row">
                <kbd>{k.label}</kbd>
                <span>{k.desc}</span>
              </div>
            ))}
          </div>
          <div className="overlay-foot">
            <span className="sp-muted">在「{deckName}」听读时有效；词卡或弹窗开着时让路</span>
            <button className="btn" onClick={() => setHelpOpen(false)}>
              知道了
            </button>
          </div>
        </Overlay>
      )}
    </div>
  )
}
