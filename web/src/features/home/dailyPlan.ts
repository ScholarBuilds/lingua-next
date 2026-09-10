import type { HomePayload, PlanItem } from '@/lib/api-home'
import type { ResumeEntry } from '../vocab/listenResume'

export function localDay(now: Date, timezone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now)
}

export function localPracticeItems(storage: Pick<Storage, 'length' | 'key' | 'getItem'>, listening: Record<string, ResumeEntry>): PlanItem[] {
  const items: PlanItem[] = []
  for (let index = 0; index < storage.length; index++) {
    const key = storage.key(index)
    if (!key?.startsWith('nexus:drill:v2:')) continue
    const scope = key.slice('nexus:drill:v2:'.length)
    const split = scope.indexOf(':', scope.startsWith('custom:') ? 'custom:'.length : 0)
    const deckKey = scope.slice(0, split)
    const scene = scope.slice(split + 1)
    const href = '/vocab?' + new URLSearchParams({ v: 'drill', k: deckKey, g: scene })
    try {
      const saved = JSON.parse(storage.getItem(key) ?? 'null')
      const groups: unknown = JSON.parse(saved?.signature ?? 'null')
      if (saved?.version !== 2 || !Array.isArray(groups) || !Number.isInteger(saved.state?.groupIdx) || saved.state.groupIdx < 0) throw new Error('invalid')
      const total = Number.isInteger(saved.totalGroups) && saved.totalGroups >= 0 ? saved.totalGroups : groups.length
      if (saved.state.groupIdx >= total) continue
      items.push({ key, kind: 'drill', title: `速记 · ${saved.deckName ?? deckKey}`,
        progress: `已完成 ${saved.state.groupIdx} / ${total} 组`, updated_at: saved.updatedAt ?? null,
        href, priority: 1, deckKey })
    } catch {
      items.push({ key, kind: 'drill', title: `速记 · ${deckKey}`, progress: '本机断点无法读取', updated_at: null,
        href: '/vocab', priority: 1, unavailable: '断点格式已失效，请返回单词本重新选择练习。' })
    }
  }
  for (const [scopeKey, entry] of Object.entries(listening)) {
    const [deckKey, filter = 'all', sort = 'default', query = '', group = ''] = scopeKey.split('|')
    if (typeof entry?.word !== 'string' || !Number.isFinite(entry.at)) continue
    items.push({ key: `listen:${scopeKey}`, kind: 'listen', title: `听读 · ${entry.deckName ?? deckKey}`, deckKey,
      progress: `${entry.word}${entry.total ? ` · 第 ${(entry.position ?? 0) + 1} / ${entry.total} 词` : ''}`,
      updated_at: new Date(entry.at).toISOString(), priority: 1, word: entry.word, scopeKey,
      href: '/vocab?' + new URLSearchParams({ v: 'deck', k: deckKey, f: filter, sort, q: query, g: group }),
    })
  }
  return items
}

export function planItems(data: HomePayload, local: PlanItem[]): PlanItem[] {
  const items: PlanItem[] = [...data.plan.resume, ...local]
  if (data.review_due) items.push({ key: 'review', kind: 'review', title: '到期复习', progress: `${data.review_due} 词待复习`, href: '/vocab?v=review', priority: 0, updated_at: null })
  const remaining = Math.max(0, data.plan.daily_new - data.plan.learned)
  if (remaining) items.push({ key: 'learn', kind: 'learn', title: '今日新词', progress: `已学 ${data.plan.learned} / ${data.plan.daily_new} 词 · 剩余 ${remaining} 词`, href: '/vocab?v=learn', priority: 2, updated_at: null })
  const { reading, video, talk } = data.continue
  if (reading) items.push({ key: `reading:${reading.article_id}`, kind: 'reading', title: reading.title, progress: `阅读 ${Math.round(reading.progress_pct)}%`, href: `/read/${reading.article_id}`, updated_at: reading.updated_at, priority: 3 })
  if (video) items.push({ key: `video:${video.video_id}`, kind: 'video', title: video.title, progress: `视频 ${Math.round(video.progress_pct)}%`, href: `/video/${video.video_id}`, updated_at: video.updated_at, priority: 3 })
  if (talk) items.push({ key: `talk:${talk.session_id}`, kind: 'talk', title: talk.title, progress: talk.ended_at ? `上次 ${talk.minutes ?? 0} 分钟 · 查看记录` : '未结束的对话', href: `/talk/session?id=${talk.session_id}`, updated_at: talk.started_at, priority: 3 })
  return [...new Map(items.map(item => [item.key, item])).values()]
}

export function arrangePlan(items: PlanItem[], pinned: string[], deferred: Record<string, string>, day: string) {
  const arranged = [...items].sort((a, b) => Number(pinned.includes(b.key)) - Number(pinned.includes(a.key)) || a.priority - b.priority || (b.updated_at ?? '').localeCompare(a.updated_at ?? '') || a.key.localeCompare(b.key))
  return { active: arranged.filter(item => deferred[item.key] !== day), deferred: arranged.filter(item => deferred[item.key] === day) }
}
