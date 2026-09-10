/* 全产品唯一的换模型弹窗。
 *
 * 收编前有四套：设置页的 `Sel`（280px、按凭据名分组、第一眼是 embedding-3）、工坊对话页手写的
 * 两列 `.sgc-model-pop`、画布的 `PillPicker`、修复代理的 `ActionPicker`。四套外观各异，
 * 其中两套还把 `chat-general` 这种能力 slug 摆在「模型」位上（违反核心原则 6）。
 *
 * 分组按**厂商**不按凭据：开发库五个凭据里四个都是 `openai_compatible`，按凭据分等于不分，
 * 而同一个中转后面同时挂着 OpenAI / DeepSeek / GLM / Qwen / Kimi / MiniMax 六家。判据在
 * `lib/model-vendor.ts`，只认模型名。
 *
 * 使用 Radix 管理嵌套焦点，同时加入浮层栈以屏蔽背后页面的快捷键。
 */

import { useEffect, useMemo, useRef, useState } from 'react'

import { useEscapeClose } from '@/components/Overlay'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { useFullscreenElement } from '@/components/FullscreenPortal'
import { IconCheck, IconSearch } from '@/components/icons'
import type { Binding } from '@/lib/api-config'

import {
  type ModelRow,
  type PickableDeployment,
  type VendorGroup,
  filterGroups,
  flatten,
  groupByVendor,
  isNoiseGroup,
  moveHighlight,
  toRows,
} from './groupModels'
import './modelPicker.css'

export interface ModelPickerProps {
  open: boolean
  onClose: () => void
  /** 可选的部署，通常直接传 binding.deployment_options */
  options: PickableDeployment[]
  /** 当前选中的部署 id；跟随默认时为 null */
  value: number | null
  onPick: (deployment: PickableDeployment) => void
  /** 标题栏左侧的用途名，如「快速翻译」。不传就只说「选择模型」 */
  usage?: string
  /** 传了就在底部给一个「跟随全局默认」的动作；`modelName` 是默认那条的上游真名 */
  followDefault?: { modelName: string | null; onFollow: () => void; active: boolean }
}

/** 从绑定行取「跟随默认」需要的信息。默认那条自己不显示这个动作 */
export function defaultModelOf(bindings: Binding[] | undefined, capability: string): string | null {
  if (bindings === undefined) return null
  const row = bindings.find((b) => b.capability === capability)
  return row?.deployment?.upstream_model_id ?? row?.target ?? null
}

function VendorDot({ row }: { row: ModelRow }) {
  return (
    <span className="mpk-dot" style={{ background: row.vendor.color }} aria-hidden="true">
      {row.vendor.abbr}
    </span>
  )
}

function Row({
  row,
  selected,
  highlighted,
  onPick,
  refFor,
}: {
  row: ModelRow
  selected: boolean
  highlighted: boolean
  onPick: () => void
  refFor: (el: HTMLButtonElement | null) => void
}) {
  const d = row.deployment
  return (
    <button
      ref={refFor}
      type="button"
      role="option"
      aria-selected={selected}
      className={`mpk-row${highlighted ? ' is-cursor' : ''}${selected ? ' is-on' : ''}`}
      onClick={onPick}
    >
      <VendorDot row={row} />
      <span className="mpk-name">
        {d.upstream_model_id}
        {d.display_name !== null && d.display_name !== '' && (
          <span className="mpk-alias">{d.display_name}</span>
        )}
      </span>
      <span className="mpk-account">{row.account}</span>
      {d.ready === false && <span className="mpk-warn">接线缺失</span>}
      {selected && <IconCheck />}
    </button>
  )
}

export function ModelPicker({
  open,
  onClose,
  options,
  value,
  onPick,
  usage,
  followDefault,
}: ModelPickerProps) {
  const [query, setQuery] = useState('')
  const [cursor, setCursor] = useState(-1)
  const [showNoise, setShowNoise] = useState(false)
  const listRef = useRef<HTMLDivElement | null>(null)
  const rowRefs = useRef(new Map<number, HTMLButtonElement>())
  const wasOpen = useRef(false)
  const fullscreen = useFullscreenElement()
  useEscapeClose(onClose, open)

  const allGroups = useMemo(() => groupByVendor(toRows(options)), [options])
  const groups = useMemo(() => {
    const matched = filterGroups(allGroups, query)
    // 搜到了就别再把非对话那组藏着——用户明确在找它
    if (showNoise || query.trim() !== '') return matched
    return matched.filter((g) => !isNoiseGroup(g))
  }, [allGroups, query, showNoise])
  const rows = useMemo(() => flatten(groups), [groups])
  const noiseCount = useMemo(
    () => allGroups.filter(isNoiseGroup).reduce((n, g) => n + g.rows.length, 0),
    [allGroups],
  )

  /* 常驻挂载的浮层关掉只是不渲染，useState 原样留着：不在「关 → 开」这一次同步回当前值，
     下次打开还停在上次搜过的词上、翻到一片空白（本仓画风选择器与视频批量导入各踩过一次）。
     用 ref 抓边沿而不是挂 [open]——挂 [open] 会在关闭动画播到一半时把内容清空。 */
  useEffect(() => {
    if (open && !wasOpen.current) {
      setQuery('')
      setShowNoise(false)
      setCursor(rows.findIndex((r) => r.deployment.id === value))
    }
    wasOpen.current = open
  })

  // 搜索改变后旧光标多半指向别的行了，回到第一条
  useEffect(() => {
    setCursor((cur) => (cur >= rows.length ? (rows.length > 0 ? 0 : -1) : cur))
  }, [rows.length])

  useEffect(() => {
    if (cursor < 0) return
    const row = rows[cursor]
    if (row === undefined) return
    // 内嵌浏览器面板会把 smooth 整个吞掉（不是不平滑，是根本不滚）
    rowRefs.current.get(row.deployment.id)?.scrollIntoView({ block: 'nearest', behavior: 'auto' })
  }, [cursor, rows])

  if (!open) return null

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.nativeEvent.isComposing) return
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      setCursor((cur) => moveHighlight(cur, e.key === 'ArrowDown' ? 1 : -1, rows.length))
      return
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      const row = rows[cursor] ?? rows[0]
      if (row !== undefined) {
        onPick(row.deployment)
        onClose()
      }
    }
  }

  const total = allGroups.reduce((n, g) => n + g.rows.length, 0)

  return (
    <Dialog open={open} onOpenChange={(value) => { if (!value) onClose() }}>
    <DialogContent className="mpk-card" overlayClassName="mpk-overlay" portalContainer={fullscreen}
      aria-describedby={undefined} onEscapeKeyDown={(event) => event.stopPropagation()}>
      <div className="mpk-head">
        <DialogTitle className="mpk-title">
          {usage === undefined ? '选择模型' : `${usage} · 选择模型`}
        </DialogTitle>
        <span className="mpk-count">{total} 个可用</span>
      </div>

      <div className="mpk-search">
        <IconSearch />
        <input
          className="mpk-input"
          autoFocus
          value={query}
          placeholder="搜模型名、厂商或账号"
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
        />
      </div>

      <div className="mpk-list" ref={listRef} role="listbox" aria-label="可选模型">
        {groups.length === 0 && (
          <div className="mpk-empty">
            {total === 0 ? '这个用途还没有可用的模型部署' : `没有匹配「${query.trim()}」的模型`}
          </div>
        )}
        {groups.map((group: VendorGroup) => (
          <div key={group.vendor.key} className="mpk-group">
            <div className="mpk-group-head">
              <span className="mpk-group-name">{group.vendor.name}</span>
              <span className="mpk-group-n">{group.rows.length}</span>
            </div>
            {group.rows.map((row) => (
              <Row
                key={row.deployment.id}
                row={row}
                selected={row.deployment.id === value}
                highlighted={rows[cursor]?.deployment.id === row.deployment.id}
                onPick={() => {
                  onPick(row.deployment)
                  onClose()
                }}
                refFor={(el) => {
                  if (el === null) rowRefs.current.delete(row.deployment.id)
                  else rowRefs.current.set(row.deployment.id, el)
                }}
              />
            ))}
          </div>
        ))}
        {!showNoise && query.trim() === '' && noiseCount > 0 && (
          <button type="button" className="mpk-more" onClick={() => setShowNoise(true)}>
            另有 {noiseCount} 个非对话模型（嵌入、转写）
          </button>
        )}
      </div>

      {followDefault !== undefined && (
        <div className="mpk-foot">
          <button
            type="button"
            className={`mpk-follow${followDefault.active ? ' is-on' : ''}`}
            onClick={() => {
              followDefault.onFollow()
              onClose()
            }}
          >
            {followDefault.active && <IconCheck />}
            跟随全局默认
            <span className="mpk-follow-model">
              {followDefault.modelName ?? '还没设默认模型'}
            </span>
          </button>
        </div>
      )}
    </DialogContent>
    </Dialog>
  )
}
