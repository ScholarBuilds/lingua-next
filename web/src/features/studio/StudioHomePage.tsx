import { useQuery } from '@tanstack/react-query'
import { Link, useNavigate } from 'react-router-dom'

import { Topbar } from '@/components/Topbar'
import { apiImage } from '@/lib/api-image'

import { useStudioTasks } from './taskQueries'
import {
  groupStudioTools,
  summarizeStudioActivity,
  toolGap,
  toolTone,
  useStudioToolCatalog,
} from './toolRegistry'
import type { StudioSection, StudioToolDefinition } from './toolRegistry'
import './studio-home.css'

/** 蓝本编号、能力条数这些是内部标识，放进 title 供排查，不占卡面 */
function cardTitle(tool: StudioToolDefinition): string {
  const tone = toolTone(tool.status)
  if (tone === 'planned') return `${tool.label}：还没做`
  const gap = toolGap(tool)
  const facts = [tool.blueprint]
  if (tool.capabilities.length > 0) facts.push(`${tool.capabilities.length} 项模型能力`)
  return gap === null ? facts.join(' · ') : `${facts.join(' · ')}；已知缺口：${gap}`
}

function ToolCard({ tool, lead }: { tool: StudioToolDefinition; lead: boolean }): JSX.Element {
  const navigate = useNavigate()
  const Icon = tool.icon
  const tone = toolTone(tool.status)
  const openable = tool.route !== null && tone !== 'planned'
  const classes = ['sth-card']
  if (lead) classes.push('sth-card-lead')
  if (tone === 'planned') classes.push('sth-card-planned')
  return (
    <button
      className={classes.join(' ')}
      disabled={!openable}
      onClick={() => tool.route !== null && navigate(tool.route)}
      title={cardTitle(tool)}
    >
      <span className="sth-icon">
        <Icon aria-hidden />
      </span>
      <span className="sth-name">
        {tool.label}
        {tone === 'beta' && (
          <span className="sth-dot" role="img" aria-label={toolGap(tool) ?? '有已知缺口'} />
        )}
      </span>
      <span className="sth-hint">{tool.hint}</span>
    </button>
  )
}

function ToolSection({ section }: { section: StudioSection }): JSX.Element {
  return (
    <section className="sth-section">
      <div className="sth-section-head">
        <h2>{section.label}</h2>
        <p>{section.hint}</p>
      </div>
      <div className={section.lead ? 'sth-grid sth-grid-lead' : 'sth-grid'}>
        {section.tools.map((tool) => (
          <ToolCard key={tool.id} tool={tool} lead={section.lead} />
        ))}
      </div>
    </section>
  )
}

export default function StudioHomePage(): JSX.Element {
  const catalog = useStudioToolCatalog()
  const tasks = useStudioTasks()
  const assets = useQuery({
    queryKey: ['image-stats'],
    queryFn: apiImage.stats,
    staleTime: 60_000,
  })
  const sections = groupStudioTools(catalog.data?.tools ?? [])
  const activity = summarizeStudioActivity(tasks.data?.items ?? [])
  // 读不到就照实留一道横杠，不要拿 0 冒充「今天什么都没干」
  const figures: { to: string; value: string; label: string }[] = [
    { to: '/tasks', value: tasks.isSuccess ? String(activity.running) : '—', label: '进行中' },
    { to: '/tasks', value: tasks.isSuccess ? String(activity.doneToday) : '—', label: '今天完成' },
    {
      to: '/studio/assets',
      value: assets.isSuccess ? String(assets.data.count) : '—',
      label: '素材',
    },
  ]

  return (
    <div className="main">
      <Topbar
        title="工坊"
        meta={figures.map((figure) => (
          <Link key={figure.label} className="chip link" to={figure.to} title={figure.label}>
            {figure.value} {figure.label}
          </Link>
        ))}
      />
      <div className="content">
      <main className="sth">

      {catalog.isPending && (
        <div className="state-block">
          <div className="spinner" />
          <div>加载工具插件…</div>
        </div>
      )}
      {catalog.isError && (
        <div className="state-block">
          <div>工具插件目录加载失败：{catalog.error.message}</div>
        </div>
      )}
      {sections.map((section) => (
        <ToolSection key={section.id} section={section} />
      ))}
      </main>
      </div>
    </div>
  )
}
