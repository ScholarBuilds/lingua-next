import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import type { HomePayload, PlanItem } from '@/lib/api-home'
import { apiDeck, ApiDeckError, request } from '@/lib/api-deck'
import { usePrefStore } from '@/lib/prefStore'
import { useListenResume } from '../vocab/listenResume'
import { useListenStore } from '../vocab/listenStore'
import { PracticePlan } from '../vocab/PracticePlan'
import { arrangePlan, localDay, localPracticeItems, planItems } from './dailyPlan'

export function TodayPlan({ data }: { data: HomePayload }) {
  const navigate = useNavigate()
  const client = useQueryClient()
  const prefs = usePrefStore(s => s.prefs.today)
  const update = usePrefStore(s => s.update)
  const listening = useListenResume(s => s.entries)
  const [now, setNow] = useState(() => new Date())
  const [showDeferred, setShowDeferred] = useState(false)
  const [planOpen, setPlanOpen] = useState(false)
  const decks = useQuery({ queryKey: ['decks'], queryFn: apiDeck.list })
  useEffect(() => {
    const tick = () => setNow(new Date())
    const interval = window.setInterval(tick, 30_000)
    window.addEventListener('focus', tick)
    return () => { window.clearInterval(interval); window.removeEventListener('focus', tick) }
  }, [])
  let local: PlanItem[] = []
  let storageError = false
  try { local = localPracticeItems(localStorage, listening) } catch { storageError = true }
  const day = localDay(now, data.plan.timezone)
  useEffect(() => {
    if (day !== data.plan.day) void client.invalidateQueries({ queryKey: ['home'] })
  }, [day, data.plan.day, client])
  const { active, deferred } = arrangePlan(planItems(data, local), prefs.pinned, prefs.deferred, day)
  const defer = (key: string, restore: boolean) => {
    const next = Object.fromEntries(Object.entries(prefs.deferred).filter(([item, date]) => date === day && item !== key))
    if (!restore) next[key] = day
    update({ today: { deferred: next } })
  }
  const open = async (item: PlanItem) => {
    if (item.unavailable) { toast.error(item.unavailable); navigate(item.href); return }
    if (item.deckKey) {
      try {
        const available = await apiDeck.list()
        const deck = available.find(deck => deck.key === item.deckKey)
        if (!deck) { toast.error('原单词本已删除，断点仍保留在本机。'); navigate('/vocab'); return }
        if (item.kind === 'listen' && item.scopeKey) useListenStore.getState().open(deck.key, deck.name, item.scopeKey, item.href)
      } catch (error) { toast.error(error instanceof Error ? error.message : '单词本暂时无法读取，请重试'); return }
    }
    const endpoints: Partial<Record<PlanItem['kind'], string>> = { practice: '/practice/', grammar: '/grammar/practice/', reading: '/articles/', video: '/videos/', talk: '/talk/sessions/' }
    const fallbacks: Partial<Record<PlanItem['kind'], string>> = { practice: '/vocab', grammar: '/grammar', reading: '/read', video: '/video', talk: '/talk' }
    if (endpoints[item.kind]) {
      try { await request(`/api${endpoints[item.kind]}${encodeURIComponent(item.key.slice(item.key.indexOf(':') + 1))}`) }
      catch (error) {
        if (error instanceof ApiDeckError && [404, 410].includes(error.status)) {
          toast.error('原内容或练习已不可用，已返回对应模块。')
          navigate(fallbacks[item.kind] ?? '/')
          void client.invalidateQueries({ queryKey: ['home'] })
        } else toast.error(error instanceof Error ? error.message : '暂时无法恢复，请重试')
        return
      }
    }
    navigate(item.href)
  }
  const row = (item: PlanItem, postponed = false) => {
    const missing = item.deckKey && decks.isSuccess && !decks.data.some(deck => deck.key === item.deckKey)
    const deckName = item.deckKey && decks.data?.find(deck => deck.key === item.deckKey)?.name
    const title = deckName ? `${item.kind === 'drill' ? '速记' : '听读'} · ${deckName}` : item.title
    const pinned = prefs.pinned.includes(item.key)
    return <li key={item.key} className="today-plan-row">
      <div className="today-plan-description"><strong>{title}</strong><span>{missing ? '原单词本已删除' : item.progress}</span>
        {item.updated_at && <time dateTime={item.updated_at}>{new Date(item.updated_at).toLocaleString('zh-CN', { timeZone: data.plan.timezone, month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</time>}</div>
      <div className="today-plan-actions">
        <button className="btn btn-outline btn-sm" aria-pressed={pinned} onClick={() => update({ today: { pinned: pinned ? prefs.pinned.filter(key => key !== item.key) : [...prefs.pinned, item.key] } })}>{pinned ? '取消置顶' : '置顶'}</button>
        <button className="btn btn-outline btn-sm" onClick={() => defer(item.key, postponed)}>{postponed ? '恢复安排' : '今天暂放'}</button>
        <button className="btn btn-primary btn-sm" onClick={() => void open(item)}>{missing || item.unavailable ? '返回模块' : item.kind === 'review' || item.kind === 'learn' ? '开始' : '继续'}</button>
      </div>
    </li>
  }
  return <section className="today-sec" aria-label="今日学习安排">
    <div className="today-sec-head"><h2>今日安排</h2><button className="today-more" onClick={() => setPlanOpen(true)}>调整新词计划</button></div>
    <p className="today-quiet">新词 {data.plan.learned} 词 · 完成练习 {data.plan.completed_practices} 次 · 学习 {data.today_minutes} 分钟</p>
    {storageError && <p role="alert">本机断点暂时无法读取，服务器练习仍可继续。</p>}
    <ul className="today-plan">{active.map(item => row(item))}</ul>
    {!active.length && <p className="today-quiet">今天没有待办练习，可以从词汇、阅读或视频开始。</p>}
    {deferred.length > 0 && <><button className="btn btn-outline" aria-expanded={showDeferred} onClick={() => setShowDeferred(!showDeferred)}>今天暂放 · {deferred.length} 项</button>
      {showDeferred && <ul className="today-plan">{deferred.map(item => row(item, true))}</ul>}</>}
    {planOpen && <PracticePlan onClose={() => { setPlanOpen(false); void client.invalidateQueries({ queryKey: ['home'] }) }} />}
  </section>
}
