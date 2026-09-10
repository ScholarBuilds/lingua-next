/* 挑一个可执行工作流塞进画布。

   上一版是三列九宫格 + 76px 缩略图，实际渲染出来标题只剩「2…」「Fl…」「M…」。
   根因不在省略号那行 CSS：卡片只写了 `width: min(920px, …)`，而全站基础样式
   `:where(.overlay-card)` 带着 `max-width: 520px`——width 再大也被 max-width 压回去，
   520 拆三列、每列再扣掉 76px 缩略图，留给标题的只有七十来像素。
   所以这一版 width 与 max-width 一起写死，且标题**允许换行、不截断**。

   目前工作流总共十几条（实测 15 条），列表不做虚拟化：
   `@tanstack/react-virtual` 装着，等真到上百条再上，现在上只会把首帧变复杂。 */

import { useQuery } from '@tanstack/react-query'
import { Boxes, Cloud, Film, ImagePlus, Maximize2, WandSparkles, Workflow } from '@/components/NexusIcon'
import { useMemo, useState } from 'react'
import type { ReactNode } from 'react'

import { Overlay } from '../../components/Overlay'
import { IconClose, IconSearch } from '../../components/icons'
import { apiStudio } from '../../lib/api-studio'
import type { ExecutableWorkflow } from '../../lib/api-studio'
import {
  filterWorkflows,
  groupWorkflows,
  providerLabel,
  purposeFacets,
  readWorkflowUsage,
  recordWorkflowUsage,
  sortWorkflows,
  usedAtLabel,
  workflowPurpose,
} from './workflow-picker'
import type { WorkflowPurposeId, WorkflowUsage, WorkflowUsageMap } from './workflow-picker'
import './workflow-picker.css'

type ProviderFilter = 'all' | ExecutableWorkflow['provider']

const PROVIDER_TABS: Array<{ value: ProviderFilter; label: string }> = [
  { value: 'all', label: '全部' },
  { value: 'comfyui', label: 'ComfyUI' },
  { value: 'runninghub', label: 'RunningHub' },
]

/** 用途各给一个能一眼分开的字形，没有缩略图的工作流全靠它认 */
const PURPOSE_GLYPH: Record<WorkflowPurposeId, ReactNode> = {
  image: <ImagePlus />,
  edit: <WandSparkles />,
  upscale: <Maximize2 />,
  video: <Film />,
  other: <Workflow />,
}

export function WorkflowNodePicker({
  onClose,
  onPick,
  initialProvider = 'all',
  title = '添加可执行工作流',
}: {
  onClose: () => void
  onPick: (workflow: ExecutableWorkflow) => void
  initialProvider?: ProviderFilter
  title?: string
}) {
  const [query, setQuery] = useState('')
  const [provider, setProvider] = useState<ProviderFilter>(initialProvider)
  const [purpose, setPurpose] = useState<'all' | WorkflowPurposeId>('all')
  const [usage, setUsage] = useState<WorkflowUsageMap>(() => readWorkflowUsage())
  const now = useMemo(() => Date.now(), [])

  const workflows = useQuery({
    queryKey: ['studio-workflows', 'canvas-picker'],
    queryFn: () => apiStudio.workflows('?enabled=true'),
  })
  const all = useMemo(() => workflows.data?.items ?? [], [workflows.data])

  // 来源的条数按「除来源外的其它筛选都生效」算，点之前就知道那边有没有货
  const providerCounts = useMemo(() => {
    const scoped = filterWorkflows(all, { provider: 'all', purpose, query })
    return {
      all: scoped.length,
      comfyui: scoped.filter((item) => item.provider === 'comfyui').length,
      runninghub: scoped.filter((item) => item.provider === 'runninghub').length,
    }
  }, [all, purpose, query])

  const facets = useMemo(
    () => purposeFacets(filterWorkflows(all, { provider, purpose: 'all', query })),
    [all, provider, query],
  )

  const matched = useMemo(
    () => sortWorkflows(filterWorkflows(all, { provider, purpose, query }), usage),
    [all, provider, purpose, query, usage],
  )

  const groups = useMemo(
    () => groupWorkflows(matched, usage, query.trim() !== ''),
    [matched, query, usage],
  )

  const filtering = query.trim() !== '' || provider !== 'all' || purpose !== 'all'
  function resetFilters(): void {
    setQuery('')
    setProvider('all')
    setPurpose('all')
  }

  function pick(workflow: ExecutableWorkflow): void {
    setUsage(recordWorkflowUsage(workflow.key))
    onPick(workflow)
    onClose()
  }

  return (
    <Overlay onClose={onClose} card="wfp-card" labelledBy="wfp-title">
      <header className="wfp-head">
        <div className="wfp-head-text">
          <h3 id="wfp-title">{title}</h3>
          <p className="wfp-head-sub">
            ComfyUI 与 RunningHub 都作为持久后台任务运行，关掉页面也不会断
          </p>
        </div>
        <button className="btn-ghost-sm" aria-label="关闭" onClick={onClose}>
          <IconClose />
        </button>
      </header>

      <div className="wfp-tools">
        <label className="wfp-search">
          <IconSearch />
          <input
            autoFocus
            value={query}
            placeholder="搜名字或用途，比如「放大」「改图」「云端」"
            aria-label="搜索工作流"
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              // 搜到只剩想要的那条时，回车直接选中，不用再挪一次鼠标
              if (event.key === 'Enter' && matched.length > 0) pick(matched[0])
            }}
          />
          {query !== '' && (
            <button className="wfp-search-clear" aria-label="清空搜索" onClick={() => setQuery('')}>
              <IconClose />
            </button>
          )}
        </label>
        <div className="wfp-seg" role="group" aria-label="来源">
          {PROVIDER_TABS.map((tab) => (
            <button
              key={tab.value}
              className={provider === tab.value ? 'wfp-seg-btn wfp-seg-on' : 'wfp-seg-btn'}
              aria-pressed={provider === tab.value}
              onClick={() => setProvider(tab.value)}
            >
              {tab.label}
              <span className="wfp-seg-num">{providerCounts[tab.value]}</span>
            </button>
          ))}
        </div>
      </div>

      {facets.length > 1 && (
        <div className="wfp-facets" role="group" aria-label="用途">
          <button
            className={purpose === 'all' ? 'wfp-facet wfp-facet-on' : 'wfp-facet'}
            aria-pressed={purpose === 'all'}
            onClick={() => setPurpose('all')}
          >
            全部用途
          </button>
          {facets.map((facet) => (
            <button
              key={facet.id}
              className={purpose === facet.id ? 'wfp-facet wfp-facet-on' : 'wfp-facet'}
              aria-pressed={purpose === facet.id}
              onClick={() => setPurpose(facet.id)}
            >
              {facet.label}
              <span className="wfp-facet-num">{facet.count}</span>
            </button>
          ))}
        </div>
      )}

      <div className="wfp-body">
        {workflows.isPending && (
          <div className="wfp-grid" aria-hidden="true">
            {[0, 1, 2, 3, 4, 5].map((slot) => (
              <div className="wfp-skeleton" key={slot}>
                <span className="wfp-skeleton-thumb" />
                <span className="wfp-skeleton-line" />
                <span className="wfp-skeleton-line wfp-skeleton-short" />
              </div>
            ))}
          </div>
        )}

        {workflows.isError && (
          <div className="wfp-empty">
            <p className="wfp-empty-title">工作流没载入成功</p>
            <p className="wfp-empty-sub">{workflows.error.message}</p>
            <button className="btn btn-outline btn-sm" onClick={() => void workflows.refetch()}>
              重试
            </button>
          </div>
        )}

        {!workflows.isPending && !workflows.isError && matched.length === 0 && (
          <div className="wfp-empty">
            <p className="wfp-empty-title">{filtering ? '没有匹配的工作流' : '还没有可用的工作流'}</p>
            <p className="wfp-empty-sub">
              {filtering
                ? '换个词试试，或者清掉筛选看看全部'
                : '去「工作流中心」导入 ComfyUI 导出物或 RunningHub 应用，启用后就会出现在这里'}
            </p>
            {filtering && (
              <button className="btn btn-outline btn-sm" onClick={resetFilters}>
                清除筛选
              </button>
            )}
          </div>
        )}

        {groups.map((group) => (
          <section className="wfp-group" key={group.id}>
            {group.label !== '' && (
              <h4 className="wfp-group-head">
                {group.label}
                <span className="wfp-group-num">{group.items.length}</span>
              </h4>
            )}
            <div className="wfp-grid">
              {group.items.map((workflow) => (
                <WorkflowCard
                  key={workflow.id}
                  workflow={workflow}
                  usage={usage[workflow.key]}
                  now={now}
                  onPick={pick}
                />
              ))}
            </div>
          </section>
        ))}
      </div>
    </Overlay>
  )
}

function WorkflowCard({
  workflow,
  usage,
  now,
  onPick,
}: {
  workflow: ExecutableWorkflow
  usage: WorkflowUsage | undefined
  now: number
  onPick: (workflow: ExecutableWorkflow) => void
}) {
  const purpose = workflowPurpose(workflow)
  const needsSetup = workflow.field_count > 0
  return (
    <button className="wfp-item" onClick={() => onPick(workflow)}>
      <span className="wfp-thumb">
        {workflow.has_thumbnail ? (
          <img src={`/api/studio/workflows/${workflow.id}/thumbnail`} alt="" loading="lazy" />
        ) : (
          <span className="wfp-thumb-glyph">{PURPOSE_GLYPH[purpose.id]}</span>
        )}
        <span className="wfp-thumb-tag">{purpose.label}</span>
      </span>
      <span className="wfp-text">
        {/* 标题一律完整展示：名字看不全就等于这张卡白摆 */}
        <strong className="wfp-name">{workflow.title}</strong>
        <span className="wfp-hint">{purpose.hint}</span>
        <span className="wfp-chips">
          <span className="wfp-chip">
            {workflow.provider === 'comfyui' ? <Boxes /> : <Cloud />}
            {providerLabel(workflow.provider)}
          </span>
          {needsSetup ? (
            <span className="wfp-chip wfp-chip-setup" title={`选中后有 ${workflow.field_count} 项参数可填`}>
              需配置
            </span>
          ) : (
            <span className="wfp-chip wfp-chip-free">开箱即用</span>
          )}
          {usage !== undefined && (
            <span className="wfp-chip wfp-chip-used" title={`一共用过 ${usage.count} 次`}>
              {usedAtLabel(usage.last, now)}
            </span>
          )}
        </span>
      </span>
    </button>
  )
}
