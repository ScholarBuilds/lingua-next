/* 实时运行浮层（需求 12 FR-245）：有任务在跑时全局常驻，任何页面都看得到进度。

   侧栏布局下它已经收进「任务」导航项下面的面板（RailRunning，CR-006 D4），
   这个浮层只在顶部布局里渲染——那时没有侧栏可收。空闲时整个组件不渲染。 */

import { useState } from 'react'
import { useNavigate } from 'react-router-dom'

import { IconChevronDown, IconClose } from '../../components/icons'
import { useRunningRows } from './runningRows'
import './pipeline.css'

export function RunningDock() {
  const rows = useRunningRows()
  const navigate = useNavigate()
  const [open, setOpen] = useState(true)
  const [hidden, setHidden] = useState(false)

  if (rows.length === 0 || hidden) return null

  return (
    <div className={`rd${open ? ' open' : ''}`}>
      <div className="rd-head">
        <span className="rd-pulse" />
        <b>{rows.length} 个任务执行中</b>
        <div style={{ flex: 1 }} />
        <button className="rd-btn" onClick={() => setOpen((v) => !v)} title={open ? '收起' : '展开'}>
          <IconChevronDown style={{ transform: open ? 'none' : 'rotate(180deg)' }} />
        </button>
        <button className="rd-btn" onClick={() => setHidden(true)} title="本次不再提示">
          <IconClose />
        </button>
      </div>
      {open && (
        <div className="rd-list">
          {rows.slice(0, 4).map((row) => (
            <button key={row.key} className="rd-item" onClick={() => navigate(row.route)}>
              <span className="rd-title">{row.title}</span>
              <span className="rd-step">{row.step}</span>
              <span className="rd-bar">
                <i style={{ width: `${Math.max(3, row.progress)}%` }} />
              </span>
              <span className="rd-pct">{Math.round(row.progress)}%</span>
            </button>
          ))}
          {rows.length > 4 && (
            <button className="rd-item rd-overflow" onClick={() => navigate('/tasks')}>
              <span className="rd-title">还有 {rows.length - 4} 个…</span>
              <span className="rd-step">任务中心</span>
            </button>
          )}
        </div>
      )}
    </div>
  )
}
