import { useQuery } from '@tanstack/react-query'
import { useMemo, useState } from 'react'

import { apiPractice, PRACTICE_MODES, type PracticeMode } from '../../lib/api-practice'

const GROUPS: Array<{ title: string; modes: PracticeMode[] }> = [
  { title: '记忆与拼写', modes: ['review', 'learn', 'spelling'] },
  { title: '听力理解', modes: ['dictation', 'listening'] },
  { title: '语境运用', modes: ['cloze'] },
]

export function PracticeHub({ onStart, onOpen }: { onStart: (mode: PracticeMode) => void; onOpen: (id: string) => void }) {
  const [offset, setOffset] = useState(0)
  const history = useQuery({ queryKey: ['practice-history', offset], queryFn: () => apiPractice.history(offset) })
  const latestUnfinished = useMemo(
    () => history.data?.items.find((record) => record.status !== 'finished'),
    [history.data],
  )
  const latestWrong = useMemo(
    () => history.data?.items.find((record) => record.status === 'finished' && record.incorrect > 0),
    [history.data],
  )
  return (
    <div className="vp-hub">
      <header><h2>专项练习</h2><p>按能力选择一组训练。题目、提示和结果会逐题保存。</p></header>
      <div className="vp-quick-actions">
        <button disabled={!latestUnfinished} onClick={() => latestUnfinished && onOpen(latestUnfinished.id)}><span>继续上次</span><strong>{latestUnfinished ? `${PRACTICE_MODES[latestUnfinished.mode].name} · ${latestUnfinished.cursor}/${latestUnfinished.total}` : '没有未完成训练'}</strong></button>
        <button onClick={() => onStart('review')}><span>今日安排</span><strong>到期复习</strong></button>
        <button disabled={!latestWrong} onClick={() => latestWrong && onOpen(latestWrong.id)}><span>近期错题</span><strong>{latestWrong ? `${latestWrong.incorrect} 题可从复盘重练` : '暂无错题'}</strong></button>
      </div>
      <div className="vp-mode-groups">
        {GROUPS.map((group) => <section key={group.title}><h3>{group.title}</h3><div>{group.modes.map((key) => <button key={key} onClick={() => onStart(key)}><span><strong>{PRACTICE_MODES[key].name}</strong><small>{PRACTICE_MODES[key].description}</small></span><b>选择范围</b></button>)}</div></section>)}
      </div>
      <div className="vp-history-head"><h3>训练记录</h3><span>保存范围、完成率、提示次数与错题</span></div>
      {history.isPending && <p>正在读取记录…</p>}
      {history.isError && <p role="alert">{history.error.message} <button className="btn" onClick={() => void history.refetch()}>重试</button></p>}
      {history.data?.items.length === 0 && <p>完成或暂停训练后，记录会保存在这里。旧版训练没有逐题历史明细。</p>}
      <div className="vp-history">{history.data?.items.map((record) => {
        const deckCount = record.scope.decks?.length ?? 0
        const completion = record.total ? Math.round((record.cursor / record.total) * 100) : 0
        return <button key={record.id} onClick={() => onOpen(record.id)}><span className="vp-history-main"><strong>{PRACTICE_MODES[record.mode].name}</strong><small>{deckCount > 1 ? `${deckCount} 本词书` : deckCount === 1 ? '1 本词书' : '生词本'} · 完成 {completion}% · 提示 {record.hints} 次{record.incorrect ? ` · 错题 ${record.incorrect}` : ''}</small></span><time>{new Date(record.updated_at.endsWith('Z') || /[+-]\d\d:\d\d$/.test(record.updated_at) ? record.updated_at : `${record.updated_at}Z`).toLocaleString()}</time><span>{record.status === 'finished' ? '查看复盘' : '继续学习'}</span></button>
      })}</div>
      {(history.data?.total ?? 0) > 20 && <div className="vp-actions"><button className="btn" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 20))}>上一页</button><span>{Math.floor(offset / 20) + 1} / {Math.ceil((history.data?.total ?? 0) / 20)}</span><button className="btn" disabled={offset + 20 >= (history.data?.total ?? 0)} onClick={() => setOffset(offset + 20)}>下一页</button></div>}
    </div>
  )
}
