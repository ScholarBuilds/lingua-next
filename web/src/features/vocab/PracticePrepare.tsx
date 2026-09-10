import { useMutation, useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../../components/ui/dialog'
import { Picker } from '../../components/ui/picker'
import { apiDeck } from '../../lib/api-deck'
import { apiPractice, PRACTICE_MODES, type PracticeMode, type PracticeScope } from '../../lib/api-practice'
import { useFullscreenElement } from '../../components/FullscreenPortal'

export function PracticePrepare({ mode: initialMode, deck, onClose, onReady }: {
  mode: PracticeMode; deck?: string; onClose: () => void; onReady: (id: string) => void
}) {
  const [mode, setMode] = useState(initialMode)
  const [keys, setKeys] = useState<string[]>(deck ? [deck] : [])
  const [count, setCount] = useState<PracticeScope['count']>(10)
  const [filter, setFilter] = useState<PracticeScope['filter']>('all')
  const [silent, setSilent] = useState(false)
  const [group, setGroup] = useState('')
  const decks = useQuery({ queryKey: ['decks'], queryFn: apiDeck.list })
  const fullscreen = useFullscreenElement()
  const create = useMutation({
    mutationFn: () => apiPractice.create(mode, { decks: keys, count, filter, group, silent,
      return_url: window.location.pathname + window.location.search }),
    onSuccess: (record) => onReady(record.id),
  })
  return <Dialog open onOpenChange={(open) => { if (!open && !create.isPending) onClose() }}>
    <DialogContent className="vp-prepare" portalContainer={fullscreen} aria-describedby={undefined}>
      <DialogHeader><DialogTitle>准备训练</DialogTitle></DialogHeader>
      <label className="vp-field">训练方式<Picker value={mode} onChange={(v) => { setMode(v as PracticeMode); setSilent(false) }} options={Object.entries(PRACTICE_MODES).map(([value, item]) => ({ value, label: item.name }))} /></label>
      <fieldset className="vp-books"><legend>词书范围（可多选，留空使用生词本）</legend>
        {decks.isError && <p role="alert">{decks.error.message}</p>}
        {decks.isPending && <p>正在加载词书…</p>}
        {(decks.data ?? []).filter((d) => !d.archived).map((d) => <label key={d.key}>
          <input type="checkbox" checked={keys.includes(d.key)} onChange={() => setKeys((old) => old.includes(d.key) ? old.filter((key) => key !== d.key) : [...old, d.key])} />
          <span>{d.name}</span><small>{d.total.toLocaleString()} 词</small>
        </label>)}
      </fieldset>
      <div className="vp-prepare-row">
        <label className="vp-field">题数<Picker value={String(count)} onChange={(v) => setCount(Number(v) as PracticeScope['count'])} options={[5, 10, 20, 40].map((n) => ({ value: String(n), label: `${n} 题` }))} /></label>
        <label className="vp-field">学习状态<Picker disabled={mode === 'review' || mode === 'learn'} value={filter} onChange={(v) => setFilter(v as PracticeScope['filter'])} options={[{ value: 'all', label: '全部' }, { value: 'new', label: '未学' }, { value: 'learning', label: '学习中' }, { value: 'difficult', label: '困难词' }]} /></label>
      </div>
      <label className="vp-field">场景名称（可选）<input className="input" value={group} onChange={(e) => setGroup(e.target.value)} placeholder="留空包含全部场景" /></label>
      <label><input type="checkbox" disabled={mode === 'dictation' || mode === 'listening'} checked={silent} onChange={(e) => setSilent(e.target.checked)} /> 无声练习</label>
      <p className="muted">{PRACTICE_MODES[mode].description}。题目不足时只使用适合本次训练的词。</p>
      {create.isError && <p role="alert" className="form-err">{create.error.message}</p>}
      <div className="vp-actions"><button className="btn" disabled={create.isPending} onClick={onClose}>取消</button><button className="btn btn-primary" disabled={create.isPending || decks.isPending} onClick={() => create.mutate()}>{create.isPending ? '准备中…' : '开始训练'}</button></div>
    </DialogContent>
  </Dialog>
}
