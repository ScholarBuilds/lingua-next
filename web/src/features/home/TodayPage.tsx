/* 「今天」首页（CR-006 D5）：打开即可接着干。

   四块：接着来（上次读到哪、看到哪、练到哪）· 在跑（与侧栏面板同一条数据）·
   最近加入（导入卡内联）· 右列到期复习数与本周时长。
   数据由 /home 一次聚合，进度口径与书架、视频库一致；在跑那块不经 /home，
   直接读统一任务流（useRunningRows），和侧栏说的是同一件事。 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'

import {
  IconBook,
  IconFileText,
  IconPlus,
  IconTask,
  IconVideo,
} from '../../components/icons'
import { Topbar } from '../../components/Topbar'
import { speakAssistant } from '../../lib/audio'
import { apiAssistant } from '../../lib/api-assistant'
import { apiGoogle } from '../../lib/api-google'
import { apiHome } from '../../lib/api-home'
import type { RecentItem } from '../../lib/api-home'
import { useRunningRows } from '../pipeline/runningRows'
import './home.css'
import { TodayPlan } from './TodayPlan'

const WEEKDAYS = ['一', '二', '三', '四', '五', '六', '日']

const STATUS_LABEL: Record<string, string> = {
  pending: '等待处理',
  parsing: '解析中',
  downloading: '下载中',
  transcribing: '转写中',
  translating: '翻译中',
  ready: '就绪',
  degraded: '不达标',
  failed: '失败',
}

const KIND_LABEL: Record<RecentItem['kind'], string> = { book: '书', article: '文章', video: '视频' }

function dateLabel(now: Date, timezone?: string): string {
  return now.toLocaleDateString('zh-CN', { timeZone: timezone, month: 'long', day: 'numeric', weekday: 'short' })
}

/** 「昨天 22:14」这类相对说法：今天只报时刻，一周内报星期，再远报日期 */
function whenLabel(iso: string | null, now: Date): string {
  if (iso === null) return ''
  const t = new Date(iso)
  if (Number.isNaN(t.getTime())) return ''
  const hm = t.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
  const dayDiff = Math.floor((now.setHours(0, 0, 0, 0) - new Date(t).setHours(0, 0, 0, 0)) / 86_400_000)
  if (dayDiff <= 0) return `今天 ${hm}`
  if (dayDiff === 1) return `昨天 ${hm}`
  if (dayDiff < 7) return `周${WEEKDAYS[(t.getDay() + 6) % 7]} ${hm}`
  return `${t.getMonth() + 1} 月 ${t.getDate()} 日`
}

function clockOf(iso: string | null): string {
  if (iso === null) return ''
  const t = new Date(iso)
  return Number.isNaN(t.getTime()) ? '' : t.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
}

function RecentIcon({ kind }: { kind: RecentItem['kind'] }) {
  if (kind === 'video') return <IconVideo />
  if (kind === 'article') return <IconFileText />
  return <IconBook />
}

function timeOf(iso: string | null): string {
  if (!iso) return ''
  const d = new Date(iso)
  return `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`
}

export function TodayPage() {
  const navigate = useNavigate()
  const home = useQuery({ queryKey: ['home'], queryFn: apiHome.get, refetchInterval: 60_000 })
  // 日程来自 Google 日历（模块 18）：没连账号时接口返回 accounts=0，卡片不渲染
  const calendar = useQuery({ queryKey: ['calendar-today'], queryFn: apiGoogle.calendarToday, refetchInterval: 300_000 })
  const running = useRunningRows()
  const qc = useQueryClient()
  // 早报是模块 20 的例程，07:30 自动跑；没跑过可以在这里现生成
  const makeBrief = useMutation({
    mutationFn: () => apiAssistant.runRoutine('morning_brief'),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['home'] }),
  })
  const now = new Date()
  const data = home.data
  const due = data?.review_due ?? 0
  const week = data?.week_minutes ?? [0, 0, 0, 0, 0, 0, 0]
  const weekMax = Math.max(1, ...week)
  const weekTotal = week.reduce((a, b) => a + b, 0)
  const todayIdx = (now.getDay() + 6) % 7

  return (
    <div className="main">
      <Topbar
        title="今天"
        meta={<span className="chip">{dateLabel(now, data?.plan.timezone)}</span>}
        actions={
          <>
            <button className="btn btn-outline" onClick={() => navigate('/read')}>
              <IconPlus />
              导入
            </button>
            <button className="btn btn-primary" onClick={() => navigate('/vocab?v=review')}>
              开始复习{due > 0 ? ` · ${due}` : ''}
            </button>
          </>
        }
      />

      <div className="content">
        <div className="today-inner">
          <div className="today-cols">
            <div>
              {data && <TodayPlan data={data} />}
              {home.isPending && <p role="status">读取今日安排…</p>}
              {home.error && <p role="alert">首页读取失败：{home.error.message} <button className="btn btn-outline" onClick={() => void home.refetch()}>重试</button></p>}

              <section className="today-sec">
                <div className="today-sec-head">
                  <h2>在跑</h2>
                  {running.length > 0 && <span className="today-count mono">{running.length}</span>}
                  <button className="today-more" onClick={() => navigate('/tasks')}>全部任务</button>
                </div>
                {running.length === 0 ? (
                  <p className="today-quiet">当前没有在跑的任务。</p>
                ) : (
                  <div className="card">
                    {running.map((row) => (
                      <button key={row.key} className="today-run" onClick={() => navigate(row.route)}>
                        <span className="today-dot" />
                        <span className="today-run-main">
                          <span className="today-run-title">{row.title}</span>
                          <span className="today-run-sub">{row.step}</span>
                        </span>
                        <span className="today-bar"><i style={{ width: `${Math.max(3, row.progress)}%` }} /></span>
                        <span className="today-run-pct mono">{Math.round(row.progress)}%</span>
                      </button>
                    ))}
                  </div>
                )}
              </section>

              <section className="today-sec">
                <div className="today-sec-head">
                  <h2>最近加入</h2>
                  <button className="today-more" onClick={() => navigate('/read')}>阅读 · 视频</button>
                </div>
                <div className="today-recent">
                  {(data?.recent ?? []).map((item) => (
                    <button key={`${item.kind}:${item.id}`} className="card today-rc" onClick={() => navigate(item.href)}>
                      <span className="today-rc-ic"><RecentIcon kind={item.kind} /></span>
                      <span className="today-rc-body">
                        <b className={item.kind === 'video' || item.kind === 'book' ? 'serif' : ''}>{item.title}</b>
                        <small>
                          {[KIND_LABEL[item.kind], whenLabel(item.created_at, new Date(now)), STATUS_LABEL[item.status] ?? item.status]
                            .filter(Boolean)
                            .join(' · ')}
                        </small>
                      </span>
                    </button>
                  ))}
                  <button className="card today-rc today-rc-import" onClick={() => navigate('/read')}>
                    <IconPlus />
                    <b>拖入文件，或粘贴链接</b>
                  </button>
                </div>
              </section>
            </div>

            <aside className="today-aside">
              <div className="card today-due">
                <b className="mono">{due}</b>
                <span>张到期</span>
                <button className="btn btn-primary" onClick={() => navigate('/vocab?v=review')}>复习</button>
              </div>
              <div className="card today-brief">
                <div className="today-brief-head">早报<span className="sub">{data?.brief ? timeOf(data.brief.at) : '每天 07:30'}</span></div>
                {data?.brief ? (
                  <>
                    <p className="today-brief-text">{data.brief.text}</p>
                    <div className="today-brief-foot">
                      <button className="btn btn-outline" onClick={() => speakAssistant(data.brief!.text)}>念一遍</button>
                    </div>
                  </>
                ) : (
                  <div className="today-brief-foot">
                    <span className="today-quiet">邮件 · 日程 · 任务 · 到期词</span>
                    <button className="btn btn-outline" disabled={makeBrief.isPending} onClick={() => makeBrief.mutate()}>
                      {makeBrief.isPending ? '生成中' : '现在生成'}
                    </button>
                  </div>
                )}
              </div>
              <div className="card today-stat">
                <div className="today-stat-head">
                  <span>本周</span>
                  <b className="mono">
                    {Math.floor(weekTotal / 60)}<small>小时</small> {weekTotal % 60}<small>分</small>
                  </b>
                </div>
                <div className="today-week" role="img" aria-label={`本周每天学习分钟数：${week.join('，')}`}>
                  {week.map((m, i) => (
                    <i key={i} className={i === todayIdx ? 'today' : ''} style={{ height: `${Math.max(4, (m / weekMax) * 100)}%` }} title={`${m} 分钟`} />
                  ))}
                </div>
                <div className="today-week-l">
                  {WEEKDAYS.map((d) => <span key={d}>{d}</span>)}
                </div>
              </div>
              {calendar.data !== undefined && calendar.data.accounts > 0 && (
                <div className="card today-cal">
                  <div className="today-cal-head">今天的日程<span className="sub">Google 日历</span></div>
                  {calendar.data.events.length === 0 && <p className="today-quiet">今天没有安排。</p>}
                  <ul>
                    {calendar.data.events.map((ev) => (
                      <li key={`${ev.account_id}:${ev.id}`}>
                        <span className="today-cal-time mono">{ev.all_day ? '全天' : clockOf(ev.start)}</span>
                        <span className="today-cal-title">{ev.summary}</span>
                      </li>
                    ))}
                  </ul>
                  {calendar.data.errors.map((e) => <p key={e.email} className="today-quiet">{e.email}：{e.detail}</p>)}
                </div>
              )}
              <div className="card today-keys">
                <kbd>⌘K</kbd><span>搜索、跳转、命令</span>
                <kbd>Esc</kbd><span>关闭浮层</span>
              </div>
              <div className="card today-hint">
                <IconTask />
                <span>侧栏「任务」下面会列出正在跑的几条，点了直接到来源现场。</span>
              </div>
            </aside>
          </div>
        </div>
      </div>
    </div>
  )
}
