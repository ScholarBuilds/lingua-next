import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../../components/ui/dialog'
import { apiPractice, type PracticeProfile } from '../../lib/api-practice'

export function PracticePlan({ onClose }: { onClose: () => void }) {
  const query = useQuery({ queryKey: ['practice-profile'], queryFn: apiPractice.profile })
  return <Dialog open onOpenChange={(open) => { if (!open) onClose() }}><DialogContent className="vp-prepare" aria-describedby={undefined}>
    <DialogHeader><DialogTitle>学习计划</DialogTitle></DialogHeader>
    {query.isPending && <p>正在读取…</p>}{query.isError && <p role="alert">{query.error.message}</p>}
    {query.data && <PlanForm initial={query.data} onClose={onClose} />}
  </DialogContent></Dialog>
}

function PlanForm({ initial, onClose }: { initial: PracticeProfile; onClose: () => void }) {
  const client = useQueryClient()
  const [profile, setProfile] = useState({ ...initial })
  const save = useMutation({ mutationFn: () => apiPractice.saveProfile(profile), onSuccess: (data) => { client.setQueryData(['practice-profile'], data); onClose() } })
  return <form className="vp-plan-form" onSubmit={(e) => { e.preventDefault(); save.mutate() }}>
    <label className="vp-field">每日新词目标<input className="input" type="number" min={1} max={100} value={profile.daily_new} onChange={(e) => setProfile({ ...profile, daily_new: Number(e.target.value) })} /></label>
    <label className="vp-field">学习时区<input className="input" value={profile.timezone} onChange={(e) => setProfile({ ...profile, timezone: e.target.value })} /></label>
    <label><input type="checkbox" checked={profile.auto_enabled} onChange={(e) => setProfile({ ...profile, auto_enabled: e.target.checked })} /> 完成训练后自动生成针对性练习</label>
    <label className="vp-field">每日自动生成上限<input className="input" type="number" min={0} max={5} value={profile.auto_limit} onChange={(e) => setProfile({ ...profile, auto_limit: Number(e.target.value) })} /></label>
    <p>今日已发出 {initial.auto_used} 次自动调用。失败的调用也计入额度；费用取决于配置的模型，额度不是金额上限。</p>
    {save.isError && <p role="alert">{save.error.message}</p>}
    <div className="vp-actions"><button type="button" className="btn" onClick={onClose}>取消</button><button className="btn btn-primary" disabled={save.isPending}>保存计划</button></div>
  </form>
}
