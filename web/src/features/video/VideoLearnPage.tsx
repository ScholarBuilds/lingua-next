/* 视频学习页（对照 design/mockups/video-study.html）：左视频舞台（词级卡拉OK
   叠加字幕、两行控制条：倍速/隐藏视频/全屏/词组提示/A 点/A-B 循环/单句循环/
   句间间隔/单句暂停）+ 右栏八模式（双语/英语/中文/听写/挖空/阅读/中译英/词卡），
   栏宽可拖拽；点词/点词组走屏幕中央弹卡（复用阅读器 WordModal）。 */

import { useMutation, useQuery } from '@tanstack/react-query'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import type { MouseEvent } from 'react'

import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Switch } from '@/components/ui/switch'

import { IconAlert, IconSettings } from '../../components/icons'
import { Picker } from '@/components/ui/picker'
import { api } from '../../lib/api'
import { apiVideo, videoStreamUrl } from '../../lib/api-video'
import type { CuePhrase, CueV2, VideoTrackV2, SentenceV1 } from '../../lib/api-video'
import { playTts, stopTts } from '../../lib/audio'
import { WordModal } from '../reader/WordModal'
import { useReaderStore } from '../reader/readerStore'
import type { WordSelection } from '../reader/readerStore'
import { useVocabCollectionStore } from '../../lib/vocabCollectionStore'
import { useWordModalStore } from '../reader/wordModalStore'
import type { PhraseHost } from './CueText'
import { ClozePanel } from './ClozePanel'
import { SelectionBar } from '../companion/SelectionBar'
import { CompanionMode } from './CompanionMode'
import { DictationPanel } from './DictationPanel'
import { useVoiceCompanionStore } from '../mascot/useInlineVoiceCompanion'
import { EndScreen } from './EndScreen'
import { KaraokeCaption } from './KaraokeCaption'
import { CcMenu, PipButton, PlayerSettings, RateMenu, ShortcutHelp, VolumeControl } from './PlayerMenus'
import { SUB_SCALE_PX, usePlayerPrefs } from './playerPrefs'
import { ReadingPanel } from './ReadingPanel'
import { SubtitlePanel, unitText } from './SubtitlePanel'
import { TranslatePanel } from './TranslatePanel'
import { Stars, ACCENT_LABELS } from './VideoCard'
import { DeckRecommend } from '../vocab/DeckRecommend'
import { VocabPanel } from './VocabPanel'
import {
  VIconEyeOff,
  VIconFullscreen,
  VIconNextCue,
  VIconPauseSolid,
  VIconPhraseHint,
  VIconPinA,
  VIconPlaySolid,
  VIconPrevCue,
  VIconRestart,
  VIconRepeat,
  VIconRepeatOne,
  VIconStepPause,
  VIconTimerGap,
} from './icons'
import { useUrlValue } from '../../lib/urlState'
import './video-m5.css'
import { Topbar } from '../../components/Topbar'
import { POS_KEY, syncLibEntry, useVideoStudyStore } from './videoStudyStore'
import { ShadowStudio } from './ShadowStudio'
import { GrammarDialog } from './GrammarDialog'
import { OnlineVideoPanel } from './OnlineVideoPanel'
import {
  findActiveCue,
  findActiveWord,
  findRefCue,
  formatClock,
  slicePhrases,
  tokenizeCue,
  unitWords,
} from './videoUtils'

/** 字幕淡出时长 ms，与 .vm-caption-host 的 transition 对齐 */
const CAPTION_FADE_MS = 280

/** 短于此值的句间空隙一律桥接到下一句。
    BBC Subtitle Guidelines §4.5：空隙"必须至少一秒，最好一秒半，更短会产生明显的跳动感"；
    Netflix TTSG 更严，要求 0.5s 以内的空隙靠"延长上一句的出点"补掉。
    两家都是在成片时改出点，而不是让播放器把过期字幕挂着——这里按同一口径算显示出点。 */
const GAP_BRIDGE_MS = 1000

/** 算这一句该显示到什么时候。
    空隙大于 GAP_BRIDGE_MS 时按 lead-out 上限：BBC §5.2 封顶 1.5s，
    Karamitroglou (1998) 绝对上限 2s，Netflix 建议 0.5s。留太久观众会重读。 */
function captionUntilMs(
  units: ReadonlyArray<{ start_ms: number; end_ms: number }>,
  idx: number,
  holdMs: number,
): number {
  const cue = units[idx]
  if (cue === undefined) return 0
  const next = units[idx + 1]
  if (next !== undefined && next.start_ms - cue.end_ms < GAP_BRIDGE_MS) return next.start_ms
  return cue.end_ms + holdMs
}

type StudyMode = 'both' | 'en' | 'zh' | 'dict' | 'cloze' | 'read' | 'trans' | 'vocab' | 'companion'
const STUDY_MODES = ['both', 'en', 'zh', 'dict', 'cloze', 'read', 'trans', 'vocab', 'companion'] as const

const MODES: Array<{ key: StudyMode; label: string }> = [
  { key: 'both', label: '双语' },
  { key: 'en', label: '英语' },
  { key: 'zh', label: '中文' },
  { key: 'dict', label: '听写' },
  { key: 'cloze', label: '挖空' },
  { key: 'read', label: '阅读' },
  { key: 'trans', label: '中译英' },
  { key: 'vocab', label: '词卡' },
  { key: 'companion', label: 'AI 陪读' },
]

const GAPS = [0, 1, 2, 3, 5]

const BUSY_LABELS: Record<string, string> = {
  pending: '排队中',
  downloading: '下载中',
  transcribing: '转写中',
  translating: '翻译生成中',
}

/** 「还在跑」的白名单。**不要反过来排除终态**——那样每加一个终态
    （degraded 就是后加的）都会被当成进行中，页面永久转圈。 */
function isBusyStatus(status: string): boolean {
  return status in BUSY_LABELS
}

/** 距上句句尾 1s 内视为自然播过句尾（区别于跳转），触发循环/暂停/间隔 */
const BOUNDARY_MS = 1000
/** 点上一句时，进入本句超过该时长则回到本句开头而非上一句 */
const PREV_RESTART_MS = 1200

const PANEL_W_KEY = 'ln-video-panel-w'

/** 与后端 pick_primary_track 同序：默认轨 > official > whisper > auto，英轨优先 */
function pickPrimary(tracks: VideoTrackV2[]): VideoTrackV2 | undefined {
  const rank: Record<string, number> = { official: 0, whisper: 1, auto: 2 }
  return [...tracks]
    .filter((t) => t.kind !== 'translation' && !t.lang.toLowerCase().startsWith('zh'))
    .sort(
      (a, b) =>
        Number(!a.is_default) - Number(!b.is_default) ||
        (rank[a.kind] ?? 3) - (rank[b.kind] ?? 3) ||
        Number(!a.lang.toLowerCase().startsWith('en')) -
          Number(!b.lang.toLowerCase().startsWith('en')) ||
        a.id - b.id,
    )[0]
}

export function VideoLearnPage() {
  const { videoId = '' } = useParams()
  const navigate = useNavigate()

  const selectWord = useReaderStore((s) => s.selectWord)
  const selectPhrase = useReaderStore((s) => s.selectPhrase)
  const clearSelection = useReaderStore((s) => s.clearSelection)
  const openWordModal = useWordModalStore((s) => s.openWord)
  const openPhraseModal = useWordModalStore((s) => s.openPhrase)
  const modalOpen = useWordModalStore((s) => s.stack.length > 0)
  const setCollected = useVocabCollectionStore((state) => state.setCollected)
  const collected = useVocabCollectionStore((state) => state.collected)

  const loadStudy = useVideoStudyStore((s) => s.load)
  /* 已学统计走服务端（SubtitlePanel 的勾选也写服务端，两边同源避免打架） */
  const progressQuery = useQuery({
    queryKey: ['video-progress', videoId],
    queryFn: () => apiVideo.progress(videoId),
    enabled: videoId !== '',
  })
  const learnedCount = progressQuery.data?.learned ?? 0
  /* 卸载清理与节流保存都在闭包里跑，直接捕获 learnedCount 会是挂载那一刻的旧值 */
  const learnedRef = useRef(0)
  learnedRef.current = learnedCount
  const modeIdx = useVideoStudyStore((s) => s.modeIdx)
  const setModeIdx = useVideoStudyStore((s) => s.setModeIdx)

  useEffect(() => loadStudy(videoId), [videoId, loadStudy])

  /* ---- 详情与轨道 ---- */
  const [translating, setTranslating] = useState(false)

  const detailQuery = useQuery({
    queryKey: ['video', videoId],
    queryFn: () => apiVideo.video(videoId),
    enabled: videoId !== '',
    refetchInterval: (q) => {
      const v = q.state.data
      if (v === undefined) return false
      if (isBusyStatus(v.status)) return 3000
      return translating ? 3000 : false
    },
  })
  const video = detailQuery.data
  const tracks = useMemo(() => video?.tracks ?? [], [video])

  const [trackValue, setTrackValue] = useUrlValue<string>('track', '')
  const trackId = trackValue ? Number(trackValue) : null
  const setTrackId = (id: number | null) => setTrackValue(id === null ? '' : String(id))
  const activeTrack = useMemo(() => {
    const picked = trackId !== null ? tracks.find((t) => t.id === trackId) : undefined
    return picked ?? pickPrimary(tracks) ?? tracks[0]
  }, [tracks, trackId])

  const translate = useMutation({
    mutationFn: () => apiVideo.translateTrack(activeTrack!.id),
    onSuccess: () => setTranslating(true),
  })

  const retry = useMutation({
    mutationFn: () => apiVideo.retry(videoId),
    onSuccess: () => void detailQuery.refetch(),
  })

  const enrich = useMutation({
    mutationFn: () => apiVideo.enrich(videoId),
    onSuccess: () => void detailQuery.refetch(),
  })

  /* ---- 字幕数据 ---- */
  const cuesQuery = useQuery({
    queryKey: ['cues-v2', activeTrack?.id, activeTrack?.cue_count],
    queryFn: () => apiVideo.cues(activeTrack!.id),
    enabled: activeTrack !== undefined && activeTrack.cue_count > 0,
    staleTime: Infinity,
  })

  /* 三级模型：语法句承载译文与词组，学习句是播放与练习的单位（ADR-007） */
  const sentencesQuery = useQuery({
    queryKey: ['sentences', activeTrack?.id],
    queryFn: () => apiVideo.sentences(activeTrack!.id),
    enabled: activeTrack !== undefined,
    staleTime: Infinity,
  })
  const sentences = useMemo(() => sentencesQuery.data ?? [], [sentencesQuery.data])

  /* 有没有中文 = 有语音的句子里有多少条带 text_zh。
     以前看 translation 轨，那条轨服务端已经不建了（见下面 translating 复位那段），
     导致「生成中文字幕」按钮永远挂着、「双语字幕已缓存」永远不显示。
     用 0.9 而不是 1.0：噪声句与个别失败句不该让整片显示成「没翻译」。 */
  const zhReady = useMemo(() => {
    const speech = sentences.filter((x) => !x.is_noise)
    if (speech.length === 0) return false
    return speech.filter((x) => x.text_zh !== null && x.text_zh !== '').length >= speech.length * 0.9
  }, [sentences])

  /* 复位判据是**句子里有没有中文**，不是有没有 translation 轨。
     服务端早已改成一句一译写进 `sentence.text_zh`、不再建轨（ADR-007 FR-29），
     而这里还在找 `kind === 'translation'`——永远找不到，于是 translating 恒为
     true：设置面板的 spinner 永远转，ready 视频也被 3 秒一次无限轮询。 */
  useEffect(() => {
    if (!translating || sentences.length === 0) return
    if (zhReady) {
      setTranslating(false)
      void sentencesQuery.refetch()
    }
    // 翻完要把句子重新拉一遍：sentencesQuery 是 staleTime: Infinity，
    // 不主动 refetch 的话中文在库里而界面上还是没有
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [translating, sentences.length, zhReady])


  /* 单句循环的「一句」以右栏所见的语法句为准（FR-331、BR-72）。
     原实现循环的是学习句区间——一句被二次切分过时只转半句，
     用户看到的一句和听到的一句对不上。 */
  const unitToSentenceSpan = useMemo(() => {
    const map = new Map<number, { start: number; end: number; id: number }>()
    for (const sent of sentences) {
      const span = { start: sent.start_ms, end: sent.end_ms, id: sent.id }
      for (const u of sent.units) map.set(u.ordinal, span)
    }
    return map
  }, [sentences])

  /* 学习句派生成 cue 形态：播放控制与各学习模式统一吃这一份，
     拿到的是完整句而非按长度硬切的半句，各面板无需各自理解三级结构 */
  const units = useMemo<CueV2[]>(() => {
    const out: CueV2[] = []
    for (const s of sentences) {
      if (s.is_noise) continue // 非语音标记不进播放序列（BR-09）
      for (const u of s.units) {
        out.push({
          id: u.id,
          ordinal: u.ordinal,
          start_ms: u.start_ms,
          end_ms: u.end_ms,
          text: unitText(u),
          phrases:
            u.text_override !== null
              ? null
              : slicePhrases(s.phrases, u.char_start, u.char_end),
          words: unitWords(s.words, u.char_start, u.char_end),
        })
      }
    }
    return out
  }, [sentences])

  /** 学习句 → 所属语法句的译文（一句一译，不再按时间凑对） */
  const zhBySentence = useMemo(() => {
    const map = new Map<number, string>()
    for (const s of sentences) {
      if (s.text_zh === null) continue
      for (const u of s.units) map.set(u.id, s.text_zh)
    }
    return map
  }, [sentences])
  const zhOf = useCallback((cue: CueV2) => zhBySentence.get(cue.id), [zhBySentence])

  /** 人工修正已落服务端并合进 unitText，这里直接取 */
  const textOf = useCallback((cue: CueV2) => cue.text, [])

  /* ---- 生词状态 ---- */
  const words = useMemo(() => {
    const set = new Set<string>()
    for (const c of units) for (const t of tokenizeCue(c.text)) set.add(t.word)
    return [...set]
  }, [units])

  const vocabQuery = useQuery({
    queryKey: ['vocab-status-video', videoId, activeTrack?.id, words.length],
    queryFn: () => api.vocabStatus(words),
    enabled: words.length > 0,
    retry: false,
  })
  useEffect(() => {
    if (vocabQuery.data !== undefined) setCollected(vocabQuery.data.collected)
  }, [vocabQuery.data, setCollected])

  const vocabCount = useMemo(
    () => words.reduce((n, w) => (collected.has(w) ? n + 1 : n), 0),
    [words, collected],
  )
  const phraseCount = useMemo(
    () => units.reduce((n, c) => n + (c.phrases?.length ?? 0), 0),
    [units],
  )

  /* ---- 模式 ---- */
  // 右栏模式进 URL：刷新回到同一个模式，链接也能直达"这个视频的听写"（BR-G-011）
  const [mode, setMode] = useUrlValue<StudyMode>('m', 'both', STUDY_MODES)

  // 切模式收起词/词组浮层（听写/挖空不该被浮层盖住答案区）
  useEffect(() => clearSelection(), [mode, clearSelection])

  /* ---- 播放器状态 ---- */
  const videoRef = useRef<HTMLVideoElement>(null)
  const screenRef = useRef<HTMLDivElement>(null)
  const [playing, setPlaying] = useState(false)
  const [time, setTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [rate, setRate] = useState(() => usePlayerPrefs.getState().rate)
  const [audioOnly, setAudioOnly] = useState(false)
  const [phraseHints, setPhraseHints] = useState(false)
  const [sentencePause, setSentencePause] = useState(false)
  const [gapS, setGapS] = useState(0)
  const [loopCue, setLoopCue] = useState(false)
  /** 行级循环锁定的语法句；-1 = 跟着当前句走（FR-332 与播放器控件同一份状态） */
  const [loopSentenceId, setLoopSentenceId] = useState(-1)
  /** 跟读工作台的目标句（FR-335） */
  const [shadowTarget, setShadowTarget] = useState<SentenceV1 | null>(null)
  /** 语法分析的目标句（FR-358）：与跟读同层，才能共用视频片段播放与卡拉OK */
  const [grammarTarget, setGrammarTarget] = useState<SentenceV1 | null>(null)

  const [aMs, setAMs] = useState<number | null>(null)
  const [abLoop, setAbLoop] = useState<{ a: number; b: number } | null>(null)
  const [pauseOnWord, setPauseOnWord] = useState(true)
  const [activeIdx, setActiveIdx] = useState(-1)
  const [followValue, setFollowValue] = useUrlValue<string>('follow', '1', ['0', '1'])
  const follow = followValue === '1'
  const setFollow = (value: boolean) => setFollowValue(value ? '1' : '0')
  const playerPrefs = usePlayerPrefs()
  const [ended, setEnded] = useState(false)
  /* 本次学习计时（v9.1）：仅播放时累计，暂停不计 */
  const [studySec, setStudySec] = useState(0)
  const [helpOpen, setHelpOpen] = useState(false)
  /* 句间停顿高亮粘滞（v8 FR-106）：activeIdx 在间隙为 -1，显示层保留最后活跃句 */
  const [stickyIdx, setStickyIdx] = useState(-1)
  const timeMsRef = useRef(0)
  const activeIdxRef = useRef(-1)
  const lastSaveRef = useRef(0)
  const gapTimerRef = useRef<number | undefined>(undefined)
  const capTimerRef = useRef<number | undefined>(undefined)
  const lastCapRef = useRef<CueV2 | undefined>(undefined)
  /** 片段播放（听写/播放本句）：到点即停 */
  const segRef = useRef<{ endMs: number; restoreRate: number | null } | null>(null)

  /* 清掉片段凭据**之前**必须先把倍速还原。
     听写的「慢速重听」是 `playSegment(i, 0.75)`，恢复值存在 segRef.restoreRate 里，
     而恢复动作原先只写在「片段自然播到点」那一支；用户中途一暂停/跳转/拖进度条，
     四处 `segRef.current = null` 把凭据扔了却不还速率 —— playbackRate 停在 0.75，
     而 React 的 rate state 还是 1，倍速菜单高亮 1× 且**点当前档位修不好**
     （值没变，effect 不跑），只能切别的档再切回来或刷新页面。 */
  const clearSegment = useCallback(() => {
    const seg = segRef.current
    if (seg === null) return
    segRef.current = null
    const el = videoRef.current
    if (el !== null && seg.restoreRate !== null) el.playbackRate = seg.restoreRate
  }, [])
  /** 已在句尾暂停/间隔过的 cue 下标（同一句尾只处理一次） */
  const sentencePausedAtRef = useRef(-1)

  const posKey = POS_KEY(videoId)

  const setActive = useCallback((i: number) => {
    sentencePausedAtRef.current = -1
    activeIdxRef.current = i
    setActiveIdx(i)
  }, [])

  useEffect(() => {
    if (activeIdx >= 0) setStickyIdx(activeIdx)
  }, [activeIdx])

  /* 内嵌字幕停留（v9.2 FR-121）：短空隙桥到下一句、长空隙按 lead-out 上限淡出，
     口径见 captionUntilMs。暂停时不倒计时——停下来抄写正需要字幕在。 */
  const [capHeld, setCapHeld] = useState(-1)
  const capHeldRef = useRef(-1)
  const setHeld = useCallback((i: number) => {
    capHeldRef.current = i
    setCapHeld(i)
  }, [])

  useEffect(() => {
    window.clearTimeout(capTimerRef.current)
    if (activeIdx >= 0) {
      setHeld(activeIdx)
      return
    }
    const held = capHeldRef.current
    const cue = held >= 0 ? units[held] : undefined
    if (cue === undefined) {
      setHeld(-1)
      return
    }
    const until = captionUntilMs(units, held, playerPrefs.subHold)
    const nowMs = (videoRef.current?.currentTime ?? 0) * 1000
    // 跳转到别处后不该还挂着上一段的字幕
    if (nowMs < cue.start_ms || nowMs > until) {
      setHeld(-1)
      return
    }
    if (!playing) return
    capTimerRef.current = window.setTimeout(
      () => setHeld(-1),
      Math.max(0, until - nowMs) / Math.max(rate, 0.1),
    )
  }, [activeIdx, playing, rate, units, playerPrefs.subHold, setHeld])

  /* 叠加字幕取"活跃句 → 停留句"。两者都空时先淡出再真正卸载：
     光靠 CSS 过渡不够，透明但还在的字幕会把点视频暂停的点击吃掉。 */
  const capIdx = activeIdx >= 0 ? activeIdx : capHeld
  const capCue = capIdx >= 0 ? (units[capIdx] as CueV2 | undefined) : undefined
  if (capCue !== undefined) lastCapRef.current = capCue
  const [capMounted, setCapMounted] = useState(false)
  useEffect(() => {
    if (capIdx >= 0) {
      setCapMounted(true)
      return
    }
    const t = window.setTimeout(() => setCapMounted(false), CAPTION_FADE_MS)
    return () => window.clearTimeout(t)
  }, [capIdx])
  const renderCue = capMounted ? (capCue ?? lastCapRef.current) : undefined

  useEffect(() => {
    setActive(-1)
    setStickyIdx(-1)
    setHeld(-1)
    setAMs(null)
    setAbLoop(null)
  }, [videoId, activeTrack?.id, setActive, setHeld])

  useEffect(() => {
    const el = videoRef.current
    if (el === null || units.length === 0) return
    setActive(findActiveCue(units, el.currentTime * 1000))
  }, [units, setActive])

  /* 离开页面：清选择、停 TTS、存进度、同步库索引 */
  useEffect(() => {
    clearSelection()
    const media = videoRef.current
    return () => {
      clearSelection()
      stopTts()
      window.clearTimeout(gapTimerRef.current)
      window.clearTimeout(capTimerRef.current)
      const el = media
      el?.pause()
      if (el !== null && el.currentTime > 0) {
        localStorage.setItem(posKey, String(el.currentTime))
        syncLibEntry(videoId, units.length, learnedRef.current, el.currentTime)
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [videoId, video?.status, clearSelection, posKey])

  /* 已学句变化即时同步库索引（进度环数据源） */
  useEffect(() => {
    if (units.length === 0) return
    syncLibEntry(videoId, units.length, learnedCount, videoRef.current?.currentTime)
  }, [learnedCount, videoId, units.length])

  /* 开关镜像到 ref，同步函数不因开关切换重建 */
  /** 当前播放位置所在的语法句 id：行级循环/播放按钮的高亮依据 */
  /* 跟读弹窗的卡拉OK区间（FR-352）：弹窗开着时跟着播放位置算当前词。
     用独立的 state 而不是 timeMsRef，因为弹窗要真重渲染才看得到高亮走字。 */
  const [shadowKaraoke, setShadowKaraoke] = useState<[number, number] | null>(null)

  /** 播放某句的视频片段；正在播则暂停（FR-353/358 两个弹窗共用） */
  const toggleSentenceSegment = useCallback((sent: SentenceV1) => {
    const el = videoRef.current
    if (el === null) return
    if (!el.paused) {
      el.pause()
      return
    }
    const ms = el.currentTime * 1000
    if (ms < sent.start_ms || ms >= sent.end_ms) {
      el.currentTime = sent.start_ms / 1000 + 0.001
    }
    segRef.current = { endMs: sent.end_ms, restoreRate: null }
    void el.play().catch(() => {})
  }, [])

  /** 从句首重读（FR-360）：不管当前在哪、在不在播，一律回到句首 */
  const replaySentenceSegment = useCallback((sent: SentenceV1) => {
    const el = videoRef.current
    if (el === null) return
    el.currentTime = sent.start_ms / 1000 + 0.001
    segRef.current = { endMs: sent.end_ms, restoreRate: null }
    void el.play().catch(() => {})
  }, [])

  const activeSentenceId = useMemo(
    () => unitToSentenceSpan.get(units[activeIdx]?.ordinal ?? -1)?.id ?? -1,
    [unitToSentenceSpan, units, activeIdx],
  )

  const loopCueRef = useRef(loopCue)
  loopCueRef.current = loopCue
  const spanRef = useRef(unitToSentenceSpan)
  spanRef.current = unitToSentenceSpan
  const sentencePauseRef = useRef(sentencePause)
  sentencePauseRef.current = sentencePause
  const gapRef = useRef(gapS)
  gapRef.current = gapS
  const abRef = useRef(abLoop)
  abRef.current = abLoop
  const rateRef = useRef(rate)
  rateRef.current = rate

  /* 播放位置 → 当前 cue 同步与边界逻辑：A-B 循环 / 片段停 / 单句循环 /
     单句暂停 / 句间间隔。timeupdate 与 rAF 双通道，幂等可重入。 */
  const syncPlayback = useCallback(
    (el: HTMLVideoElement) => {
      const ms = el.currentTime * 1000
      // 片段播放到点即停（听写/播放本句）
      const seg = segRef.current
      if (seg !== null && ms >= seg.endMs) {
        el.pause()
        clearSegment()
      }
      // A-B 循环
      const ab = abRef.current
      if (ab !== null && !el.paused && ms >= ab.b) {
        el.currentTime = ab.a / 1000
        return
      }
      if (units.length === 0) return
      timeMsRef.current = ms
      const idx = findActiveCue(units, ms)
      const prev = activeIdxRef.current
      if (idx === prev) return
      const pc = prev >= 0 ? units[prev] : undefined
      if (!el.paused && pc !== undefined && ms >= pc.end_ms && ms < pc.end_ms + BOUNDARY_MS) {
        if (loopCueRef.current) {
          /* 回到所属语法句的句首（FR-331）。触发点也必须是**整句**读完——
             一句含多个学习句时，若在第一个学习句结束就跳回，后半句永远播不到。 */
          const span = spanRef.current.get(pc.ordinal)
          if (span === undefined) {
            el.currentTime = pc.start_ms / 1000
            return
          }
          if (ms >= span.end - BOUNDARY_MS) {
            el.currentTime = span.start / 1000
            return
          }
        }
        if (sentencePausedAtRef.current !== prev) {
          if (sentencePauseRef.current) {
            el.pause()
            el.currentTime = Math.max(pc.start_ms, pc.end_ms - 40) / 1000
            sentencePausedAtRef.current = prev
            return
          }
          if (gapRef.current > 0) {
            el.pause()
            el.currentTime = Math.max(pc.start_ms, pc.end_ms - 40) / 1000
            sentencePausedAtRef.current = prev
            window.clearTimeout(gapTimerRef.current)
            gapTimerRef.current = window.setTimeout(() => {
              const v = videoRef.current
              if (v !== null && v.paused) void v.play().catch(() => {})
            }, gapRef.current * 1000)
            return
          }
        }
      }
      setActive(idx)
    },
    [units, setActive],
  )

  /* 弹窗开着时驱动词级高亮（FR-352/359）：跟读与语法共用一套，
     都基于视频词级时间戳，所以高亮和右栏、和字幕完全一致。关了就不算，省掉无谓重渲染。 */
  const dialogSentence = shadowTarget ?? grammarTarget
  useEffect(() => {
    if (dialogSentence === null || !playing) {
      setShadowKaraoke(null)
      return
    }
    const words = dialogSentence.words
    if (words === null || words.length === 0) return
    const el = videoRef.current
    if (el === null) return

    const sync = () => {
      const i = findActiveWord(words, el.currentTime * 1000)
      const w = i >= 0 ? words[i] : undefined
      // 词级时间戳的 char 偏移是句内的，正好是 CueText 要的区间
      setShadowKaraoke(w !== undefined ? [w[3], w[4]] : null)
    }

    /* 双通道驱动：rAF 保证可见时逐帧顺滑，timeupdate 兜底——
       页签 hidden 时 rAF 整体冻结（本项目踩过多次），只挂 rAF 会让高亮直接停住。 */
    let raf = 0
    const tick = () => {
      sync()
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    el.addEventListener('timeupdate', sync)
    sync()
    return () => {
      cancelAnimationFrame(raf)
      el.removeEventListener('timeupdate', sync)
    }
  }, [dialogSentence, playing])

  useEffect(() => {
    if (!playing) return
    let raf = 0
    const tick = () => {
      const el = videoRef.current
      if (el !== null) syncPlayback(el)
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [playing, syncPlayback])

  useEffect(() => {
    if (videoRef.current !== null) videoRef.current.playbackRate = rate
  }, [rate])

  /* 从头开始（FR-125）：清掉片段/结束态回到 0 继续放，Home 键同义 */
  const restart = useCallback(() => {
    const el = videoRef.current
    if (el === null) return
    clearSegment()
    sentencePausedAtRef.current = -1
    window.clearTimeout(gapTimerRef.current)
    setEnded(false)
    el.currentTime = 0
    void el.play().catch(() => {})
  }, [])

  /* ---- 控制动作 ---- */
  const togglePlay = useCallback(() => {
    const el = videoRef.current
    if (el === null) return
    clearSegment()
    if (el.paused) void el.play().catch(() => {})
    else el.pause()
  }, [])

  const jumpToCue = useCallback(
    (i: number, autoplay = true) => {
      const el = videoRef.current
      const cue = units[i]
      if (el === null || cue === undefined) return
      clearSegment()
      setActive(i)
      el.currentTime = cue.start_ms / 1000 + 0.001
      setTime(el.currentTime)
      setFollow(true)
      if (autoplay) void el.play().catch(() => {})
    },
    [units, setActive],
  )

  /** 播放单句片段（句尾即停）；rateOverride 用于慢速重听 */
  const playSegment = useCallback(
    (i: number, rateOverride?: number) => {
      const el = videoRef.current
      const cue = units[i]
      if (el === null || cue === undefined) return
      setActive(i)
      el.currentTime = cue.start_ms / 1000 + 0.001
      setTime(el.currentTime)
      if (rateOverride !== undefined) {
        segRef.current = { endMs: cue.end_ms, restoreRate: rateRef.current }
        el.playbackRate = rateOverride
      } else {
        segRef.current = { endMs: cue.end_ms, restoreRate: null }
      }
      void el.play().catch(() => {})
    },
    [units, setActive],
  )

  const nav = useCallback(
    (dir: 1 | -1) => {
      const el = videoRef.current
      if (el === null || units.length === 0) return
      const ms = el.currentTime * 1000
      const ref = findRefCue(units, ms)
      let target: number
      if (dir === 1) target = Math.min(ref + 1, units.length - 1)
      else if (ref < 0) target = 0
      else if (ms - units[ref].start_ms > PREV_RESTART_MS) target = ref
      else target = Math.max(ref - 1, 0)
      jumpToCue(target)
    },
    [units, jumpToCue],
  )

  const cycleGap = () => setGapS((g) => GAPS[(GAPS.indexOf(g) + 1) % GAPS.length])

  const markA = () => {
    const el = videoRef.current
    if (el === null) return
    if (aMs !== null && abLoop === null) {
      setAMs(null)
      return
    }
    setAbLoop(null)
    setAMs(el.currentTime * 1000)
  }

  const toggleAb = () => {
    const el = videoRef.current
    if (el === null) return
    if (abLoop !== null) {
      setAbLoop(null)
      return
    }
    if (aMs === null) return
    const b = el.currentTime * 1000
    if (b <= aMs + 300) return
    setAbLoop({ a: aMs, b })
    el.currentTime = aMs / 1000
    void el.play().catch(() => {})
  }

  const toggleFullscreen = () => {
    const el = screenRef.current
    if (el === null) return
    if (document.fullscreenElement !== null) void document.exitFullscreen()
    else void el.requestFullscreen().catch(() => {})
  }

  /* 点词：字幕内高亮该词（selectWord）+ 屏幕中央弹词卡，字幕列表不被遮挡 */
  const handleWord = useCallback(
    (sel: WordSelection) => {
      const el = videoRef.current
      if (pauseOnWord) el?.pause()
      selectWord(sel)
      openWordModal(sel.surface, sel.sentenceText, sel.paragraphId)
      if (el === null || el.paused) playTts(sel.surface, 'video')
    },
    [pauseOnWord, selectWord, openWordModal],
  )

  const handlePhrase = useCallback(
    (phrase: CuePhrase, cue: PhraseHost) => {
      const el = videoRef.current
      if (pauseOnWord) el?.pause()
      const text = cue.text.slice(phrase[0], phrase[1])
      selectPhrase({ text, context: cue.text, paragraphId: cue.id })
      openPhraseModal(text, cue.text, cue.id)
    },
    [pauseOnWord, selectPhrase, openPhraseModal],
  )

  const seekTo = (e: MouseEvent<HTMLDivElement>) => {
    const el = videoRef.current
    if (el === null || duration <= 0) return
    const rect = e.currentTarget.getBoundingClientRect()
    const frac = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width))
    clearSegment()
    el.currentTime = frac * duration
    setTime(el.currentTime)
    setActive(findActiveCue(units, el.currentTime * 1000))
  }

  /* ---- video 事件 ---- */
  const onLoadedMetadata = () => {
    const el = videoRef.current
    if (el === null) return
    setDuration(el.duration)
    el.playbackRate = rate
    const saved = Number(localStorage.getItem(posKey) ?? 0)
    if (saved > 1 && saved < el.duration - 2) {
      el.currentTime = saved
      setTime(saved)
      setActive(findActiveCue(units, saved * 1000))
    }
  }

  const onTimeUpdate = () => {
    const el = videoRef.current
    if (el === null) return
    setTime(el.currentTime)
    if (!el.paused && !playing) setPlaying(true)
    syncPlayback(el)
    const now = Date.now()
    if (now - lastSaveRef.current > 3000) {
      lastSaveRef.current = now
      localStorage.setItem(posKey, String(el.currentTime))
      syncLibEntry(videoId, units.length, learnedRef.current, el.currentTime)
    }
  }

  /* 中央卡片关闭时清掉字幕里的选中态高亮 */
  useEffect(() => {
    if (!modalOpen) clearSelection()
  }, [modalOpen, clearSelection])

  /* ---- 快捷键 ---- */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // 中央卡片打开时空格/方向键归弹层，不再操控播放器
      if (modalOpen) return
      const t = e.target instanceof HTMLElement ? e.target : null
      if (t !== null && typeof t.closest !== 'function') return
      if (t !== null && (t.isContentEditable || t.closest('input, textarea, select'))) return
      const el = videoRef.current
      if (e.code === 'Space') {
        if (t?.closest('button')) return
        e.preventDefault()
        togglePlay()
      } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault()
        // Shift+←/→ 秒级快退快进，裸方向键句级跳转（FR-111）
        if (e.shiftKey && el !== null) {
          el.currentTime = Math.max(0, el.currentTime + (e.key === 'ArrowRight' ? 5 : -5))
        } else {
          nav(e.key === 'ArrowRight' ? 1 : -1)
        }
      } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        e.preventDefault()
        const { volume, muted } = usePlayerPrefs.getState()
        const next = Math.min(1, Math.max(0, volume + (e.key === 'ArrowUp' ? 0.05 : -0.05)))
        usePlayerPrefs.getState().set({ volume: next, muted: next === 0 ? muted : false })
      } else if (e.key === 'm' || e.key === 'M') {
        usePlayerPrefs.getState().set({ muted: !usePlayerPrefs.getState().muted })
      } else if (e.key === 'f' || e.key === 'F') {
        toggleFullscreen()
      } else if (e.key === 'p' || e.key === 'P') {
        if (el !== null && 'pictureInPictureEnabled' in document) {
          if (document.pictureInPictureElement !== null) void document.exitPictureInPicture()
          else void el.requestPictureInPicture().catch(() => {})
        }
      } else if (e.key === 'Home' || e.key === '0') {
        e.preventDefault()
        restart()
      } else if (e.key === '?') {
        setHelpOpen((v) => !v)
      } else if (e.key === 'Escape') {
        setHelpOpen(false)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [togglePlay, nav, modalOpen, toggleFullscreen, restart])

  useEffect(() => {
    if (!playing) return
    const timer = setInterval(() => setStudySec((v) => v + 1), 1000)
    return () => clearInterval(timer)
  }, [playing])

  /* AI 陪读说话时的视频协同（v9.1 FR-120）：默认暂停、说完自动恢复；
     可选压低音量（audio ducking，导航/Siri 对背景媒体的通行做法）。
     只恢复"因 AI 暂停"的播放——用户自己按的暂停不越权代恢复。 */
  const voiceSpeaking = useVoiceCompanionStore(
    (s) =>
      s.sourceKind === 'video' && s.articleId === Number(videoId) && s.status === 'speaking',
  )
  const aiDuckRef = useRef<{ pausedByAi: boolean; savedVolume: number | null }>({
    pausedByAi: false,
    savedVolume: null,
  })
  useEffect(() => {
    const el = videoRef.current
    if (el === null) return
    const policy = usePlayerPrefs.getState().aiDuck
    const state = aiDuckRef.current
    if (voiceSpeaking) {
      if (policy === 'pause' && !el.paused) {
        el.pause()
        state.pausedByAi = true
      } else if (policy === 'duck' && state.savedVolume === null) {
        state.savedVolume = el.volume
        el.volume = Math.min(el.volume, 0.15)
      }
    } else {
      if (state.pausedByAi) {
        state.pausedByAi = false
        void el.play().catch(() => {})
      }
      if (state.savedVolume !== null) {
        el.volume = state.savedVolume
        state.savedVolume = null
      }
    }
  }, [voiceSpeaking])

  /* 音量与静音：偏好 → video 元素单向同步（快捷键/滑杆改偏好即生效，FR-110） */
  useEffect(() => {
    const el = videoRef.current
    if (el === null) return
    el.volume = playerPrefs.volume
    el.muted = playerPrefs.muted
  }, [playerPrefs.volume, playerPrefs.muted])

  /* 倍速记忆（FR-108） */
  useEffect(() => {
    usePlayerPrefs.getState().set({ rate })
  }, [rate])

  /* ---- 栏宽拖拽 ---- */
  const panelRef = useRef<HTMLElement>(null)
  const [panelW, setPanelW] = useState(() => {
    const saved = Number(localStorage.getItem(PANEL_W_KEY))
    // v9 FR-114：范围放宽到 300 至视口 55%，各块随分栏自适应
    return saved >= 300 && saved <= window.innerWidth * 0.55 ? saved : 430
  })
  const [dragging, setDragging] = useState(false)
  const startDrag = (e: MouseEvent) => {
    e.preventDefault()
    setDragging(true)
    const startX = e.clientX
    const startW = panelW
    const maxW = window.innerWidth * 0.55
    const onMove = (ev: globalThis.MouseEvent) => {
      const w = Math.min(maxW, Math.max(300, startW + (startX - ev.clientX)))
      setPanelW(w)
    }
    const onUp = (ev: globalThis.MouseEvent) => {
      setDragging(false)
      const w = Math.min(maxW, Math.max(300, startW + (startX - ev.clientX)))
      localStorage.setItem(PANEL_W_KEY, String(w))
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  /* ---- 模式独立进度（FR-15）---- */
  const fallbackIdx = activeIdx >= 0 ? activeIdx : 0
  const dictIdx = Math.min(modeIdx.dict ?? fallbackIdx, Math.max(0, units.length - 1))
  const clozeIdx = Math.min(modeIdx.cloze ?? fallbackIdx, Math.max(0, units.length - 1))
  const transIdx = Math.min(modeIdx.trans ?? fallbackIdx, Math.max(0, units.length - 1))
  const vocabIdx = modeIdx.vocab ?? 0

  /* ---- 未就绪三态壳 ---- */
  /** 学习句 ordinal → units 下标：噪声句不进播放序列，两者不是同一套编号 */
  const ordinalToIdx = useCallback(
    (ordinal: number) => units.findIndex((u) => u.ordinal === ordinal),
    [units],
  )

  /* 词卡「回到出处」。**必须在 units 里找，不能在 raw cues 里找**：
     playSegment 是按 units 下标寻址的，而原先写的是 `cues.findIndex(...)`——
     两套编号（cue 424 条 vs unit 685 条）跨体系取号，跳到的是另一句。
     ordinalToIdx 本来就是为这件事写的，之前没人调用它。 */
  const jumpToOrdinal = useCallback(
    (ordinal: number) => {
      const i = ordinalToIdx(ordinal)
      if (i >= 0) playSegment(i)
    },
    [ordinalToIdx, playSegment],
  )

  /* ---- 右栏字幕的回调一律 useCallback ----

     `SentenceCard` 是 memo 的，`SubtitlePanel` 也做了 memo，但只要这里传下去的
     函数每次渲染都是新引用，浅比较必然失败——609 张卡一张都挡不住。
     而播放中 `onTimeUpdate` 每秒 setTime 约 4 次，等于每秒把整棵列表重跑 4 遍。
     memo 不是摆设，是这几个 useCallback 让它生效。 */
  const jumpByOrdinal = useCallback(
    (ordinal: number) => jumpToCue(ordinalToIdx(ordinal)),
    [jumpToCue, ordinalToIdx],
  )
  const playByOrdinal = useCallback(
    (ordinal: number) => playSegment(ordinalToIdx(ordinal)),
    [playSegment, ordinalToIdx],
  )
  const askAiFromPanel = useCallback(() => setMode('companion'), [])
  const toggleLoopSentence = useCallback(
    (sent: SentenceV1) => {
      // 行上的循环与播放器「单句循环」是同一份状态（FR-332）
      const on = !(loopCue && loopSentenceId === sent.id)
      setLoopCue(on)
      setLoopSentenceId(on ? sent.id : -1)
      if (on) jumpToCue(ordinalToIdx(sent.units[0]?.ordinal ?? 0))
    },
    [loopCue, loopSentenceId, jumpToCue, ordinalToIdx],
  )
  const toggleSentencePlay = useCallback(
    (sent: SentenceV1) => {
      const el = videoRef.current
      if (el === null) return
      const ms = el.currentTime * 1000
      // 暂停后再点从暂停处续播，只有不在本句范围内才跳回句首（FR-333、BR-73）
      if (!el.paused && activeSentenceId === sent.id) {
        el.pause()
        return
      }
      if (ms < sent.start_ms || ms > sent.end_ms) {
        el.currentTime = sent.start_ms / 1000
      }
      void el.play().catch(() => {})
    },
    [activeSentenceId],
  )
  const openShadow = useCallback((sent: SentenceV1) => setShadowTarget(sent), [])
  const openGrammar = useCallback((sent: SentenceV1) => setGrammarTarget(sent), [])

  /* degraded = 管线跑完但产物不达标（句层空/译文缺），是**终态**。
     只要还有字幕轨就该放人进去看（库页的卡片也是这么标的：标黄、仍可看），
     拦在门外的只有「一条字幕都没有」那种，进去也是空屏。 */
  const watchable =
    video !== undefined &&
    (video.status === 'ready' || (video.status === 'degraded' && tracks.length > 0))

  if (video?.status === 'online') return <OnlineVideoPanel video={video} />
  if (!watchable) {
    // **用白名单列「进行中」，不要用排除法列终态**：原先写的是
    // `!== 'ready' && !== 'failed'`，于是后加的终态 degraded 被当成进行中，
    // 页面永久转圈等一个永远不会来的完成信号，还每 3 秒轮询一次。
    const busy = video !== undefined && isBusyStatus(video.status)
    return (
      <div className="main">
        <Topbar back={{ to: '/video', label: '视频' }} title={video?.title_zh ?? video?.title ?? '…'} />
        <div className="content">
          <div className="state-block" style={{ paddingTop: 120 }}>
            {detailQuery.isPending && (
              <>
                <span className="spinner" />
                <div>视频加载中…</div>
              </>
            )}
            {detailQuery.isError && (
              <>
                <IconAlert />
                <div>视频加载失败，请确认服务端已启动</div>
                <button className="btn btn-outline" onClick={() => void detailQuery.refetch()}>
                  重试
                </button>
              </>
            )}
            {busy && video !== undefined && (
              <>
                <span className="spinner" />
                <div>
                  {BUSY_LABELS[video.status] ?? video.status}… {video.progress}%
                </div>
                <div style={{ fontSize: 'var(--text-xs)', color: 'var(--ink-faint)' }}>
                  处理完成后自动进入学习页
                </div>
              </>
            )}
            {video?.status === 'degraded' && (
              <>
                <IconAlert />
                <div className="panel-error">这个视频没有产出可用字幕</div>
                <div style={{ fontSize: 'var(--text-xs)', color: 'var(--ink-muted)', maxWidth: 420, lineHeight: 1.8 }}>
                  媒体已经下载好，但转写没有出内容（常见于纯音乐、无人声或语言不匹配的片子）。
                  可以重跑管线试试，或者去管线页看是哪一步没出东西。
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button
                    className="btn btn-outline"
                    disabled={retry.isPending}
                    onClick={() => retry.mutate()}
                  >
                    {retry.isPending ? '重跑中…' : '重跑管线'}
                  </button>
                  <button className="btn" onClick={() => navigate(`/video/${videoId}/pipeline`)}>
                    查看管线
                  </button>
                </div>
              </>
            )}
            {video?.status === 'failed' && (
              <>
                <IconAlert />
                <div className="panel-error">{video.error ?? '处理失败'}</div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button
                    className="btn btn-outline"
                    disabled={retry.isPending}
                    onClick={() => retry.mutate()}
                  >
                    {retry.isPending ? '重试中…' : '重试处理'}
                  </button>
                  {video.error_kind === 'bot_check' && (
                    <button className="btn" onClick={() => navigate('/settings')}>
                      去配置凭证
                    </button>
                  )}
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    )
  }

  /* ---- 就绪：完整学习页 ---- */
  const totalSeconds = duration > 0 ? duration : (video.duration_s ?? 0)
  const hasWords = units.some((c) => (c.words?.length ?? 0) > 0)
  const approximate = activeTrack?.meta?.approximate === true
  const hasZhTrack = zhReady

  /* 内嵌字幕（v9.1 FR-116）：CC 菜单显式覆盖优先，auto 跟随右栏模式；
     陪读模式默认双语（scholar：陪读时字幕不能消失）；听写/挖空强制隐藏防作弊 */
  const cap = playerPrefs.captionMode
  const autoEn =
    mode === 'both' || mode === 'en' || mode === 'read' || mode === 'vocab' ||
    mode === 'companion'
  const autoZh =
    mode === 'both' || mode === 'zh' || mode === 'trans' || mode === 'vocab' ||
    mode === 'companion'
  const showEnCaption = cap === 'auto' ? autoEn : cap === 'both' || cap === 'en'
  const showZhCaption = cap === 'auto' ? autoZh : cap === 'both' || cap === 'zh'
  const captionVisible =
    cap !== 'off' && mode !== 'dict' && mode !== 'cloze' && renderCue !== undefined &&
    (showEnCaption || showZhCaption)

  const trackPct = (ms: number) => (totalSeconds > 0 ? (ms / 1000 / totalSeconds) * 100 : 0)

  return (
    <div className="main">
      <Topbar
        back={{ to: '/video', label: '视频库' }}
        title={
          <span className="vm-topbar-title" title={video.title}>
            {video.title_zh ?? video.title}
          </span>
        }
        meta={
          <>
            {video.difficulty !== null && (
              <span className="vm-topbar-stars">
                <Stars n={video.difficulty} />
              </span>
            )}
            {video.accent !== null && (
              <span className="chip accent">{ACCENT_LABELS[video.accent] ?? video.accent}</span>
            )}
          </>
        }
        actions={
          <>
            <div className="seg">
              {MODES.map((m) => (
                <button
                  key={m.key}
                  className={mode === m.key ? 'active' : ''}
                  onClick={() => setMode(m.key)}
                >
                  {m.label}
                </button>
              ))}
            </div>
            <Popover>
              <PopoverTrigger asChild>
                <button className="icon-btn" title="播放设置">
                  <IconSettings />
                </button>
              </PopoverTrigger>
              <PopoverContent align="end" className="w-72 p-3.5">
                <div className="vm-pref-row">
                  <span className="lbl">点词自动暂停</span>
                  <Switch checked={pauseOnWord} onCheckedChange={setPauseOnWord} />
                </div>
                <div className="vm-pref-row">
                  <span className="lbl">字幕轨</span>
                  <Picker
                    size="sm"
                    className="engine-select"
                    value={activeTrack === undefined || activeTrack === null ? '' : String(activeTrack.id)}
                    onChange={(v) => setTrackId(Number(v))}
                    options={tracks
                      .filter((t) => t.kind !== 'translation')
                      .map((t) => ({ value: String(t.id), label: t.label, hint: t.kind }))}
                  />
                </div>
                {!hasZhTrack && activeTrack !== undefined && (
                  <div className="vm-pref-row">
                    <span className="lbl">中文字幕</span>
                    {translating ? (
                      <span className="chip">
                        <span className="spinner" />
                        生成中…
                      </span>
                    ) : (
                      <button
                        className="btn btn-soft btn-sm"
                        disabled={translate.isPending}
                        onClick={() => translate.mutate()}
                      >
                        {translate.isPending ? '请求中…' : '生成中文字幕'}
                      </button>
                    )}
                  </div>
                )}
                {video.enrich_status !== 'done' && (
                  <div className="vm-pref-row">
                    <span className="lbl">AI 加工（词组/词卡）</span>
                    <button
                      className="btn btn-soft btn-sm"
                      disabled={enrich.isPending}
                      onClick={() => enrich.mutate()}
                    >
                      触发加工
                    </button>
                  </div>
                )}
              </PopoverContent>
            </Popover>
          </>
        }
      />

      <ShortcutHelp open={helpOpen} onClose={() => setHelpOpen(false)} />
      <div className="body-row">
        {/* ============ 左：视频舞台 ============ */}
        <div className="vm-stage">
          <div className={`vm-screen${audioOnly ? ' audio-only' : ''}`} ref={screenRef}>
            <video
              ref={videoRef}
              src={videoStreamUrl(video.id)}
              preload="metadata"
              onClick={togglePlay}
              onDoubleClick={toggleFullscreen}
              onPlay={() => setPlaying(true)}
              onPause={() => {
                setPlaying(false)
                const el = videoRef.current
                if (el !== null) {
                  localStorage.setItem(posKey, String(el.currentTime))
                  syncLibEntry(videoId, units.length, learnedRef.current, el.currentTime)
                }
              }}
              onTimeUpdate={onTimeUpdate}
              onLoadedMetadata={onLoadedMetadata}
              onEnded={() => setEnded(true)}
              onSeeked={() => {
                setEnded(false)
                const held = capHeldRef.current
                const cue = held >= 0 ? units[held] : undefined
                const el = videoRef.current
                if (cue === undefined || el === null) return
                const ms = el.currentTime * 1000
                if (ms < cue.start_ms || ms > captionUntilMs(units, held, playerPrefs.subHold)) {
                  setHeld(-1)
                }
              }}
            />
            <div className="vm-hud">
              {audioOnly && <span>纯听力</span>}
              {approximate && hasWords && <span>词级·近似</span>}
              {!approximate && hasWords && <span>词级对齐</span>}
              <span>
                CC{' '}
                {!captionVisible
                  ? '关'
                  : showEnCaption && showZhCaption
                    ? '双语'
                    : showEnCaption
                      ? '英语'
                      : '中文'}
              </span>
            </div>
            {audioOnly && (
              <div className={`vm-eq${playing ? ' playing' : ''}`} aria-hidden>
                {Array.from({ length: 24 }, (_, i) => (
                  <i key={i} />
                ))}
              </div>
            )}
            {!playing && !audioOnly && (
              <button className="vm-bigplay" title="播放" onClick={togglePlay}>
                <VIconPlaySolid style={{ width: 22, height: 22 }} />
              </button>
            )}
            {ended && (
              <EndScreen
                current={{ id: video.id, channel: video.channel, difficulty: video.difficulty }}
                onReplay={restart}
              />
            )}
            {captionVisible && renderCue !== undefined && (
              <div
                className={`vm-caption-host${capCue === undefined ? ' out' : ''}`}
                style={{
                  ['--sub-bg-alpha' as string]: String(playerPrefs.subBgAlpha / 100),
                  ['--sub-font-px' as string]: `${SUB_SCALE_PX[playerPrefs.subScale]}px`,
                  ['--sub-offset' as string]: `${playerPrefs.subOffset}%`,
                }}
              >
              <KaraokeCaption
                cue={renderCue}
                zh={zhOf(renderCue)}
                videoRef={videoRef}
                playing={playing}
                showEn={showEnCaption}
                showZh={showZhCaption}
                phraseHints={phraseHints}
                onWord={handleWord}
                onPhrase={handlePhrase}
              />
              </div>
            )}
          </div>

          {/* 控制条（两行） */}
          <div className="card vm-ctl">
            <div className="vm-ctl-r1">
              <RateMenu rate={rate} onRate={setRate} />
              <VolumeControl
                volume={playerPrefs.volume}
                muted={playerPrefs.muted}
                onVolume={(v) => playerPrefs.set({ volume: v, muted: v === 0 })}
                onMute={() => playerPrefs.set({ muted: !playerPrefs.muted })}
              />
              <button
                className={`icon-btn${audioOnly ? ' active' : ''}`}
                title={audioOnly ? '恢复画面' : '隐藏视频（纯听力）'}
                onClick={() => setAudioOnly((v) => !v)}
              >
                <VIconEyeOff />
              </button>
              <button className="icon-btn" title="全屏（F）" onClick={toggleFullscreen}>
                <VIconFullscreen />
              </button>
              <PipButton videoRef={videoRef} />
              <CcMenu />
              <PlayerSettings />
              <button
                className={`icon-btn${phraseHints ? ' active' : ''}`}
                title={`词组提示行（字幕下方释义）：${phraseHints ? '开' : '关'}`}
                onClick={() => setPhraseHints((v) => !v)}
              >
                <VIconPhraseHint />
              </button>
              <div className="vm-track" onClick={seekTo}>
                {abLoop !== null && (
                  <span
                    className="bzone"
                    style={{
                      left: `${trackPct(abLoop.a)}%`,
                      width: `${trackPct(abLoop.b - abLoop.a)}%`,
                    }}
                  />
                )}
                {(aMs !== null || abLoop !== null) && (
                  <span
                    className="amark"
                    style={{ left: `${trackPct(abLoop?.a ?? aMs ?? 0)}%` }}
                  />
                )}
                <span
                  className="fill"
                  style={{
                    width: `${totalSeconds > 0 ? Math.min(100, (time / totalSeconds) * 100) : 0}%`,
                  }}
                />
              </div>
              <span className="vm-ctl-time">
                {formatClock(time)} <i>/ {formatClock(totalSeconds)}</i>
              </span>
            </div>
            <div className="vm-ctl-r2">
              <button
                className="vm-tctl"
                title="从头开始（Home）"
                onClick={restart}
              >
                <VIconRestart />
                <span>从头</span>
              </button>
              <button
                className="vm-tctl"
                title="上一句"
                disabled={units.length === 0}
                onClick={() => nav(-1)}
              >
                <VIconPrevCue />
                <span>上一句</span>
              </button>
              <button className="vm-tctl-play" title={playing ? '暂停' : '播放'} onClick={togglePlay}>
                {playing ? (
                  <VIconPauseSolid style={{ width: 18, height: 18 }} />
                ) : (
                  <VIconPlaySolid style={{ width: 18, height: 18 }} />
                )}
              </button>
              <button
                className="vm-tctl"
                title="下一句"
                disabled={units.length === 0}
                onClick={() => nav(1)}
              >
                <VIconNextCue />
                <span>下一句</span>
              </button>
              <div className="vm-ctl-gap" />
              <button
                className={`vm-tctl${aMs !== null && abLoop === null ? ' on' : ''}`}
                title={
                  aMs === null
                    ? '标记 A 点（当前时间）'
                    : `A 点已标于 ${formatClock((abLoop?.a ?? aMs) / 1000)}，再点清除`
                }
                onClick={markA}
              >
                <VIconPinA />
                <span>A 点</span>
              </button>
              <button
                className={`vm-tctl${abLoop !== null ? ' on' : ''}`}
                title={
                  abLoop !== null
                    ? 'A-B 循环中，点击停止'
                    : aMs !== null
                      ? '以当前时间为 B 点开始循环'
                      : '先标 A 点，再到 B 处开启'
                }
                disabled={aMs === null && abLoop === null}
                onClick={toggleAb}
              >
                <VIconRepeat />
                <span>A-B 循环</span>
              </button>
              <button
                className={`vm-tctl${loopCue ? ' on' : ''}`}
                title={`单句循环：${loopCue ? '开' : '关'}`}
                onClick={() => setLoopCue((v) => !v)}
              >
                <VIconRepeatOne />
                <span>单句循环</span>
              </button>
              <div className="vm-ctl-gap" />
              <button
                className={`vm-tctl${gapS > 0 ? ' on' : ''}`}
                title={`句间间隔（每句播完停 ${gapS}s 再继续），点击轮换 0-5s`}
                onClick={cycleGap}
              >
                <VIconTimerGap />
                <span>{gapS > 0 ? `间隔 ${gapS}s` : '间隔'}</span>
              </button>
              <button
                className={`vm-tctl${sentencePause ? ' on' : ''}`}
                title={`每句播完自动暂停：${sentencePause ? '开' : '关'}`}
                onClick={() => setSentencePause((v) => !v)}
              >
                <VIconStepPause />
                <span>单句暂停</span>
              </button>
            </div>
          </div>

          {/* 底部信息行 */}
          <div className="vm-stage-meta">
            <span className="chip">
              已学 {learnedCount}/{units.length} 句
            </span>
            {vocabCount > 0 && <span className="chip warn">生词 {vocabCount}</span>}
            {phraseCount > 0 && <span className="chip">词组 {phraseCount}</span>}
            <span className="lbl">
              {hasWords
                ? approximate
                  ? '词级时间戳按字符比例近似插值'
                  : 'whisper 词级对齐'
                : '本轨无词级时间戳'}
              {hasZhTrack ? ' · 双语字幕已缓存' : ''}
            </span>
            <div style={{ flex: 1 }} />
            {studySec >= 30 && (
              <span className="chip" title="本次学习时长（播放中才计时）">
                本次 {formatClock(studySec)}
              </span>
            )}
            <button
              className="btn-ghost-sm"
              title="键盘快捷键（?）"
              onClick={() => setHelpOpen(true)}
            >
              快捷键 ?
            </button>
          </div>
        </div>

        {/* 栏宽拖拽 */}
        <div
          className={`vm-resizer${dragging ? ' dragging' : ''}`}
          onMouseDown={startDrag}
          title="拖拽调整栏宽"
        />

        {/* ============ 右栏：模式面板 ============ */}
        <aside
          ref={panelRef}
          className="vm-panel"
          style={{ width: mode === 'read' ? Math.max(panelW, 560) : panelW }}
        >
          {(mode === 'both' || mode === 'en' || mode === 'zh') && (
            <SubtitlePanel
              videoId={videoId}
              trackId={activeTrack?.id}
              sentences={sentences}
              activeOrdinal={units[stickyIdx]?.ordinal ?? -1}
              mode={mode}
              follow={follow}
              onFollow={setFollow}
              timeRef={timeMsRef}
              onJump={jumpByOrdinal}
              onPlay={playByOrdinal}
              onWord={handleWord}
              onPhrase={handlePhrase}
              onAskAi={askAiFromPanel}
              loopSentenceId={loopCue ? (loopSentenceId >= 0 ? loopSentenceId : activeSentenceId) : -1}
              playingSentenceId={playing ? activeSentenceId : -1}
              onToggleLoop={toggleLoopSentence}
              onTogglePlay={toggleSentencePlay}
              onShadow={openShadow}
              onGrammarSentence={openGrammar}
            />
          )}
          {mode === 'dict' && (
            <DictationPanel
              onAskAi={() => setMode('companion')}
              cues={units}
              idx={dictIdx}
              setIdx={(i) => setModeIdx('dict', i)}
              playSegment={playSegment}
              textOf={textOf}
            />
          )}
          {mode === 'cloze' && (
            <ClozePanel
              cues={units}
              idx={clozeIdx}
              setIdx={(i) => setModeIdx('cloze', i)}
              playSegment={playSegment}
              zhOf={zhOf}
            />
          )}
          {mode === 'read' && (
            <ReadingPanel
              cues={units}
              activeIdx={activeIdx}
              title={video.title_zh ?? video.title}
              channel={video.channel}
              durationS={video.duration_s}
              textOf={textOf}
              onWord={handleWord}
              onPhrase={handlePhrase}
              onJump={jumpToCue}
            />
          )}
          {mode === 'trans' && (
            <TranslatePanel
              cues={units}
              idx={transIdx}
              setIdx={(i) => setModeIdx('trans', i)}
              playSegment={playSegment}
              zhOf={zhOf}
              textOf={textOf}
            />
          )}
          {mode === 'companion' && (
            <CompanionMode
              videoId={video.id}
              unitOrdinal={units[activeIdx]?.ordinal ?? -1}
              title={video.title_zh || video.title}
            />
          )}
          {mode === 'vocab' && <DeckRecommend videoId={Number(videoId)} />}
          {mode === 'vocab' && (
            <VocabPanel
              videoId={videoId}
              cues={units}
              idx={vocabIdx}
              setIdx={(i) => setModeIdx('vocab', i)}
              onJumpOrdinal={jumpToOrdinal}
              onEnrichVocab={() => enrich.mutate()}
            />
          )}

          {(activeTrack === undefined || activeTrack.cue_count === 0) && (
            <div className="panel-empty">
              <IconAlert />
              <div>本视频暂无字幕轨</div>
            </div>
          )}
          {cuesQuery.isError && (
            <div className="panel-error" style={{ padding: '12px 16px' }}>
              字幕加载失败{' '}
              <button className="btn-ghost-sm" onClick={() => void cuesQuery.refetch()}>
                重试
              </button>
            </div>
          )}
        </aside>
      </div>

      {/* 拖选字幕任意片段 → 问 AI / 查词组（FR-14），覆盖单句按钮够不着的场景 */}
      <SelectionBar
        containerRef={panelRef}
        source={formatClock(time)}
        onPhrase={(text) => openPhraseModal(text, units[activeIdx]?.text ?? text)}
      />

      {/* 词卡 / 词组解释：屏幕中央弹卡（与文章阅读一致），字幕列表保持可见 */}
      {grammarTarget !== null && (
        <GrammarDialog
          host={grammarTarget}
          playing={playing && !videoRef.current?.paused}
          karaoke={shadowKaraoke}
          onPlay={() => toggleSentenceSegment(grammarTarget)}
          onReplay={() => replaySentenceSegment(grammarTarget)}
          zh={grammarTarget.text_zh}
          onWord={handleWord}
          onPhrase={handlePhrase}
          onClose={() => setGrammarTarget(null)}
        />
      )}

      {shadowTarget !== null && (
        <ShadowStudio
          videoId={Number(videoId)}
          sentenceId={shadowTarget.id}
          unitId={shadowTarget.units[0]?.id}
          source={{
            text: shadowTarget.text,
            start_ms: shadowTarget.start_ms,
            end_ms: shadowTarget.end_ms,
            words: shadowTarget.words,
          }}
          phrases={shadowTarget.phrases}
          playing={playing && !videoRef.current?.paused}
          karaoke={shadowKaraoke}
          onWord={handleWord}
          onPhrase={handlePhrase}
          onPlayOriginal={() => toggleSentenceSegment(shadowTarget)}
          onReplayOriginal={() => replaySentenceSegment(shadowTarget)}
          zh={shadowTarget.text_zh}
          onClose={() => setShadowTarget(null)}
        />
      )}

      <WordModal videoId={video.id} />
    </div>
  )
}
