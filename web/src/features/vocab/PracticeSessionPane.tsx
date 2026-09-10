import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useHotkeys } from 'react-hotkeys-hook'
import { VoicePicker } from '../../components/VoicePicker'
import { RatePicker } from '../../components/RatePicker'
import { IconSpeaker } from '../../components/icons'
import { Overlay, useOverlayOpen } from '../../components/Overlay'
import { api } from '../../lib/api'
import { apiPractice, PRACTICE_MODES, type AnswerRequest, type PracticeQuestion, type PracticeRecord } from '../../lib/api-practice'
import { clearTtsPrefetch, getSessionVoice, playUrl, prefetchTts, setSessionVoice, stopTts, ttsUrl } from '../../lib/audio'
import { useWordModalStore } from '../reader/wordModalStore'
import { useVocabCollectionStore } from '../../lib/vocabCollectionStore'

function WordText({ text, source }: { text: string; source?: import('../../lib/api').VocabSource }) {
  const openWord = useWordModalStore((s) => s.openWord)
  return <span className="vp-word-text">{text.split(/([A-Za-z]+(?:['’-][A-Za-z]+)*)/g).map((part, index) => /^[A-Za-z]/.test(part)
    ? <button key={index} onClick={() => { stopTts(); openWord(part, text.slice(0, 400), undefined, source) }}>{part}</button> : part)}</span>
}

const PRACTICE_SHORTCUTS = [
  ['R', '重播'], ['Shift + R', '慢速重播'], ['H', '下一层提示'],
  ['Enter', '提交或继续'], ['Space', '显示答案或重播'], ['1–4', '评分或选择'],
  ['S', '加入生词本'], ['P', '暂停或继续'], ['?', '快捷键说明'], ['Esc', '暂停训练'],
] as const

export function PracticeSessionPane({ id, onOpen }: { id: string; onOpen: (id: string) => void }) {
  const query = useQuery({ queryKey: ['practice', id], queryFn: () => apiPractice.read(id), staleTime: Infinity, refetchOnWindowFocus: false })
  if (query.isPending) return <div className="vp-state">正在恢复训练…</div>
  if (query.isError) return <div className="vp-state" role="alert">{query.error.message}<button className="btn" onClick={() => void query.refetch()}>重试</button></div>
  return <PracticeRunner key={id} initial={query.data} onOpen={onOpen} />
}

function PracticeRunner({ initial, onOpen }: { initial: PracticeRecord; onOpen: (id: string) => void }) {
  const client = useQueryClient()
  const navigate = useNavigate()
  const [localDraft] = useState(() => {
    try {
      const draft = JSON.parse(localStorage.getItem(`practice-draft:${initial.id}`) ?? 'null') as {
        questionId: string; answer: string; hints: number; replays: number; pending: AnswerRequest | null
      } | null
      return draft?.questionId === initial.questions[initial.cursor]?.id ? draft : null
    } catch { return null }
  })
  const [record, setRecord] = useState(initial)
  const [typed, setTyped] = useState(localDraft?.answer ?? initial.scope.draft?.answer ?? '')
  const [hints, setHints] = useState(localDraft?.hints ?? initial.scope.draft?.hints ?? 0)
  const [replays, setReplays] = useState(localDraft?.replays ?? initial.scope.draft?.replays ?? 0)
  const [revealed, setRevealed] = useState(false)
  const [rate, setRate] = useState(1)
  const [voiceOpen, setVoiceOpen] = useState(false)
  const [helpOpen, setHelpOpen] = useState(false)
  const [audioError, setAudioError] = useState(false)
  const [feedback, setFeedback] = useState<{ question: PracticeQuestion; verdict: string } | null>(null)
  const pendingAnswer = useRef<AnswerRequest | null>(localDraft?.pending ?? null)
  const autoPlayedQuestion = useRef<string | null>(null)
  const [storageError, setStorageError] = useState(false)
  const overlayOpen = useOverlayOpen()
  const wordModalOpen = useWordModalStore((state) => state.stack.length > 0)
  const collected = useVocabCollectionStore((state) => state.collected)
  const addCollected = useVocabCollectionStore((state) => state.addCollected)
  const setCollectedStatus = useVocabCollectionStore((state) => state.setCollectedStatus)
  const question = record.questions[record.cursor]
  const selfRated = record.mode === 'review' || record.mode === 'learn'
  const silent = record.scope.silent
  const active = record.status === 'active' && !feedback
  const collectionStatus = useQuery({
    queryKey: ['vocab-status', question?.word],
    queryFn: () => api.vocabStatus([question!.word]),
    enabled: question !== undefined,
    staleTime: 30_000,
  })
  useEffect(() => {
    if (question && collectionStatus.data) {
      setCollectedStatus(question.word, collectionStatus.data.collected.includes(question.word))
    }
  }, [collectionStatus.data, question, setCollectedStatus])
  useEffect(() => {
    try {
      if (record.status === 'finished') localStorage.removeItem(`practice-draft:${record.id}`)
      else localStorage.setItem(`practice-draft:${record.id}`, JSON.stringify({
        questionId: question?.id, answer: typed, hints, replays, pending: pendingAnswer.current,
      }))
    } catch { setStorageError(true) }
  }, [record.id, record.cursor, record.status, typed, hints, replays, question?.id])
  const store = (next: PracticeRecord) => {
    setRecord(next)
    client.setQueryData(['practice', next.id], next)
    void client.invalidateQueries({ queryKey: ['practice-history'] })
    void client.invalidateQueries({ queryKey: ['practice-resume'] })
    void client.invalidateQueries({ queryKey: ['review-stats'] })
    void client.invalidateQueries({ queryKey: ['decks'] })
    void client.invalidateQueries({ queryKey: ['vocab-overview'] })
  }
  const submit = useMutation({
    mutationFn: (request: AnswerRequest) => apiPractice.answer(record.id, request),
    onSuccess: (next, request) => {
      stopTts()
      const saved = next.answers.find((a) => a.question_id === request.question_id)
      if (request.action === 'answer' && saved) setFeedback({ question, verdict: saved.verdict })
      pendingAnswer.current = null
      store(next)
      setTyped(''); setHints(0); setReplays(0); setRevealed(false); setAudioError(false)
    },
  })
  const progress = useMutation({
    mutationFn: (status: PracticeRecord['status']) => apiPractice.progress(record, status, { answer: typed, hints, replays }),
    onSuccess: store,
  })
  const retry = useMutation({ mutationFn: () => apiPractice.retry(record.id), onSuccess: (next) => onOpen(next.id) })
  const reload = useMutation({ mutationFn: () => apiPractice.read(record.id), onSuccess: (next) => {
    pendingAnswer.current = null
    submit.reset(); progress.reset(); setFeedback(null)
    setTyped(next.scope.draft?.answer ?? ''); setHints(next.scope.draft?.hints ?? 0); setReplays(next.scope.draft?.replays ?? 0)
    setRevealed(false)
    try { localStorage.removeItem(`practice-draft:${record.id}`) } catch { setStorageError(true) }
    store(next)
  } })
  const busy = submit.isPending || progress.isPending || reload.isPending
  const source = question ? {
    kind: 'practice' as const,
    label: PRACTICE_MODES[record.mode].name,
    locator: { session_id: record.id, question_id: question.id },
  } : undefined
  const sourceFor = (item: PracticeQuestion) => ({
    kind: 'practice' as const,
    label: PRACTICE_MODES[record.mode].name,
    locator: { session_id: record.id, question_id: item.id },
  })
  const collect = useMutation({
    mutationFn: ({ item, itemSource }: { item: PracticeQuestion; itemSource: NonNullable<typeof source> }) => {
      return api.collectVocab({ word: item.word, context_text: item.example || item.prompt || item.word, source: itemSource })
    },
    onSuccess: (_result, { item }) => {
      addCollected(item.word)
      client.setQueryData(['vocab-status', item.word], { collected: [item.word] })
      void client.invalidateQueries({ queryKey: ['vocab-overview'] })
    },
  })
  const sound = (slow = false, countReplay = true) => {
    if (!question || silent || !active) return
    setAudioError(false)
    if (countReplay) setReplays((v) => v + 1)
    const audio = playUrl(ttsUrl(question.word, 'vocab'), slow ? 0.7 : rate)
    audio.addEventListener('error', () => setAudioError(true), { once: true })
  }
  useEffect(() => {
    if (silent || !active || !question || !['dictation', 'listening'].includes(record.mode)) return
    if (autoPlayedQuestion.current === question.id) return
    autoPlayedQuestion.current = question.id
    setAudioError(false)
    const audio = playUrl(ttsUrl(question.word, 'vocab'), rate)
    audio.addEventListener('error', () => setAudioError(true), { once: true })
  }, [active, question, rate, record.mode, silent])
  useEffect(() => {
    if (record.status === 'active' && !silent && record.questions[record.cursor + 1]) {
      prefetchTts(ttsUrl(record.questions[record.cursor + 1].word, 'vocab'))
    }
    return () => { stopTts(); clearTtsPrefetch() }
  }, [record.id, record.cursor, record.status, silent])
  const send = (action: AnswerRequest['action'], rating?: number) => {
    if (busy || !question) return
    const request = pendingAnswer.current ?? {
      id: crypto.randomUUID(), question_id: question.id, version: record.version,
      answer: typed, hints, replays, rating, action,
    }
    pendingAnswer.current = request
    try {
      localStorage.setItem(`practice-draft:${record.id}`, JSON.stringify({
        questionId: question.id, answer: typed, hints, replays, pending: request,
      }))
    } catch { setStorageError(true) }
    submit.mutate(request)
  }
  const nextHint = () => {
    if (!question || busy || hints >= question.hint_steps.length) return
    const next = hints + 1
    setHints(next)
    if (question.hint_steps[next - 1]?.reveals_answer && selfRated) setRevealed(true)
    if (question.hint_steps[next - 1]?.eliminate === typed) setTyped('')
  }
  const back = () => { stopTts(); navigate(record.scope.return_url) }
  const error = submit.error ?? progress.error ?? retry.error ?? reload.error
  const completed = record.counts.correct + record.counts.assisted + record.counts.incorrect
  const shortcutsEnabled = !busy && !voiceOpen && !helpOpen && !wordModalOpen && !overlayOpen
  const liveShortcuts = shortcutsEnabled && record.status === 'active' && Boolean(question)
  useHotkeys('r', () => sound(), { enabled: liveShortcuts, preventDefault: true }, [question?.id, active, rate])
  useHotkeys('shift+r', () => sound(true), { enabled: liveShortcuts, preventDefault: true }, [question?.id, active])
  useHotkeys('h', nextHint, { enabled: liveShortcuts, preventDefault: true }, [question?.id, hints, busy])
  useHotkeys('s', () => { if (question && source && !collected.has(question.word)) collect.mutate({ item: question, itemSource: source }) }, { enabled: liveShortcuts, preventDefault: true }, [question?.id, collected])
  useHotkeys('p', () => progress.mutate(record.status === 'paused' ? 'active' : 'paused'), { enabled: shortcutsEnabled && record.status !== 'finished', preventDefault: true }, [record.status, record.version])
  useHotkeys('shift+slash, slash', () => setHelpOpen(true), { enabled: shortcutsEnabled, preventDefault: true })
  useHotkeys('space', () => {
    if (selfRated && !revealed) setRevealed(true)
    else if (!selfRated) sound()
  }, { enabled: liveShortcuts, preventDefault: true }, [selfRated, revealed, question?.id])
  useHotkeys('enter', () => {
    if (feedback) setFeedback(null)
    else if (selfRated && !revealed) setRevealed(true)
    else if (!selfRated && typed.trim()) send('answer')
  }, { enabled: shortcutsEnabled && (liveShortcuts || Boolean(feedback)), preventDefault: true }, [feedback, selfRated, revealed, typed, record.version])
  useHotkeys('1, 2, 3, 4', (event) => {
    const index = Number(event.key) - 1
    if (record.mode === 'listening') setTyped(question?.options[index] ?? '')
    else if (selfRated && revealed) {
      const rating = index + 1
      const fullAnswerShown = record.mode === 'review' && hints >= (question?.hint_steps.length ?? 0)
      if (!fullAnswerShown || rating <= 2) send('answer', rating)
    }
  }, { enabled: liveShortcuts, preventDefault: true }, [record.mode, question?.id, selfRated, revealed, record.version])
  useHotkeys('escape', () => {
    if (record.status === 'active') progress.mutate('paused')
  }, { enabled: shortcutsEnabled && record.status === 'active', preventDefault: true }, [record.status, record.version])
  return <div className="vp-session">
    <header className="vp-session-head">
      <div><strong>{PRACTICE_MODES[record.mode].name}</strong><span>{record.cursor} / {record.questions.length} 题已保存</span></div>
      <div className="vp-actions">
        {!silent && <><button className="btn" onClick={() => { stopTts(); setVoiceOpen(true) }}>朗读音色</button><RatePicker value={rate} onChange={(value) => { stopTts(); setRate(value) }} /></>}
        {record.status !== 'finished' && <button className="btn" disabled={busy || Boolean(pendingAnswer.current)} onClick={() => { stopTts(); progress.mutate(record.status === 'paused' ? 'active' : 'paused') }}>{record.status === 'paused' ? '继续训练' : '暂停'}</button>}
        <button className="btn" disabled={busy || record.status === 'active'} onClick={back}>返回词书</button>
      </div>
    </header>
    <progress className="vp-progress" max={record.questions.length} value={record.cursor} aria-label="训练进度" />
    {storageError && <p role="alert">本机草稿空间不可用，离开前请点击暂停，将输入保存到数据库。</p>}
    {pendingAnswer.current && !submit.isPending && !submit.isError && <div className="vp-error">有一份未确认的答题结果。<button className="btn" onClick={() => submit.mutate(pendingAnswer.current!)}>确认保存结果</button></div>}
    {error && <div className="vp-error" role="alert">保存未完成：{error.message}
      {pendingAnswer.current && <button className="btn" disabled={busy} onClick={() => submit.mutate(pendingAnswer.current!)}>重试保存</button>}
      <button className="btn" disabled={busy} onClick={() => reload.mutate()}>重新读取已保存进度</button>
    </div>}
    {record.status === 'paused' ? <div className="vp-state"><h2>训练已暂停</h2><p>当前题目、输入和提示次数已保存。</p><button className="btn btn-primary" disabled={busy} onClick={() => progress.mutate('active')}>继续训练</button></div>
      : feedback ? <div className="vp-stage"><div className="vp-question"><h2>{feedback.verdict === 'correct' ? '首次答对' : feedback.verdict === 'assisted' ? '提示后答对' : '再记一次'}</h2><h3><WordText text={feedback.question.word} source={sourceFor(feedback.question)} /></h3><p>{feedback.question.translation}</p>{feedback.question.example && <p><WordText text={feedback.question.example} source={sourceFor(feedback.question)} /></p>}</div><div className="vp-feedback">本题已保存。{record.mode === 'review' ? '本次评分已更新复习时间。' : '专项练习不会重复推进复习间隔。'}</div><div className="vp-actions"><button className="btn btn-primary" onClick={() => setFeedback(null)}>{record.status === 'finished' ? '查看结果' : '下一题'}</button></div></div>
        : record.status === 'finished' ? <div className="vp-result"><h2>本轮复盘</h2><div className="vp-result-stats">{[['实际完成', completed], ['首次答对', record.counts.correct], ['提示后答对', record.counts.assisted], ['待巩固', record.counts.incorrect], ['跳过', record.counts.skipped], ['音频不可用', record.counts.unavailable], ['待保存', 0]].map(([label, count]) => <div key={label}><strong>{count}</strong><span>{label}</span></div>)}</div>
          <div className="vp-actions"><button className="btn btn-primary" disabled={!record.counts.incorrect || retry.isPending} onClick={() => retry.mutate()}>重练错题</button><button className="btn" onClick={back}>返回词书</button></div>
          <PracticePackPanel id={record.id} />
          <div className="vp-answer-list">{record.answers.map((answer) => { const q = record.questions.find((item) => item.id === answer.question_id)!; return <div key={answer.id}><strong><WordText text={q.word} source={sourceFor(q)} /></strong><span>{q.translation}</span><span>{({ correct: '首次答对', assisted: '提示后答对', incorrect: '待巩固', skipped: '跳过', unavailable: '音频不可用' })[answer.verdict]}</span><span>提示 {answer.hints} · 重播 {answer.replays}</span>{!silent && <button className="btn" onClick={() => playUrl(ttsUrl(q.word, 'vocab'), rate)} aria-label={`朗读 ${q.word}`}><IconSpeaker /></button>}</div> })}</div>
        </div>
          : question && <div className="vp-stage">
            <div className="vp-question">
              <span className="vp-eyebrow">第 {record.cursor + 1} 题 · {selfRated ? '先回忆，再查看答案' : '输入或选择你的答案'}</span>
              {selfRated ? <><h2><WordText text={question.word} source={source} /></h2><p>{question.phonetic}</p></>
                : record.mode === 'cloze' ? <h2><WordText text={question.prompt} source={source} /></h2>
                  : record.mode === 'spelling' ? <h2>{question.translation}</h2>
                    : <><button className="vp-listen btn" onClick={() => sound()} aria-label="播放题目"><IconSpeaker /></button>{record.mode === 'dictation' && question.prompt && <p>{question.prompt}</p>}</>}
              {!silent && <div className="vp-actions"><button className="btn" onClick={() => sound()}>重播</button><button className="btn" onClick={() => sound(true)}>慢速</button></div>}
              {record.mode === 'listening' ? <div className="vp-options">{question.options.map((option, index) => { const eliminated = question.hint_steps.slice(0, hints).some((step) => step.eliminate === option); return <button key={option} className={`btn${typed === option ? ' btn-primary' : ''}`} disabled={busy || eliminated} onClick={() => setTyped(option)}><kbd>{index + 1}</kbd>{option}{eliminated && <small>已排除</small>}</button> })}</div>
                : !selfRated && <form onSubmit={(event) => { event.preventDefault(); if (typed.trim()) send('answer') }}><input className="input vp-answer-input" autoComplete="off" autoCapitalize="none" spellCheck={false} aria-label="你的答案" placeholder="输入答案" value={typed} disabled={busy || Boolean(pendingAnswer.current)} onChange={(e) => setTyped(e.target.value)} /><button className="btn btn-primary" disabled={!typed.trim() || busy}>提交答案</button></form>}
              {selfRated && !revealed && <button className="btn btn-primary" onClick={() => setRevealed(true)}>显示释义</button>}
              {selfRated && revealed && <><p>{question.translation || '暂无释义'}</p>{question.example && <p><WordText text={question.example} source={source} /></p>}<div className="vp-actions">{[1, 2, 3, 4].map((rating) => { const blocked = record.mode === 'review' && hints >= question.hint_steps.length && rating > 2; return <button className="btn" disabled={busy || blocked} key={rating} onClick={() => send('answer', rating)}><kbd>{rating}</kbd>{['忘记', '困难', '记得', '熟悉'][rating - 1]}{record.mode === 'review' && <small>{question.intervals?.[String(rating)]}</small>}</button> })}</div>{record.mode === 'review' && hints >= question.hint_steps.length && <small>已查看完整答案，本题只能选择“忘记”或“困难”。</small>}</>}
            </div>
            <div className="vp-feedback" aria-live="polite">{audioError ? <>音频不可用，不会计为答错。<button className="btn" onClick={() => send('unavailable')}>跳过并记录</button></> : hints > 0 ? <div className="vp-hint"><strong>{question.hint_steps[hints - 1]?.label}</strong><span>{question.hint_steps[hints - 1]?.text || '暂无可用提示'}</span></div> : <span>下一层提示：{question.hint_steps[0]?.label ?? '暂无提示'}</span>}{busy && <span>正在保存…</span>}</div>
            <div className="vp-actions"><button className="btn" disabled={busy || Boolean(pendingAnswer.current)} onClick={() => send('skip')}>跳过</button><button className="btn" disabled={busy || hints >= question.hint_steps.length} onClick={nextHint}>{hints >= question.hint_steps.length ? '提示已全部显示' : `提示：${question.hint_steps[hints]?.label}`} <kbd>H</kbd></button><button className="btn" disabled={collect.isPending || collected.has(question.word)} onClick={() => source && collect.mutate({ item: question, itemSource: source })}>{collected.has(question.word) ? '已在生词本' : '加入生词本'} <kbd>S</kbd></button>{record.mode === 'listening' && <button className="btn btn-primary" disabled={!typed || busy} onClick={() => send('answer')}>确认答案</button>}<button className="btn" disabled={busy} onClick={() => { stopTts(); progress.mutate('finished') }}>结束并复盘</button></div>
            {collect.isError && <p className="vp-inline-error" role="alert">收藏失败：{collect.error.message}</p>}
          </div>}
    {voiceOpen && <VoicePicker title="训练朗读音色" current={getSessionVoice()} rate={rate} onClose={() => setVoiceOpen(false)} onChoose={(voice, speed) => { stopTts(); setSessionVoice(voice.value); setRate(speed) }} />}
    {helpOpen && <Overlay onClose={() => setHelpOpen(false)} card="ov-narrow" labelledBy="practice-shortcuts-title"><div className="overlay-head"><h2 id="practice-shortcuts-title" className="overlay-title">训练快捷键</h2></div><div className="vp-shortcut-list">{PRACTICE_SHORTCUTS.map(([key, label]) => <div key={key}><kbd>{key}</kbd><span>{label}</span></div>)}</div><div className="overlay-foot"><button className="btn btn-primary" onClick={() => setHelpOpen(false)}>知道了</button></div></Overlay>}
  </div>
}

function PracticePackPanel({ id }: { id: string }) {
  const client = useQueryClient()
  const [confirm, setConfirm] = useState(false)
  const pack = useQuery({ queryKey: ['practice-pack', id], queryFn: () => apiPractice.pack(id),
    refetchInterval: (query) => ['queued', 'running'].includes(query.state.data?.pack?.status ?? '') ? 2500 : false,
  })
  const generate = useMutation({ mutationFn: () => apiPractice.generatePack(id), onSuccess: (data) => { setConfirm(false); client.setQueryData(['practice-pack', id], data) } })
  const content = pack.data?.pack
  return <section className="vp-pack"><h3>针对性练习包</h3>
    {content?.status === 'queued' && <p role="status">已排队，后台将在下一次任务调度时开始。你可以离开，稍后从训练记录回来查看。</p>}
    {content?.status === 'running' && <p role="status">正在生成双语语境和练习…</p>}
    {content?.error && <p role="alert">{content.error}</p>}
    {content?.status === 'limited' && <p>今天的自动额度已用完。</p>}
    {content?.status === 'cancelled' && <p>自动任务已取消。</p>}
    {content?.result ? <><p><WordText text={content.result.en} /></p><button className="btn" onClick={() => playUrl(ttsUrl(content.result!.en))}>朗读语境</button><p>{content.result.zh}</p>
      {content.result.questions.map((question, i) => <details key={i}><summary><WordText text={question.prompt} /></summary><p>参考答案：<WordText text={question.answers.join(' / ')} /></p><p>{question.explanation}</p></details>)}
      <p>{content.result.advice}</p><small>生成内容用于补充练习，不直接改变 FSRS 评分。</small></>
      : !['queued', 'running'].includes(content?.status ?? '') && <>{confirm ? <div><p>本次手动生成可能产生模型调用费用，确认继续？</p><div className="vp-actions"><button className="btn" onClick={() => setConfirm(false)}>取消</button><button className="btn btn-primary" disabled={generate.isPending} onClick={() => generate.mutate()}>确认生成</button></div></div> : <button className="btn" onClick={() => setConfirm(true)}>手动生成练习包</button>}</>}
    {(pack.error || generate.error) && <p role="alert">{(pack.error ?? generate.error)?.message}</p>}
  </section>
}
