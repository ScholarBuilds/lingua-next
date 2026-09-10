/* 侧栏「任务」项下面的在跑面板（CR-006 D4）：RunningDock 收进侧栏后的形态。

   同一件事原来在三处各说一遍（任务页、管线页、右下角浮层）。现在侧栏只留
   一个「任务」入口，正在跑的几条贴在它下面，点行直接去来源现场；
   超过三条只说「还有几个」，细看去任务中心。空闲时不渲染。 */

import { useNavigate } from 'react-router-dom'

import { useRunningRows } from './runningRows'

const MAX_ROWS = 3

export function RailRunning() {
  const rows = useRunningRows()
  const navigate = useNavigate()
  if (rows.length === 0) return null

  return (
    <div className="rail-run" aria-label="执行中的任务">
      {rows.slice(0, MAX_ROWS).map((row) => (
        <button
          key={row.key}
          className="rail-run-item"
          onClick={() => navigate(row.route)}
          title={`${row.title} · ${row.step}`}
        >
          <span className="rail-run-title">{row.title}</span>
          <span className="rail-run-step">{Math.round(row.progress)}%</span>
          <span className="rail-run-bar">
            <i style={{ width: `${Math.max(3, row.progress)}%` }} />
          </span>
        </button>
      ))}
      {rows.length > MAX_ROWS && (
        <button className="rail-run-more" onClick={() => navigate('/tasks')}>
          还有 {rows.length - MAX_ROWS} 个 · 任务中心
        </button>
      )}
    </div>
  )
}
