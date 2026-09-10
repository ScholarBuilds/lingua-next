import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'

import { grammarApi } from '@/lib/api-grammar'
import { GrammarVoiceButton } from './GrammarVoice'
import type { GrammarPractice } from '@/lib/api-grammar'
import { useUrlValue } from '@/lib/urlState'
import { PillPicker } from '@/components/ui/picker'
import { ExerciseWidget, PlayButton } from '../exercise/Widgets'
import { TalkWordText } from '../talk/TalkWordText'
import { useNavigate } from 'react-router-dom'

function Question({ record, onSaved }: { record: GrammarPractice; onSaved: (next: GrammarPractice) => void }) {
  const item = record.questions[record.cursor]
  const [response, setResponse] = useState<unknown>(item.draft_response ?? null)
  const answer = useMutation({
    mutationFn: (value: unknown) => grammarApi.submitPractice(record.id, { submission_id: item.submission_id, response: value }),
    onSuccess: r => onSaved(r.practice),
  })
  const save = useMutation({
    mutationFn: (rating: number) => grammarApi.submitPractice(record.id, { submission_id: item.submission_id, response, rating }),
    onSuccess: r => onSaved(r.practice),
  })
  const result = answer.data?.result ?? item.verdict ?? null
  return <div className="gc-card">
    <p>{record.cursor + 1} / {record.questions.length} · {item.point?.item_zh ?? '语法练习'}</p>
    {item.question.prompt && <p className="gc-prompt">{item.question.prompt}</p>}
    <GrammarVoiceButton sentence={item.question.sentence ?? item.question.audio?.text ?? item.question.prompt ?? '语法练习'}
      analysis={result ? { question: item.question, response, result } : undefined} source="语法练习解析" />
    {item.question.audio?.text && <PlayButton text={item.question.audio.text} label="重听" />}
    <fieldset disabled={answer.isPending || save.isPending} className="gp-answer-field">
      <ExerciseWidget question={{ ...item.question, id: item.submission_id }} verdict={result}
        onSubmit={value => { setResponse(value); answer.mutate(value) }} />
    </fieldset>
    {result && <div className="gc-verdict">
      <p>{result.correct ? '回答正确' : '再看一下'} · {result.feedback}</p>
      <div className="gc-grade">{['忘记', '困难', '记得', '轻松'].map((label, index) =>
        <button className="btn btn-outline" key={label} disabled={save.isPending || (((item.first_verdict ?? result).correct === false || item.hints === 3) && index > 1)}
          onClick={() => save.mutate(index + 1)}>{save.isPending ? '保存中' : label}</button>)}</div>
    </div>}
    {(answer.error || save.error) && <p role="alert" className="we-err">
      {(answer.error || save.error)?.message}。本题未切换，请重试。
    </p>}
  </div>
}

export function GrammarPracticePane({ pointId, pointIds }: { pointId?: number; pointIds?: number[] }) {
  const qc = useQueryClient()
  const [id, setId] = useUrlValue<string>('practice', '')
  const [count, setCount] = useState('5')
  const section = pointIds ?? (pointId ? [pointId] : undefined)
  const history = useQuery({ queryKey: ['gr-practice-history'], queryFn: grammarApi.practiceHistory })
  const current = useQuery({ queryKey: ['gr-practice', id], queryFn: () => grammarApi.practice(id), enabled: !!id })
  const create = useMutation({
    mutationFn: (mode: 'review' | 'errors' | 'section') => grammarApi.createPractice(mode, section ?? [], Number(count)),
    onSuccess: record => { qc.setQueryData(['gr-practice', record.id], record); setId(record.id) },
  })
  const saved = (record: GrammarPractice) => {
    qc.setQueryData(['gr-practice', record.id], record)
    void qc.invalidateQueries({ queryKey: ['gr-practice-history'] })
    void qc.invalidateQueries({ queryKey: ['gr-stats'] })
  }
  const record = current.data
  return <section className="gd-pane" aria-label="语法训练">
    {record ? <>
      <div className="gc-nav"><button className="btn btn-outline" onClick={() => setId('')}>{record.status === 'finished' ? '返回' : '暂停并返回'}</button></div>
      {record.status === 'finished' ? <div>
        <h3>本轮完成</h3><p>完成 {record.cursor} 题 · 首次答对 {Object.values(record.answers).filter(a => a.first_correct ?? a.correct).length} 题</p>
        <button className="btn btn-outline" onClick={() => create.mutate('errors')}>练习错题</button>
      </div> : <Question key={record.questions[record.cursor].submission_id} record={record} onSaved={saved} />}
    </> : <>
      <div className="gc-nav">
        <PillPicker label="题数" value={count} onChange={setCount} options={['5', '10', '20'].map(value => ({ value, label: `${value} 题` }))} />
        <button className="btn btn-primary" disabled={create.isPending || section?.length === 0} onClick={() => create.mutate(section ? 'section' : 'review')}>{section ? '开始本节练习' : '开始到期复习'}</button>
        <button className="btn btn-outline" disabled={create.isPending} onClick={() => create.mutate('errors')}>错题再练</button>
      </div>
      {history.data?.items.filter(r => r.status !== 'finished').map(r => <button className="btn btn-outline" key={r.id} onClick={() => setId(r.id)}>继续训练 · {r.cursor}/{r.questions.length}</button>)}
    </>}
    {(create.error || current.error) && <p role="alert" className="we-err">{(create.error || current.error)?.message}</p>}
  </section>
}

export function GrammarMistakes() {
  const navigate = useNavigate()
  const history = useQuery({ queryKey: ['gr-practice-history'], queryFn: grammarApi.practiceHistory })
  const mistakes = history.data?.items.flatMap(record => record.questions.flatMap(item => {
    const answer = record.answers[item.submission_id]
    return answer && !(answer.first_correct ?? answer.correct) ? [{ record, item, answer }] : []
  })) ?? []
  return <section className="gd-pane">
    <h3>最近训练错题</h3>
    {history.isPending && <p role="status">读取训练记录…</p>}
    {history.error && <p role="alert">{history.error.message}</p>}
    {history.data && !mistakes.length && <p>还没有训练错题。历史分类记录仍保留在下方。</p>}
    {mistakes.slice(0, 50).map(({ record, item, answer }) => <details key={item.submission_id}>
      <summary>{item.point?.item_zh ?? item.point?.item ?? '语法练习'} · {new Date(record.updated_at).toLocaleDateString()}</summary>
      <p><TalkWordText text={item.question.prompt ?? item.question.sentence ?? item.question.audio?.text ?? '选择正确答案'} /></p>
      {item.question.choices?.map((choice, index) => <p key={index}>{index + 1}. <TalkWordText text={choice} /></p>)}
      <p>作答：{typeof answer.response === 'number' && item.question.choices ? item.question.choices[answer.response] : JSON.stringify(answer.response)}</p>
      <p><TalkWordText text={answer.feedback ?? '未提供解释'} /></p>
      <GrammarVoiceButton sentence={item.question.sentence ?? item.question.audio?.text ?? item.question.prompt ?? '语法错题'}
        analysis={{ question: item.question, answer }} source="语法错题解析" />
      {item.question.audio?.text && <PlayButton text={item.question.audio.text} label="朗读原句" />}
      {item.point && <button className="btn" onClick={() => navigate(`/grammar?tab=points&point=${item.point!.id}`)}>查看语法点与同类练习</button>}
    </details>)}
  </section>
}
