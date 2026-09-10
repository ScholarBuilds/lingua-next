/* 场景短文（需求 01 v2 §15.2）：把本内的词织进一段真实语境。

   词单独背是孤立的，放进对话或短文里才知道怎么用。本内词在文中高亮标出——
   「学过的词又出现了」这件事必须可见，否则串语境这件事对用户不成立（BR-52）。 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useHotkeys } from 'react-hotkeys-hook'
import { useNavigate } from 'react-router-dom'

import {
  IconChevronLeft,
  IconChevronRight,
  IconLocate,
  IconMic,
  IconPause,
  IconPlay,
  IconRepeatOne,
  IconSkipBack,
  IconSparkle,
  IconSpeaker,
} from '../../components/icons'
import type { Deck, PassageParagraph } from '../../lib/api-deck'
import { apiScenario } from '../../lib/api-deck'
import { ACCENT_VOICES, playUrl, setPlaybackRate, stopTts, ttsUrl } from '../../lib/audio'
import { VoicePicker } from '../../components/VoicePicker'
import { RatePicker } from '../../components/RatePicker'
import { VoiceCompanionAside } from '../companion/VoiceCompanion'
import { useCompanionContext } from '../companion/contextStore'
import { useWordModalStore } from '../reader/wordModalStore'
import { SentencePanel } from '../reader/SentencePanel'
import { sentenceSel, splitSentences } from '../reader/sentencePick'
import { IconGrammar } from '../reader/readerIcons'
import '../reader/reader-m5.css'

const WORD_RE = /([A-Za-z][A-Za-z'’-]+)/g

/** 可选语速：慢放听清连读，快放做泛听 */
const RATES = [0.6, 0.75, 0.9, 1, 1.15, 1.35]

/** 未配置时的兜底音色：按角色出场顺序轮着分，至少保证听起来不是同一个人 */
const FALLBACK_VOICES = [
  ACCENT_VOICES.us,
  ACCENT_VOICES.uk,
  'edge:en-US-GuyNeural',
  'edge:en-GB-RyanNeural',
]

export function PassagePane({ deck }: { deck: Deck }) {
  const deckId = Number(deck.key.split(':')[1])
  const navigate = useNavigate()
  const qc = useQueryClient()
  const openWord = useWordModalStore((s) => s.openWord)
  const [playing, setPlaying] = useState<number | null>(null)

  const query = useQuery({
    queryKey: ['deck-passage', deckId],
    queryFn: () => apiScenario.passage(deckId),
    retry: false,
  })

  const extend = useMutation({
    mutationFn: (words: string[]) => apiScenario.extendPassage(deckId, words),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['deck-passage', deckId] }),
  })

  const [companion, setCompanion] = useState(false)
  const [voiceRole, setVoiceRole] = useState<string | null>(null)
  /* 语法解析的落点：段内第几句。整段可能有两三句（截图里 Lily 那段就是三句），
     而句级分析按单句吃——把三句一起喂进去，讲出来的结构是糊的。
     （原注写的是 `/grammar/analyze`，那条 spaCy 路由已删；切句这条理由与端点无关。） */
  const [grammarAt, setGrammarAt] = useState<{ para: number; sent: number } | null>(null)

  /* 右栏是一个槽位、两个面板，互斥必须写在改 state 的地方。
     曾经只在渲染处用 `companion && grammarAt === null` 挡着，结果 state 跟画面脱钩：
     语法栏开着时点「AI 陪读」按钮会亮但不出栏，等收起语法栏它又自己弹出来——
     那是一次用户没要求的重排，看起来就是「页面自己在动」。 */
  const toggleCompanion = useCallback(() => {
    setGrammarAt(null)
    setCompanion((v) => !v)
  }, [])
  const toggleGrammar = useCallback((para: number) => {
    setCompanion(false)
    setGrammarAt((cur) => (cur?.para === para ? null : { para, sent: 0 }))
  }, [])

  const saveVoices = useMutation({
    mutationFn: (voices: Record<string, string>) => apiScenario.setRoleVoices(deckId, voices),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['deck-passage', deckId] }),
  })

  const setVoiceFor = (role: string) => setVoiceRole(role)

  const data = query.data
  const deckWords = useMemo(
    () => new Set((data?.coverage.covered ?? []).map((w) => w.toLowerCase())),
    [data],
  )

  const voiceOf = (role: string) => {
    if (data === undefined || data.roles.length === 0) return undefined
    const picked = data.role_voices?.[role]
    if (picked) return picked
    const idx = Math.max(0, data.roles.indexOf(role))
    return FALLBACK_VOICES[idx % FALLBACK_VOICES.length]
  }

  /** 连播序号：每次开始新播放就自增，旧循环发现号变了立刻退出。
      没有它的话点单句时上一轮连播还在后台一段段往下推（实测踩过）。 */
  const seqRef = useRef(0)
  const [autoPlaying, setAutoPlaying] = useState(false)
  /** 阅读位置：点过的句 / 暂停处 / 连播读到哪。null = 还没读过任何一句（FR-289） */
  const [cursor, setCursor] = useState<number | null>(null)

  /* 跟读滚动（FR-290）：连播时正文自己往下走，否则读到屏幕外就得手动追。
     开着时不因用户滚动而关闭——要停就点开关，别让它偷偷失效。 */
  const [follow, setFollow] = useState(() => localStorage.getItem('ln-pg-follow') !== '0')
  /** 语速（FR-316）：听不清就慢放，跟得上就快过 */
  const [rate, setRate] = useState(() => Number(localStorage.getItem('ln-pg-rate') ?? '1') || 1)
  /** 跟读停顿（FR-317）：每句读完留出等长空档 */
  const [shadow, setShadow] = useState(() => localStorage.getItem('ln-pg-shadow') === '1')
  /** 正处在跟读空档：UI 要显示"该你了"，不然像是卡住了 */
  const [shadowing, setShadowing] = useState(false)

  const changeRate = (delta: number) => {
    const idx = RATES.indexOf(rate)
    const next = RATES[Math.min(Math.max((idx < 0 ? RATES.indexOf(1) : idx) + delta, 0), RATES.length - 1)]
    setRate(next)
    localStorage.setItem('ln-pg-rate', String(next))
    setPlaybackRate(next)
  }
  const bodyRef = useRef<HTMLDivElement>(null)
  const paraRefs = useRef<(HTMLDivElement | null)[]>([])

  const halt = (at?: number) => {
    seqRef.current += 1
    stopTts()
    setAutoPlaying(false)
    setPlaying(null)
    setShadowing(false)
    if (at !== undefined) setCursor(at)
  }

  /* 读到哪，AI 就看着哪（FR-292）。固定 key 只维持一张卡，不会把手动加的引用挤掉；
     有了它，问「这句什么意思」不用再复述是哪句。 */
  useEffect(() => {
    if (data === undefined || cursor === null) return
    const para = data.paragraphs[cursor]
    if (para === undefined) return
    useCompanionContext.getState().addRef({
      key: `pg-cursor-${deckId}`,
      text: para.en,
      source: para.role ? `${para.role} · 第 ${cursor + 1} 句` : `第 ${cursor + 1} 句`,
      kind: 'sentence',
    })
  }, [cursor, data, deckId])

  /** 播放一句并在结束后 resolve；返回音频时长（秒），跟读停顿按它计时 */
  const playOnce = (index: number): Promise<number> => {
    const para = data?.paragraphs[index]
    if (para === undefined) return Promise.resolve(0)
    setPlaying(index)
    setCursor(index)
    return new Promise<number>((resolve) => {
      const audio = playUrl(ttsUrl(para.en, 'sentence', voiceOf(para.role)), rate)
      const done = () => resolve(Number.isFinite(audio.duration) ? audio.duration : 0)
      audio.addEventListener('ended', done, { once: true })
      audio.addEventListener('error', () => resolve(0), { once: true })
    })
  }

  /** 单句播放（点句、上一句/下一句、重复本句都走这条）：先掐掉连播，点哪读哪 */
  const speakAt = (index: number) => {
    if (data === undefined) return
    const i = Math.min(Math.max(index, 0), data.paragraphs.length - 1)
    halt(i)
    void playOnce(i).then(() => setPlaying(null))
  }

  const speak = (_para: PassageParagraph, index: number) => speakAt(index)

  const playAll = async (from?: number) => {
    if (data === undefined) return
    const seq = ++seqRef.current
    const start = Math.min(Math.max(from ?? cursor ?? 0, 0), data.paragraphs.length - 1)
    setAutoPlaying(true)
    for (let i = start; i < data.paragraphs.length; i++) {
      if (seqRef.current !== seq) return // 已被暂停或点了单句
      const seconds = await playOnce(i)
      if (seqRef.current !== seq) return
      /* 跟读停顿（FR-317）：读完留出和这句等长的空档让你跟一遍。
         影子跟读的标准做法，比反复手动倒带省事得多。 */
      if (shadow && seconds > 0) {
        setShadowing(true)
        await new Promise<void>((r) => window.setTimeout(r, seconds * 1000))
        setShadowing(false)
        if (seqRef.current !== seq) return
      }
    }
    if (seqRef.current === seq) {
      setAutoPlaying(false)
      setPlaying(null)
      setCursor(data.paragraphs.length - 1) // 停在最后一句，标记留着；「从头」按钮负责回到开头
    }
  }

  const at = cursor ?? 0
  const transport = {
    restart: () => void playAll(0),
    prev: () => speakAt(at - 1),
    next: () => speakAt(at + 1),
    repeat: () => speakAt(at),
    toggle: () => (autoPlaying ? halt(playing ?? at) : void playAll()),
  }

  /* 键位与学新词页一条体系：空格播放/暂停、←→ 上下句、R 重复、Home 从头。
     短文页签不在前台时不吃键，免得在词条页按空格就开始朗读。 */
  const keyOpts = { enabled: data !== undefined, preventDefault: true }
  useHotkeys('space', () => transport.toggle(), keyOpts, [autoPlaying, at, playing])
  useHotkeys('left', () => transport.prev(), keyOpts, [at])
  useHotkeys('right', () => transport.next(), keyOpts, [at])
  useHotkeys('r', () => transport.repeat(), keyOpts, [at])
  // 笔记本键盘常没有独立 Home 键，再给一个 0
  useHotkeys('home, 0', () => transport.restart(), keyOpts, [])
  useHotkeys(
    'comma',
    () => changeRate(-1),
    keyOpts,
    [rate],
  )
  useHotkeys('period', () => changeRate(1), keyOpts, [rate])

  /* 当前段滚进视野：容器内部算偏移，避免 scrollIntoView 连带滚动整页。
     只在连播时跟——手点的那句本来就在眼前，再居中一次等于把内容从鼠标底下抽走。 */
  useEffect(() => {
    if (!follow || !autoPlaying || playing === null) return
    const box = bodyRef.current
    const el = paraRefs.current[playing]
    if (box === null || el === null || el === undefined) return
    // offsetTop 的 offsetParent 是 body（.pg-body 没定位），量出来差了整个页头；用 rect 差值
    const delta = el.getBoundingClientRect().top - box.getBoundingClientRect().top
    // 落在容器 38% 高度处：既看得见当前句，也留出下文，比死居中舒服
    const top = box.scrollTop + delta - (box.clientHeight * 0.38 - el.clientHeight / 2)
    box.scrollTo({ top: Math.max(0, top), behavior: 'smooth' })
  }, [playing, follow, autoPlaying])

  // 切走页面必须停声：否则读到一半换到别处，声音还在后台念（FR-278）
  useEffect(() => () => {
    seqRef.current += 1
    stopTts()
  }, [])

  if (query.isPending) {
    return (
      <div className="state-block">
        <div className="spinner" />
        <div>加载短文…</div>
      </div>
    )
  }

  if (query.isError || data === undefined) {
    return (
      <div className="pg-empty">
        <IconSparkle />
        <div className="pg-empty-title">这个本还没有短文</div>
        <div className="pg-empty-hint">
          短文把本内的词织进一段真实语境，读起来比背单词表更容易记住怎么用。
        </div>
        <button
          className={`btn btn-primary${extend.isPending ? ' loading' : ''}`}
          disabled={extend.isPending}
          onClick={() => extend.mutate([])}
        >
          {extend.isPending && <span className="spinner" />}
          生成一篇
        </button>
        {extend.isError && <div className="form-err">{extend.error.message}</div>}
      </div>
    )
  }

  const cov = data.coverage
  const total = cov.covered.length + cov.missing.length
  const count = data.paragraphs.length

  return (
    <div className="pg">
      <div className="pg-head">
        <div className="pg-title">
          <b>{data.title}</b>
          <span className="chip accent">{data.form === 'dialogue' ? '对话' : '短文'}</span>
          {data.roles.map((r) => (
            <button
              key={r}
              className={`pg-role-chip${data.role_voices?.[r] ? ' set' : ''}`}
              title={
                data.role_voices?.[r]
                  ? `音色：${data.role_voices[r].split(':').pop()}（点击更换）`
                  : '点击给这个角色挑个嗓音'
              }
              onClick={() => setVoiceFor(r)}
            >
              {r}
              <IconSpeaker />
            </button>
          ))}
        </div>
        <span className="pg-sep" />
        {/* 朗读控件（FR-314~318、FR-319）：与角色音色同一行——那一行原本中间空着 659px，
            控件另起一行又空着 744px，两处浪费拼成一行正好。 */}
        <div className="pg-transport">
          <button className="pg-t-btn" title="从头开始 (Home / 0)" onClick={transport.restart}>
            <IconSkipBack />
          </button>
          <button
            className="pg-t-btn"
            title="上一句 (←)"
            disabled={at <= 0}
            onClick={transport.prev}
          >
            <IconChevronLeft />
          </button>
          <button className="pg-t-play" title="播放 / 暂停 (空格)" onClick={transport.toggle}>
            {autoPlaying ? <IconPause /> : <IconPlay />}
            {autoPlaying ? '暂停' : cursor === null ? '从头朗读' : `从第 ${at + 1} 句读下去`}
          </button>
          <button
            className="pg-t-btn"
            title="下一句 (→)"
            disabled={at >= count - 1}
            onClick={transport.next}
          >
            <IconChevronRight />
          </button>
          <button className="pg-t-btn" title="重复这一句 (R)" onClick={transport.repeat}>
            <IconRepeatOne />
          </button>
          <span className="pg-t-pos">
            {cursor === null ? `共 ${count} 句` : `${at + 1} / ${count}`}
            {shadowing && <b className="pg-t-shadow">该你读了…</b>}
          </span>
        </div>
        <div style={{ flex: 1 }} />
        <div className="pg-tune">
          <RatePicker value={rate} onChange={(value) => { setRate(value); setPlaybackRate(value); localStorage.setItem('ln-pg-rate', String(value)) }} />
          <button
            className={`pg-t-chip${shadow ? ' on' : ''}`}
            title="每句读完留出等长空档给你跟读一遍"
            onClick={() => {
              const next = !shadow
              setShadow(next)
              localStorage.setItem('ln-pg-shadow', next ? '1' : '0')
            }}
          >
            跟读停顿 {shadow ? '开' : '关'}
          </button>
          <button
            className={`pg-t-chip${follow ? ' on' : ''}`}
            title={follow ? '朗读时正文跟着滚（点此关闭）' : '朗读时不自动滚动（点此开启）'}
            onClick={() => {
              const next = !follow
              setFollow(next)
              localStorage.setItem('ln-pg-follow', next ? '1' : '0')
            }}
          >
            <IconLocate />
            跟读滚动 {follow ? '开' : '关'}
          </button>
        </div>
        <button
          className={`btn btn-soft${companion ? ' active' : ''}`}
          title="就着这篇短文跟 AI 语音聊，与阅读器、视频页同一套陪读"
          onClick={toggleCompanion}
        >
          <IconMic />
          AI 陪读
        </button>
        <button
          className="btn btn-soft"
          onClick={() => navigate(`/read/${data.article_id}`)}
          title="用完整阅读器打开：可批注、记进度"
        >
          在阅读器中打开
        </button>
      </div>

      {/* 覆盖率：这篇短文用上了本内多少词，未覆盖的可一键补写（FR-272） */}
      <div className="pg-cov">
        <div className="pg-cov-bar">
          <i style={{ width: `${cov.rate * 100}%` }} />
        </div>
        <span className="pg-cov-text">
          用上了 {cov.covered.length}/{total} 个词
        </span>
        {cov.missing.length > 0 && (
          <>
            <span className="pg-missing">
              还差：{cov.missing.slice(0, 6).join('、')}
              {cov.missing.length > 6 && ` 等 ${cov.missing.length} 个`}
            </span>
            <button
              className={`btn-ghost-sm${extend.isPending ? ' loading' : ''}`}
              disabled={extend.isPending}
              onClick={() => extend.mutate(cov.missing)}
            >
              {extend.isPending && <span className="spinner" />}
              重写一篇把它们用上
            </button>
          </>
        )}
      </div>
      {extend.isError && <div className="form-err">{extend.error.message}</div>}

      <div className="pg-main">
      <div className="pg-body" ref={bodyRef}>
        {data.paragraphs.map((para, i) => (
          <div
            key={i}
            ref={(el) => {
              paraRefs.current[i] = el
            }}
            className={`pg-para${playing === i ? ' playing' : ''}${playing !== i && cursor === i ? ' at' : ''}`}
            role="button"
            tabIndex={0}
            title="点这段任意位置朗读；点具体单词查词卡"
            onClick={() => {
              // 拖选复制时不该顺带朗读；点具体单词由 pg-w 自己 stopPropagation
              if ((window.getSelection()?.toString() ?? '').trim() !== '') return
              speak(para, i)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                speak(para, i)
              }
            }}
          >
            {para.role && <div className="pg-role">{para.role}</div>}
            {playing !== i && cursor === i && <span className="pg-at-tag">读到这</span>}
            {/* 语法解析：段内有几句就先让人挑哪句。停在按钮上不触发朗读——
                整段是可点朗读区，不 stopPropagation 的话点「语法」会连带播一遍 */}
            <button
              className={`pg-grammar${grammarAt?.para === i ? ' on' : ''}`}
              title="拆这段的语法结构"
              onClick={(e) => {
                e.stopPropagation()
                toggleGrammar(i)
              }}
            >
              <IconGrammar />
              语法
            </button>
            <div className="pg-en">
              <span className="pg-say" aria-hidden="true">
                <IconSpeaker />
              </span>
              <p>
                {para.en.split(WORD_RE).map((part, j) =>
                  j % 2 === 1 ? (
                    <span
                      key={j}
                      className={`pg-w${deckWords.has(part.toLowerCase()) ? ' known' : ''}`}
                      title={deckWords.has(part.toLowerCase()) ? '本内词，点击查看词卡' : '点击查看词卡'}
                      onClick={(e) => {
                        e.stopPropagation()
                        openWord(part, para.en, undefined, {
                          kind: 'wordlist',
                          label: deck.name,
                          locator: { deck: deck.key, word: part.toLowerCase() },
                        })
                      }}
                    >
                      {part}
                    </span>
                  ) : (
                    part
                  ),
                )}
              </p>
            </div>
            {para.zh && <div className="pg-zh">{para.zh}</div>}
          </div>
        ))}
      </div>

      {grammarAt !== null && data.paragraphs[grammarAt.para] !== undefined && (
        <GrammarAside
          text={data.paragraphs[grammarAt.para].en}
          role={data.paragraphs[grammarAt.para].role}
          sentIdx={grammarAt.sent}
          onPickSent={(sent) => setGrammarAt((cur) => (cur === null ? cur : { ...cur, sent }))}
          onClose={() => setGrammarAt(null)}
        />
      )}

      {companion && (
        <VoiceCompanionAside
          onClose={() => setCompanion(false)}
          source={{ articleId: data.article_id }}
          title={data.title}
          hint="点正文里的词或句先攒引用，AI 就着它们跟你聊"
          followups={PASSAGE_FOLLOWUPS}
          openers={PASSAGE_OPENERS}
        />
      )}
      </div>

      {voiceRole !== null && data && (
        <VoicePicker
          title={`给「${voiceRole}」挑个嗓音`}
          current={data.role_voices?.[voiceRole] ?? voiceOf(voiceRole) ?? ''}
          rate={rate}
          sample={data.paragraphs?.find((p) => p.role === voiceRole)?.en ?? undefined}
          onClose={() => setVoiceRole(null)}
          onChoose={async (choice, speed) => {
            await saveVoices.mutateAsync({ ...(data.role_voices ?? {}), [voiceRole]: choice.value })
            setRate(speed)
            setPlaybackRate(speed)
            localStorage.setItem('ln-pg-rate', String(speed))
          }}
        />
      )}
    </div>
  )
}

/* ---- 语法解析侧栏 ----

   解析本身整块复用阅读器的 `SentencePanel`（翻译 + 语法 + 精讲，SSE 流式带
   会话缓存）——同一句在阅读器、讲义库、这里看到的结果永远一致，也不用养三套。
   这里只多做一件它做不了的事：**段落不等于句子**。一段可能两三句，
   而分析接口按单句吃；所以先按 `splitSentences` 切开让人挑一句。 */
function GrammarAside({
  text,
  role,
  sentIdx,
  onPickSent,
  onClose,
}: {
  text: string
  role: string
  sentIdx: number
  onPickSent: (i: number) => void
  onClose: () => void
}) {
  const sents = useMemo(() => splitSentences(text), [text])
  // 段落改了而下标还停在旧位置时兜到最后一句，别渲染 undefined
  const idx = Math.min(sentIdx, Math.max(0, sents.length - 1))
  const picked = sents[idx] ?? text
  const sel = useMemo(() => sentenceSel(picked), [picked])

  return (
    <aside className="pg-grammar-aside">
      <div className="pg-ga-head">
        <b>语法解析</b>
        {role && <span className="pg-ga-role">{role}</span>}
        <div style={{ flex: 1 }} />
        <button className="btn-ghost-sm" onClick={onClose}>
          收起
        </button>
      </div>

      {sents.length > 1 && (
        <div className="pg-ga-sents">
          {sents.map((sentence, i) => (
            <button
              key={i}
              className={`pg-ga-sent${i === idx ? ' on' : ''}`}
              title={sentence}
              onClick={() => onPickSent(i)}
            >
              <i>{i + 1}</i>
              <span>{sentence}</span>
            </button>
          ))}
        </div>
      )}

      <div className="pg-ga-body">
        <SentencePanel sel={sel} />
      </div>
    </aside>
  )
}

/** 场景短文的陪读问法：这里学的是"在这个场景里怎么开口"，不是课文分析 */
const PASSAGE_FOLLOWUPS = [
  '陪我把这段演一遍',
  '这句还能怎么说',
  '这个说法地道吗',
  '换个更礼貌的说法',
  '考考我这几个词',
]

const PASSAGE_OPENERS = ['陪我把这个场景演一遍', '这个场景最常用哪几句', '带我读一遍']
