import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { toast } from 'sonner'
import { Dialog, DialogContent, DialogTitle } from '../../components/ui/dialog'
import { useFullscreenElement } from '../../components/FullscreenPortal'
import { LearningIcon } from '../../components/LearningIcon'
import { Copy } from '../../components/NexusIcon'
import { api, type TalkRecord, type VocabSource } from '../../lib/api'
import { stopTts } from '../../lib/audio'
import { saveFile } from '../../lib/shell'
import { useStopTtsOnClose } from '../../lib/useStopTtsOnClose'
import { batchKey, generateCoach } from './coachQueue'
import { TalkWordText } from './TalkWordText'
import { TalkReplaySettings } from './TalkReplaySettings'
import { replaySentence, sentences } from './talkReplayStore'
import './talkRecords.css'
import { SendToSentenceLab } from '@/components/SendToSentenceLab'

export function RecordSentences({ text, savedTexts = [], onSave, source }: { text: string; savedTexts?: string[]; onSave?: (text: string, saved: boolean) => void; source?: VocabSource }) {
  return <div className="record-sentences">{sentences(text).map((sentence, index) => <div className="record-sentence" key={index}>
    <span><TalkWordText text={sentence} source={source} /></span>
    <button className="icon-btn" aria-label={`朗读：${sentence}`} onClick={() => replaySentence(sentence)}><LearningIcon name="voice" size={18} /></button>
    <button className="icon-btn" aria-label={`慢速朗读：${sentence}`} onClick={() => replaySentence(sentence, true)}><LearningIcon name="speed" size={18} /></button>
    <button className="icon-btn" aria-label={`复制：${sentence}`} onClick={() => void navigator.clipboard.writeText(sentence).then(() => toast.success('已复制'), () => toast.error('复制失败'))}><Copy size={18} /></button>
    {onSave && <button aria-pressed={savedTexts.includes(sentence)} aria-label={`收藏：${sentence}`} onClick={() => onSave(sentence, !savedTexts.includes(sentence))}>{savedTexts.includes(sentence) ? '已收藏' : '收藏'}</button>}
    {/[a-z]/i.test(sentence) && <SendToSentenceLab text={sentence} />}
  </div>)}</div>
}

function RecordEntry({ record, sessionId }: { record: TalkRecord; sessionId: number | string }) {
  const [batchIndex, setBatchIndex] = useState(0)
  const [busy, setBusy] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const client = useQueryClient()
  const batches = record.batches.filter((b) => b.status === 'ready')
  const current = batches[Math.min(batchIndex, Math.max(0, batches.length - 1))]
  const first = batches[0]?.result
  const failed = record.batches.find((b) => b.status === 'failed' || b.status === 'interrupted')
  const pending = busy || record.batches.some((b) => b.status === 'running')
  const vocabSource = {
    kind: 'talk' as const,
    label: '对话记录',
    locator: { session_id: String(sessionId), turn_id: record.id },
  }
  const save = async (value: boolean, batch?: number, reply?: number, text?: string) => {
    try {
      await api.saveTalkExpression(sessionId, record.id, value, batch, reply, text)
      void client.invalidateQueries({ queryKey: ['talk-records', String(sessionId)] })
      void client.invalidateQueries({ queryKey: batchKey(sessionId, record.id) })
    } catch { toast.error('收藏失败，请重试') }
  }
  const generate = async () => {
    setBusy(true)
    try {
      const result = await generateCoach(client, sessionId, record.id, failed?.batch_index ?? batches.length, false, Boolean(failed))
      if (result?.status === 'ready') setBatchIndex(result.batch_index)
    } catch { toast.error('辅助请求失败，请重试') }
    finally { setBusy(false) }
  }
  return <article className={`talk-record-entry ${record.role}`} data-turn-id={record.id}>
    <header><strong>{record.role === 'assistant' ? '口语伙伴' : '你'}</strong>
      <time dateTime={record.created_at}>{new Date(record.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time>
      {!record.complete && <span>未完整／被打断</span>}
      <button aria-pressed={record.saved} onClick={() => void save(!record.saved)}>{record.saved ? '已收藏' : '收藏表达'}</button>
      <button onClick={() => void navigator.clipboard.writeText(record.text).then(() => toast.success('已复制'), () => toast.error('复制失败'))}>复制</button>
    </header>
    <RecordSentences text={record.text} savedTexts={record.saved_texts} onSave={(text, saved) => void save(saved, undefined, undefined, text)} source={vocabSource} />
    {record.role === 'assistant' && <details open={expanded} onToggle={(e) => setExpanded(e.currentTarget.open)}>
      <summary>解释与推荐回答 · {batches.length} 批{pending ? ' · 生成中' : ''}</summary>
      {expanded && <div className="record-coach">
        {first && <div className="record-translation"><RecordSentences text={first.translation} source={vocabSource} /><RecordSentences text={first.intent} source={vocabSource} /></div>}
        {!first && <p className="coach-empty">尚未生成辅助。旧记录不会自动调用模型。</p>}
        {failed && <p role="alert">{failed.error}</p>}
        {current?.result?.replies.map((reply, index) => <div className="record-reply" key={index}>
          <div className="record-reply-head"><span>{reply.tone}</span><button aria-pressed={current.saved_replies.includes(index)}
            onClick={() => void save(!current.saved_replies.includes(index), current.batch_index, index)}>{current.saved_replies.includes(index) ? '已收藏' : '收藏回答'}</button></div>
          <RecordSentences text={reply.en} source={vocabSource} /><div className="record-meaning"><RecordSentences text={reply.zh} source={vocabSource} /></div>
        </div>)}
        <nav className="record-batch-nav" aria-label="本轮回答批次">
          <button disabled={batchIndex === 0} onClick={() => setBatchIndex((v) => v - 1)}>上一批</button>
          <span>{batches.length ? `${batchIndex + 1} / ${batches.length} 批` : '无记录'}</span>
          <button disabled={batchIndex >= batches.length - 1} onClick={() => setBatchIndex((v) => v + 1)}>下一批</button>
          <button disabled={pending || batches.length >= 20} onClick={() => void generate()}>{pending ? '生成中…' : failed ? '重试生成' : batches.length ? '换一批' : '生成辅助'}</button>
        </nav>
      </div>}
    </details>}
  </article>
}

export function TalkRecordsView({ sessionId, onDeleted }: { sessionId: number | string; onDeleted?: () => void }) {
  const fullscreen = useFullscreenElement()
  const client = useQueryClient()
  const [keyword, setKeyword] = useState('')
  const [q, setQ] = useState('')
  const [role, setRole] = useState('')
  const [saved, setSaved] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const list = useRef<HTMLDivElement>(null)
  const initial = useRef(true)
  const olderHeight = useRef<number | null>(null)
  const [latestSeen, setLatestSeen] = useState<number | null>(null)
  useEffect(() => { const timer = setTimeout(() => setQ(keyword), 250); return () => clearTimeout(timer) }, [keyword])
  useEffect(() => { initial.current = true }, [sessionId, q, role, saved])
  const query = useInfiniteQuery({
    queryKey: ['talk-records', String(sessionId), q, role, saved],
    initialPageParam: undefined as number | undefined,
    queryFn: ({ pageParam }) => api.talkRecords(sessionId, { before: pageParam, q, role, saved }),
    getNextPageParam: (page) => page.next_cursor ?? undefined,
    retry: false,
    refetchInterval: (state) => state.state.data?.pages.some((page) => page.items.some((r) => r.batches.some((b) => b.status === 'running'))) ? 1500 : false,
  })
  const items = [...new Map((query.data?.pages.flatMap((p) => p.items) ?? []).map((r) => [r.id, r])).values()].sort((a, b) => a.ordinal - b.ordinal)
  const total = query.data?.pages[0]?.total ?? 0
  const ended = query.data?.pages[0]?.ended_at != null
  const newest = items.at(-1)?.id ?? null
  useLayoutEffect(() => {
    const el = list.current
    if (!el || !items.length) return
    if (initial.current) {
      el.scrollTop = el.scrollHeight; initial.current = false; setLatestSeen(newest)
    } else if (olderHeight.current !== null && !query.isFetchingNextPage) {
      el.scrollTop += el.scrollHeight - olderHeight.current; olderHeight.current = null
    }
  }, [items.length, newest, query.isFetchingNextPage])
  const exportRecords = async (format: 'json' | 'md') => {
    setExporting(true)
    try {
      const all: TalkRecord[] = []
      let before: number | undefined
      do {
        const page = await api.talkRecords(sessionId, { before })
        all.push(...page.items); before = page.next_cursor ?? undefined
      } while (before !== undefined)
      all.sort((a, b) => a.ordinal - b.ordinal)
      const text = format === 'json' ? JSON.stringify({ session_id: sessionId, turns: all }, null, 2)
        : all.map((r) => `## ${r.role === 'assistant' ? '口语伙伴' : '你'}\n\n${r.created_at} · ${r.complete ? '完整' : '未完整／被打断'}\n\n${r.text}\n\n${r.batches.map((b) => b.result
          ? `### 推荐第 ${b.batch_index + 1} 批\n\n${b.result.translation}\n\n${b.result.intent}\n\n${b.result.replies.map((reply) => `- ${reply.en}\n  ${reply.zh}`).join('\n')}` : '').join('\n\n')}`).join('\n\n')
      saveFile(new Blob([text], { type: format === 'json' ? 'application/json' : 'text/markdown' }), `talk-${sessionId}.${format}`)
    } catch { toast.error('导出失败，请重试') }
    finally { setExporting(false) }
  }
  const remove = async () => {
    setDeleting(true)
    try {
      await api.deleteTalkSession(sessionId)
      client.removeQueries({ queryKey: ['talk-records', String(sessionId)] })
      client.removeQueries({ queryKey: ['talk-batches', String(sessionId)] })
      void client.invalidateQueries({ queryKey: ['talk-sessions'] })
      onDeleted?.()
    } catch (e) { toast.error(e instanceof Error ? e.message : '删除失败') }
    finally { setDeleting(false) }
  }
  return <div className="talk-records-view">
    <div className="talk-records-toolbar">
      <input aria-label="搜索对话记录" placeholder="搜索原文、翻译或推荐回答" value={keyword} onChange={(e) => setKeyword(e.target.value)} />
      <div className="record-role-filter" role="group" aria-label="发言人筛选">
        {[['', '全部'], ['assistant', '口语伙伴'], ['user', '我']].map(([value, label]) => <button key={value} aria-pressed={role === value} onClick={() => setRole(value)}>{label}</button>)}
      </div>
      <button aria-pressed={saved} onClick={() => setSaved((v) => !v)}>仅收藏</button>
      <button onClick={stopTts}>停止朗读</button>
    </div>
    <div className="record-meta"><span>{total} 条消息 · 文字使用 TTS 重读</span><button onClick={() => {
      if (list.current) list.current.scrollTop = list.current.scrollHeight
      setLatestSeen(newest)
    }}>{newest !== latestSeen ? '有新记录 · 回到最新' : '回到最新'}</button></div>
    <div className="talk-records-scroll" ref={list}>
      {query.isPending && <p className="state-block" role="status">正在加载记录…</p>}
      {query.isError && <div className="state-block" role="alert">记录加载失败<button className="btn" onClick={() => void query.refetch()}>重试</button></div>}
      {query.hasNextPage && <button className="btn record-load" disabled={query.isFetchingNextPage} onClick={() => {
        olderHeight.current = list.current?.scrollHeight ?? null; void query.fetchNextPage()
      }}>{query.isFetchingNextPage ? '加载中…' : '加载更早的 50 条'}</button>}
      {!query.isPending && !query.isError && !items.length && <p className="state-block">{q || saved || role ? '没有符合条件的记录' : '完整回复保存后会显示在这里'}</p>}
      {items.map((record) => <RecordEntry key={record.id} record={record} sessionId={sessionId} />)}
    </div>
    <footer className="talk-records-footer">
      <TalkReplaySettings />
      <button disabled={exporting} onClick={() => void exportRecords('md')}>导出 Markdown</button>
      <button disabled={exporting} onClick={() => void exportRecords('json')}>导出 JSON</button>
      <button disabled={!ended} title={!ended ? '请先结束会话' : undefined} onClick={() => setConfirmDelete(true)}>删除会话</button>
    </footer>
    {confirmDelete && <Dialog open onOpenChange={setConfirmDelete}><DialogContent portalContainer={fullscreen} className="talk-record-delete" overlayClassName="talk-record-delete-overlay"
      onEscapeKeyDown={(e) => e.stopPropagation()} aria-describedby={undefined}>
      <DialogTitle>删除这次会话？</DialogTitle><p>原文、解释、推荐批次和收藏会一并删除，此操作不可恢复。可先导出备份。</p>
      <div className="record-batch-nav"><button className="btn" disabled={deleting} onClick={() => setConfirmDelete(false)}>取消</button>
        <button className="btn btn-end" disabled={deleting} onClick={() => void remove()}>{deleting ? '删除中…' : '确认删除'}</button></div>
    </DialogContent></Dialog>}
  </div>
}

export function TalkRecordsDialog({ sessionId, onClose }: { sessionId: number | string; onClose: () => void }) {
  const navigate = useNavigate()
  const fullscreen = useFullscreenElement()
  useStopTtsOnClose()
  const trigger = useRef<HTMLElement | null>(null)
  return <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
    <DialogContent portalContainer={fullscreen} className="talk-records-dialog" aria-describedby={undefined} onEscapeKeyDown={(e) => e.stopPropagation()}
      onOpenAutoFocus={() => { trigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : null }}
      onCloseAutoFocus={(event) => { event.preventDefault(); trigger.current?.focus({ preventScroll: true }) }}>
      <DialogTitle className="talk-records-title">对话记录</DialogTitle>
      <TalkRecordsView sessionId={sessionId} onDeleted={() => { onClose(); navigate('/talk') }} />
    </DialogContent>
  </Dialog>
}
