import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { LearningIcon } from '../../components/LearningIcon'
import { api } from '../../lib/api'
import { beforeAudioPlay, stopTts } from '../../lib/audio'
import { replaySentence } from './talkReplayStore'
import { usePrefStore } from '../../lib/prefStore'
import { useWordModalStore } from '../reader/wordModalStore'
import { batchKey, generateCoach, useCoachStatus } from './coachQueue'
import { TalkWordText } from './TalkWordText'
import { PronunciationPractice } from './PronunciationPractice'

interface TalkCoachPanelProps {
  sessionId: number | string | null
  assistantText: string | null
  turnId?: number | null
  realtime?: boolean
  suspendPractice?: boolean
  onUseReply?: (text: string) => void
  onPracticeChange?: (active: boolean) => void
}

export function TalkCoachPanel({ sessionId, assistantText, turnId, realtime = false, suspendPractice,
  onUseReply, onPracticeChange }: TalkCoachPanelProps) {
  const [source, setSource] = useState({ text: assistantText, id: turnId })
  const [pinned, setPinned] = useState(false)
  const [page, setPage] = useState(0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [showMeaning, setShowMeaning] = useState(true)
  const prefs = usePrefStore((s) => s.prefs.talk)
  const [translationOpen, setTranslationOpen] = useState(realtime || prefs.translationOpen)
  const [repliesOpen, setRepliesOpen] = useState(realtime || prefs.repliesOpen)
  const updatePrefs = usePrefStore((s) => s.update)
  const wordOpen = useWordModalStore((s) => s.stack.length > 0)
  const client = useQueryClient()
  const currentSource = useRef(source.id)
  currentSource.current = source.id
  const generationStatus = useCoachStatus(sessionId, source.id)
  useEffect(() => beforeAudioPlay(() => setPinned(true)), [])
  useEffect(() => { if (wordOpen) setPinned(true) }, [wordOpen])
  useEffect(() => {
    if (!pinned && !wordOpen) { setSource({ text: assistantText, id: turnId }); setPage(0) }
  }, [assistantText, turnId, pinned, wordOpen])
  const changed = source.id !== turnId || source.text !== assistantText
  const query = useQuery({
    queryKey: batchKey(sessionId ?? '', source.id ?? 0),
    queryFn: () => api.talkBatches(sessionId!, source.id!),
    enabled: sessionId !== null && source.id != null,
    refetchInterval: (q) => q.state.data?.some((b) => b.status === 'running') ? 1500 : false,
    retry: false,
  })
  const batches = query.data ?? []
  const ready = batches.filter((b) => b.status === 'ready')
  const selected = ready[Math.min(page, Math.max(0, ready.length - 1))]
  const failure = batches.find((b) => b.status === 'failed' || b.status === 'interrupted')
  const waiting = busy || generationStatus !== 'idle' || batches.some((b) => b.status === 'running')
  const vocabSource = sessionId !== null && source.id != null ? {
    kind: 'talk' as const,
    label: '实时对话',
    locator: { session_id: String(sessionId), turn_id: source.id },
  } : undefined
  const generate = async () => {
    if (sessionId === null || source.id == null) return
    setBusy(true); setError(null); setPinned(true)
    try {
      const batch = await generateCoach(client, sessionId, source.id,
        failure?.batch_index ?? ready.length, false, Boolean(failure))
      if (currentSource.current === source.id && batch?.status === 'ready') setPage(batch.batch_index)
    } catch (e) { if (currentSource.current === source.id) setError(e instanceof Error ? e.message : '生成失败，请重试') }
    finally { setBusy(false) }
  }
  const copy = async (text: string) => {
    try { await navigator.clipboard.writeText(text); toast.success('已复制') }
    catch { toast.error('复制失败，请选中文本后复制') }
  }
  const saveReply = async (index: number) => {
    if (!selected || sessionId === null || source.id == null) return
    try {
      await api.saveTalkExpression(sessionId, source.id, !selected.saved_replies.includes(index), selected.batch_index, index)
      await query.refetch()
      void client.invalidateQueries({ queryKey: ['talk-records', String(sessionId)] })
    } catch { toast.error('收藏失败，请重试') }
  }
  return <section className="talk-coach" aria-label="对话助手">
    <div className="coach-heading">
      <div className="sec-title"><LearningIcon name="reply-suggestions" size={18} />对话助手</div>
      {realtime && <label className="coach-auto" title="完整回复后自动生成解释和回答，使用已配置的模型服务，可能产生调用费用。"><input type="checkbox" checked={prefs.autoCoach}
        onChange={(e) => updatePrefs({ talk: { autoCoach: e.target.checked } })} />自动辅助</label>}
    </div>
    {changed && <button className="btn btn-soft" onClick={() => {
      setPinned(false); setSource({ text: assistantText, id: turnId }); setPage(0); setError(null)
    }}>有新回复 · 查看最新</button>}
    {source.text ? <>
      {realtime ? <details className="coach-original"><summary>对方原句</summary><p className="coach-source"><TalkWordText text={source.text} source={vocabSource} /></p></details>
        : <p className="coach-source"><TalkWordText text={source.text} source={vocabSource} /></p>}
      <div className="coach-listen">
        <button onClick={() => replaySentence(source.text!)}><LearningIcon name="voice" size={18} />重听</button>
        <button onClick={() => replaySentence(source.text!, true)}><LearningIcon name="speed" size={18} />慢速听</button>
        <button onClick={stopTts}>停止朗读</button>
      </div>
    </> : <p className="coach-empty">对方回复后，可以在这里准备下一句。</p>}
    <div className="coach-progress" role="status">
      {generationStatus === 'queued' ? '等待前一轮辅助完成…' : waiting ? '正在准备解释与推荐回答…' : query.isError ? '辅助记录加载失败' : error ?? failure?.error}
      {query.isError && <button onClick={() => void query.refetch()}>重新加载</button>}
      {(error || failure) && <button disabled={waiting} onClick={() => void generate()}>重试生成</button>}
    </div>
    <details className="coach-section" open={translationOpen}
      onToggle={(e) => { setTranslationOpen(e.currentTarget.open); if (!realtime && e.currentTarget.open !== prefs.translationOpen) updatePrefs({ talk: { translationOpen: e.currentTarget.open } }) }}>
      <summary><LearningIcon name="translate" size={18} />理解这句</summary>
      {ready[0]?.result ? <div className="coach-translation">
        <p><TalkWordText text={ready[0].result.translation} source={vocabSource} /></p>
        <span><TalkWordText text={ready[0].result.intent} source={vocabSource} /></span>
        <button className="btn-ghost-sm" onClick={() => replaySentence(`${ready[0].result!.translation} ${ready[0].result!.intent}`)}>朗读解释</button>
      </div> : <p className="coach-empty">{source.id ? '尚未生成解释' : '等待完整回复保存'}</p>}
    </details>
    <details className="coach-section" open={repliesOpen}
      onToggle={(e) => { setRepliesOpen(e.currentTarget.open); if (!realtime && e.currentTarget.open !== prefs.repliesOpen) updatePrefs({ talk: { repliesOpen: e.currentTarget.open } }) }}>
      <summary><LearningIcon name="reply-suggestions" size={18} />推荐回答</summary>
      <div className="coach-reply-toolbar">
        <button onClick={() => setShowMeaning((value) => !value)}>{showMeaning ? '隐藏中文' : '显示中文'}</button>
        <button disabled={source.id == null || waiting || ready.length >= 20} onClick={() => void generate()}>
          {ready.length ? '换一批' : '生成辅助'}
        </button>
      </div>
      <div className="coach-replies">{selected?.result?.replies.map((reply, index) => <article key={index}>
        <div><span>{reply.tone}</span><button title="朗读这条回答" onClick={() => replaySentence(reply.en)}><LearningIcon name="voice" size={18} /></button></div>
        <div className="coach-reply-text"><b><TalkWordText text={reply.en} source={vocabSource} /></b>{showMeaning && <small><TalkWordText text={reply.zh} source={vocabSource} /></small>}</div>
        <div className="coach-reply-tools">
          <button onClick={() => void copy(reply.en)}>复制</button>
          <button aria-pressed={selected.saved_replies.includes(index)} onClick={() => void saveReply(index)}>{selected.saved_replies.includes(index) ? '已收藏' : '收藏表达'}</button>
          {onUseReply && <button onClick={() => onUseReply(reply.en)}>填入输入框</button>}
        </div>
      </article>)}</div>
      {ready.length > 0 && <nav className="coach-pagination" aria-label="推荐回答历史">
        <button aria-label="上一批回答" disabled={page === 0} onClick={() => { setPinned(true); setPage((p) => p - 1) }}>上一批</button>
        <span>第 {Math.min(page + 1, ready.length)} / {ready.length} 批</span>
        <button aria-label="下一批回答" disabled={page >= ready.length - 1} onClick={() => setPage((p) => p + 1)}>下一批</button>
      </nav>}
    </details>
    {source.text && <PronunciationPractice key={source.id} text={source.text} suspended={suspendPractice || wordOpen} onPracticeChange={(active) => { if (active) setPinned(true); onPracticeChange?.(active) }} />}
  </section>
}
