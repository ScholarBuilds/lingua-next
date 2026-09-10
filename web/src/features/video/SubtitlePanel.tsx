/* 右栏字幕列表（双语/英语/中文三模式共用）。

   v8（FR-104~107）：以**语法句**为展示行——一句一块完整呈现，学习句退居时间粒度
   （跳转/循环/听写仍按学习句时间轴），不再把半句拆成行（业内惯例：Language Reactor
   按完整句展示，Netflix 42 字符规范只适用于视频内字幕排版）。
   词级卡拉OK跟随播放（与内嵌字幕同一份词级时间轴），句间停顿高亮粘滞不消失
   （Apple Podcasts 转录同款）；跟随滚动默认开启且不被鼠标滚动打断，仅开关可关。 */

import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useVirtualizer } from '@tanstack/react-virtual'
import { memo, useCallback, useEffect, useMemo, useState } from 'react'
import type { MutableRefObject } from 'react'
import { toast } from 'sonner'

import { IconCheck, IconEdit, IconLocate, IconSparkle, IconStar } from '../../components/icons'
import { apiPipeline } from '../../lib/api-pipeline'
import { apiVideo } from '../../lib/api-video'
import { askAboutSentence } from '../companion/askAi'
import { noteLearned } from '../companion/quiz'
import { voiceIdle } from '../mascot/useInlineVoiceCompanion'
import type { CuePhrase, SentenceV1, StudyUnitV1, UnitStatePatch } from '../../lib/api-video'
import type { WordSelection } from '../reader/readerStore'
import { CueText } from './CueText'
import type { PhraseHost } from './CueText'
import {
  VIconCopy,
  VIconFlag,
  VIconGrammar,
  VIconMicLine,
  VIconPause,
  VIconPlaySolid,
  VIconRepeatOne,
  VIconSpeakerCue,
} from './icons'
import { findActiveWord, formatCueTs } from './videoUtils'
import { IconAction } from '../../components/IconAction'

export type SubMode = 'both' | 'en' | 'zh'

/** 学习句的文本：人工修正优先（听写面板等处仍在用） */
export function unitText(u: StudyUnitV1): string {
  return u.text_override ?? u.text
}

/** 句显示文本：任一学习句被人工修正过则拼修正稿（此时词组/卡拉OK区间失效） */
function sentenceText(s: SentenceV1): { text: string; edited: boolean } {
  const edited = s.units.some((u) => u.text_override !== null)
  if (!edited) return { text: s.text, edited: false }
  return { text: s.units.map(unitText).join(' '), edited: true }
}

/* ---- 词级卡拉OK（FR-105）：只有当前句挂载，rAF 自驱动，不牵连整列表 ---- */

function Karaoke({
  words,
  timeRef,
  children,
}: {
  words: SentenceV1['words']
  timeRef: MutableRefObject<number> | undefined
  children: (range: [number, number] | null) => React.ReactNode
}) {
  const [range, setRange] = useState<[number, number] | null>(null)
  useEffect(() => {
    if (timeRef === undefined || words === null || words.length === 0) return
    let raf = 0
    let last = -1
    const tick = () => {
      const idx = findActiveWord(words, timeRef.current)
      if (idx !== last) {
        last = idx
        setRange(idx >= 0 ? [words[idx][3], words[idx][4]] : null)
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [words, timeRef])
  return <>{children(range)}</>
}

/* ---- 语法句卡（FR-104）：一句一块，操作作用于整句 ---- */

interface SentenceCardProps {
  sentence: SentenceV1
  active: boolean
  mode: SubMode
  editing: boolean
  /** 本行正在单句循环（FR-332） */
  looping: boolean
  /** 本行正在播放（FR-333：按钮要能变暂停） */
  rowPlaying: boolean
  timeRef: MutableRefObject<number> | undefined
  onJump: (ordinal: number) => void
  onWord: (sel: WordSelection) => void
  onPhrase: (phrase: CuePhrase, host: PhraseHost) => void
  onPatchAll: (s: SentenceV1, patch: UnitStatePatch) => void
  onEditSaved: () => void
  onStartEdit: (id: number) => void
  onShadowRow: (s: SentenceV1) => void
  onToggleLoop: (s: SentenceV1) => void
  onTogglePlay: (s: SentenceV1) => void
  onGrammar: (id: number) => void
  onAskAi?: () => void
}

const SentenceCard = memo(function SentenceCard({
  sentence: s,
  active,
  mode,
  editing,
  looping,
  rowPlaying,
  timeRef,
  onJump,
  onWord,
  onPhrase,
  onPatchAll,
  onEditSaved,
  onStartEdit,
  onShadowRow,
  onToggleLoop,
  onTogglePlay,
  onGrammar,
  onAskAi,
}: SentenceCardProps) {
  const { text, edited } = sentenceText(s)
  const [draft, setDraft] = useState('')
  useEffect(() => {
    if (editing) setDraft(text)
  }, [editing, text])

  const first = s.units[0]
  const flagged = s.units.some((u) => u.flagged)
  const learned = s.units.length > 0 && s.units.every((u) => u.learned)
  const starred = s.units.some((u) => u.starred)
  const accuracy = s.units.length === 1 ? s.units[0].dictation_accuracy : null

  const host = useMemo<PhraseHost>(
    () => ({ id: s.id, text, phrases: edited ? null : s.phrases }),
    [s.id, text, edited, s.phrases],
  )

  // 编辑走服务端句级接口（v6 FR-78）：改英文自动清译文与词组，触发补翻
  const saveEdit = useMutation({
    mutationFn: (next: string) => apiPipeline.patchSentence(s.id, { text: next }),
    onSuccess: (d) => {
      onStartEdit(-1)
      onEditSaved()
      if (d.stale_steps.length > 0) toast.success('已保存；译文与词组已入队重算')
      else toast.success('已保存')
    },
    onError: (e: Error) => toast.error(e.message || '保存失败'),
  })

  const copy = () => {
    void navigator.clipboard.writeText(text).then(
      () => toast.success('已复制'),
      () => toast.error('复制失败'),
    )
  }

  if (s.is_noise) {
    return (
      <div className="vm-scard vm-sc-noise">
        <span className="vm-sc-ts">{formatCueTs(s.start_ms)}</span>
        <span>{s.text}</span>
      </div>
    )
  }

  return (
    <div
      className={`vm-scard${active ? ' current' : ''}`}
      data-si={s.ordinal}
      onClick={() => first !== undefined && onJump(first.ordinal)}
    >
      <div className="vm-sc-top">
        <span className="vm-sc-num">{s.ordinal + 1}</span>
        <span className="vm-sc-ts">{formatCueTs(s.start_ms)}</span>
        {edited && <span className="vm-sc-edited">已修正</span>}
        {accuracy !== null && <span className="chip">听写 {accuracy}%</span>}
        <div className="spacer" />
        {active && (
          <span className="vm-mk speaking" title="正在播放">
            <VIconSpeakerCue />
          </span>
        )}
        <button
          className={`vm-mk${flagged ? ' flagged' : ' ghost'}`}
          title={flagged ? '取消旗标' : '旗标难句，进复习清单'}
          onClick={(e) => {
            e.stopPropagation()
            onPatchAll(s, { flagged: !flagged })
          }}
        >
          <VIconFlag filled={flagged} />
        </button>
        <button
          className={`vm-mk${learned ? ' learned' : ' ghost'}`}
          title={learned ? '取消已学标记' : '听懂了 ✓（计入进度）'}
          onClick={(e) => {
            e.stopPropagation()
            onPatchAll(s, { learned: !learned })
          }}
        >
          <IconCheck />
        </button>
      </div>

      {mode !== 'zh' && !editing && (
        <div className="vm-sc-en">
          {active && !edited ? (
            <Karaoke words={s.words} timeRef={timeRef}>
              {(range) => (
                <CueText cue={host} onWord={onWord} onPhrase={onPhrase} karaoke={range} />
              )}
            </Karaoke>
          ) : (
            <CueText cue={host} onWord={onWord} onPhrase={onPhrase} />
          )}
        </div>
      )}

      {editing && (
        <div onClick={(e) => e.stopPropagation()} style={{ cursor: 'default' }}>
          <textarea
            className="vm-edit-area"
            rows={3}
            spellCheck={false}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
          />
          <div style={{ display: 'flex', gap: 6 }}>
            <button
              className="btn btn-primary btn-sm"
              disabled={saveEdit.isPending || draft.trim() === '' || draft.trim() === text}
              onClick={() => saveEdit.mutate(draft.trim())}
            >
              {saveEdit.isPending ? '保存中…' : '保存修改'}
            </button>
            <button className="btn btn-sm" onClick={() => onStartEdit(-1)}>
              取消
            </button>
          </div>
        </div>
      )}

      {mode !== 'en' &&
        !editing &&
        (s.text_zh !== null ? (
          <div className="vm-sc-zh">{s.text_zh}</div>
        ) : (
          <div className="vm-sc-zh" style={{ color: 'var(--ink-faint)' }}>
            （译文重算中…）
          </div>
        ))}

      {!editing && (
        <div className="vm-sc-ops">
          <IconAction
            label="复制这句"
            onClick={(e) => {
              e.stopPropagation()
              copy()
            }}
          >
            <VIconCopy />
          </IconAction>
          <IconAction
            label={starred ? '取消收藏' : '收藏这句'}
            active={starred}
            onClick={(e) => {
              e.stopPropagation()
              onPatchAll(s, { starred: !starred })
            }}
          >
            <IconStar filled={starred} />
          </IconAction>
          <IconAction
            label="交给 AI 陪读讲解"
            onClick={(e) => {
              e.stopPropagation()
              askAboutSentence({ id: s.id, text, startMs: s.start_ms })
              onAskAi?.()
              toast.success('已加入陪读上下文')
            }}
          >
            <IconSparkle />
          </IconAction>
          <IconAction
            label="编辑字幕（存后译文与词组重算）"
            onClick={(e) => {
              e.stopPropagation()
              onStartEdit(s.id)
            }}
          >
            <IconEdit />
          </IconAction>
          <IconAction
            label="跟读这句"
            onClick={(e) => {
              e.stopPropagation()
              onShadowRow(s)
            }}
          >
            <VIconMicLine />
          </IconAction>
          <IconAction
            label="语法分析"
            onClick={(e) => {
              e.stopPropagation()
              onGrammar(s.id)
            }}
          >
            <VIconGrammar />
          </IconAction>
          <IconAction
            label={looping ? '停止循环' : '循环这一句'}
            active={looping}
            onClick={(e) => {
              e.stopPropagation()
              onToggleLoop(s)
            }}
          >
            <VIconRepeatOne />
          </IconAction>
          <IconAction
            label={rowPlaying ? '暂停' : '播放本句'}
            onClick={(e) => {
              e.stopPropagation()
              onTogglePlay(s)
            }}
          >
            {rowPlaying ? (
              <VIconPause style={{ width: 14, height: 14 }} />
            ) : (
              <VIconPlaySolid style={{ width: 14, height: 14 }} />
            )}
          </IconAction>
        </div>
      )}


    </div>
  )
})

interface SubtitlePanelProps {
  videoId: string
  trackId: number | undefined
  sentences: SentenceV1[]
  activeOrdinal: number
  mode: SubMode
  follow: boolean
  onFollow: (on: boolean) => void
  onJump: (ordinal: number) => void
  onPlay: (ordinal: number) => void
  onWord: (sel: WordSelection) => void
  onPhrase: (phrase: CuePhrase, host: PhraseHost) => void
  /** 播放时间（ms）引用：词级卡拉OK自驱动读取，不触发列表重渲染 */
  timeRef?: MutableRefObject<number>
  onAskAi?: () => void
  /** 正在单句循环的语法句 id（FR-331/332：与播放器控件同一份状态，不是两套） */
  loopSentenceId?: number
  /** 正在播放的语法句 id */
  playingSentenceId?: number
  onToggleLoop: (s: SentenceV1) => void
  onTogglePlay: (s: SentenceV1) => void
  /** 打开跟读工作台（FR-335：弹窗形态，不在行内挤） */
  onShadow: (s: SentenceV1) => void
  /** 打开语法分析（与跟读同样上提到页面层，原句才能用视频片段播放） */
  onGrammarSentence: (s: SentenceV1) => void
}

export function SubtitlePanel({
  videoId,
  trackId,
  sentences,
  activeOrdinal,
  mode,
  follow,
  onFollow,
  onJump,
  onPlay: _onPlay,
  onWord,
  onPhrase,
  timeRef,
  onAskAi,
  loopSentenceId = -1,
  playingSentenceId = -1,
  onToggleLoop,
  onTogglePlay,
  onShadow,
  onGrammarSentence,
}: SubtitlePanelProps) {
  const qc = useQueryClient()
  const [flagOnly, setFlagOnly] = useState(false)
  const [editingId, setEditingId] = useState(-1)
  /* 滚动容器用 state 而不是 useRef 持有：TanStack Virtual 的 getScrollElement
     首帧拿到 null 就不再重试，用 ref 的话列表渲染得出来但滚不动（本仓在词库
     列表上踩过一次）。callback ref 让元素挂载时触发重订阅。 */
  const [listEl, setListEl] = useState<HTMLDivElement | null>(null)

  const patch = useMutation({
    mutationFn: ({ unitId, body }: { unitId: number; body: UnitStatePatch }) =>
      apiVideo.patchUnitState(unitId, body),
    onMutate: async ({ unitId, body }) => {
      const key = ['sentences', trackId]
      await qc.cancelQueries({ queryKey: key })
      const prev = qc.getQueryData<SentenceV1[]>(key)
      qc.setQueryData<SentenceV1[]>(key, (old) =>
        old?.map((s) => ({
          ...s,
          units: s.units.map((u) => (u.id === unitId ? { ...u, ...body } : u)),
        })),
      )
      return { prev, key }
    },
    onError: (_e, _v, ctx) => {
      if (ctx) qc.setQueryData(ctx.key, ctx.prev)
      toast.error('保存失败')
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ['video-progress', videoId] })
    },
  })

  /* 句级操作作用于整句的全部学习句（v8：句子是意义单位，状态随句走） */
  /* 下面三个回调都要 useCallback：SentenceCard 是 memo 的，传新引用进去
     浅比较必然失败，609 张卡一张都挡不住。而播放中父组件每秒重渲染约 4 次。 */
  const patchAll = useCallback(
    (s: SentenceV1, body: UnitStatePatch) => {
      for (const u of s.units) patch.mutate({ unitId: u.id, body })
      if (body.learned === true) noteLearned(sentenceText(s).text, voiceIdle())
    },
    [patch],
  )
  const handleEditSaved = useCallback(() => {
    void qc.invalidateQueries({ queryKey: ['sentences', trackId] })
  }, [qc, trackId])
  const handleGrammar = useCallback(
    (id: number) => {
      const hit = sentences.find((x) => x.id === id)
      if (hit !== undefined) onGrammarSentence(hit)
    },
    [sentences, onGrammarSentence],
  )

  /* 活跃句：activeOrdinal 是学习句序号，映射回其语法句 */
  const activeSentenceOrdinal = useMemo(() => {
    if (activeOrdinal < 0) return -1
    const hit = sentences.find((s) => s.units.some((u) => u.ordinal === activeOrdinal))
    return hit?.ordinal ?? -1
  }, [sentences, activeOrdinal])

  /* 跟随滚动（FR-107）：默认开且不被手动滚动打断——只有右上开关能关。
     v3 的"滚动即暂停跟随"按 scholar 要求移除。 */
  const stats = useMemo(() => {
    let units = 0
    let learned = 0
    for (const s of sentences) {
      if (s.is_noise) continue
      for (const u of s.units) {
        units += 1
        if (u.learned) learned += 1
      }
    }
    return { units, learned, sentences: sentences.filter((s) => !s.is_noise).length }
  }, [sentences])

  const shown = useMemo(
    () =>
      flagOnly
        ? sentences.filter((s) => s.units.some((u) => u.flagged))
        : sentences,
    [sentences, flagOnly],
  )

  const virtualizer = useVirtualizer({
    count: shown.length,
    getScrollElement: () => listEl,
    // 卡片高度随译文行数与折行变化，estimate 只是首帧占位，实高由
    // measureElement 量出来后回填
    estimateSize: () => 132,
    overscan: 6,
    getItemKey: (i) => shown[i]?.id ?? i,
  })

  useEffect(() => {
    if (!follow || activeSentenceOrdinal < 0) return
    // 虚拟化之后当前句多半没挂载，querySelector 找不到；按下标让虚拟化器滚
    const i = shown.findIndex((x) => x.ordinal === activeSentenceOrdinal)
    if (i >= 0) virtualizer.scrollToIndex(i, { align: 'center' })
  }, [activeSentenceOrdinal, follow, shown, virtualizer])


  return (
    <>
      <div className="vm-panel-head">
        <b>字幕列表</b>
        <span className="chip">{stats.sentences} 句</span>
        <div style={{ flex: 1 }} />
        <button
          className={`icon-btn${follow ? ' active' : ''}`}
          title={follow ? '跟随滚动：开（点击关闭）' : '跟随滚动：关（点击开启）'}
          onClick={() => onFollow(!follow)}
        >
          <IconLocate />
        </button>
        <button
          className={`vm-fchip${flagOnly ? ' active' : ''}`}
          onClick={() => setFlagOnly((v) => !v)}
        >
          <VIconFlag filled={flagOnly} />
          难句
        </button>
      </div>
      {mode !== 'zh' && (
        <div className="vm-legend-bar">
          <span>
            <i style={{ background: 'var(--hl-blue)' }} />
            短语动词
          </span>
          <span>
            <i style={{ background: 'var(--hl-green)' }} />
            搭配
          </span>
          <span>
            <i style={{ background: 'var(--hl-pink)' }} />
            习语
          </span>
          <div style={{ flex: 1 }} />
          <span>点击词组看解释</span>
        </div>
      )}
      {/* 只渲染视口里那几张。原先 609 条全挂，实测 34,440 个 DOM 节点、
          可视区只有 6 行——渲染了 100 倍于所见，而且它随视频长度线性涨。 */}
      <div className="vm-sub-list" ref={setListEl}>
        {shown.length === 0 && flagOnly && (
          <div className="panel-empty">
            <VIconFlag />
            <div>还没有旗标难句：句卡右上角旗子一点即入</div>
          </div>
        )}
        <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
        {virtualizer.getVirtualItems().map((vi) => {
          const s = shown[vi.index]
          if (s === undefined) return null
          return (
          <div
            key={vi.key}
            data-index={vi.index}
            ref={virtualizer.measureElement}
            style={{ position: 'absolute', top: 0, left: 0, width: '100%', transform: `translateY(${vi.start}px)` }}
          >
          <SentenceCard
            sentence={s}
            active={s.ordinal === activeSentenceOrdinal}
            mode={mode}
            editing={editingId === s.id}
            looping={loopSentenceId === s.id}
            rowPlaying={playingSentenceId === s.id}
            timeRef={timeRef}
            onJump={onJump}
            onWord={onWord}
            onPhrase={onPhrase}
            onPatchAll={patchAll}
            onEditSaved={handleEditSaved}
            onStartEdit={setEditingId}
            onShadowRow={onShadow}
            onToggleLoop={onToggleLoop}
            onTogglePlay={onTogglePlay}
            onGrammar={handleGrammar}
            onAskAi={onAskAi}
          />
          </div>
          )
        })}
        </div>
      </div>
      {!follow && (
        <div className="vm-panel-foot">
          <span>跟随滚动已关闭</span>
          <div style={{ flex: 1 }} />
          <button className="btn-ghost-sm" onClick={() => onFollow(true)}>
            <IconLocate />
            开启并回到当前句
          </button>
        </div>
      )}
    </>
  )
}
