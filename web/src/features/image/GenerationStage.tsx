/* 出图舞台（模块 16 FR-433 / BR-110）。类名前缀 gnst-，独占。

   BR-110 只展示后端能证明的东西，所以这里没有百分比、没有匀速前进的条。手上的真数据
   只有两样：管线节点状态（各节点 pending/running/done/failed 与耗时）、上游透传流式时
   推来的中间图。两样都没有时只做「活着」的反馈——骨架呼吸 + 扫光 + 已跑秒数。

   骨架按真实出图比例画：方块骨架配一张宽幅成品，用户看到的过渡是错的。 */

import type { CSSProperties } from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'

import './GenerationStage.css'

export interface GenPhase {
  key: string
  label: string
  state: 'pending' | 'running' | 'done' | 'failed'
  /** 该节点耗时，有才显示 */
  ms?: number
}

/** 骨架块的垂直预算（vh）。容器高度拿不到，按视口反推格子宽度，
    避免 flex 列里 `width:100% + aspect-ratio` 被压扁 */
const BUDGET_VH = 54
const GAP = 12
/** 一次最多画几个骨架格，多了没意义还挤 */
const MAX_CELLS = 12
/** 慢过这个数就补一句预期，免得用户以为卡死 */
const SLOW_MS = 60_000

/** 张数 → 列数。3 张排一行比 2+1 齐整 */
const COLS: Record<number, number> = { 1: 1, 2: 2, 3: 3, 4: 2, 5: 3, 6: 3 }

function gridCols(n: number): number {
  return COLS[n] ?? Math.min(4, Math.ceil(Math.sqrt(n)))
}

/** 已跑时长。不足一分钟给一位小数，跨分钟改成 分/秒 */
function formatElapsed(ms: number): string {
  const safe = Number.isFinite(ms) && ms > 0 ? ms : 0
  if (safe < 60_000) return `${(safe / 1000).toFixed(1)} 秒`
  const total = Math.floor(safe / 1000)
  return `${Math.floor(total / 60)} 分 ${String(total % 60).padStart(2, '0')} 秒`
}

/** 节点耗时，跟着后端给的毫秒走 */
function formatPhaseMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  const total = Math.floor(ms / 1000)
  return `${Math.floor(total / 60)}m${String(total % 60).padStart(2, '0')}s`
}

function IconCheck() {
  return (
    <svg viewBox="0 0 12 12" aria-hidden="true">
      <path
        d="M2.6 6.2 4.9 8.5 9.4 3.7"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.9"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function IconPicture() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <rect x="3" y="4.5" width="18" height="15" rx="2.6" fill="none" stroke="currentColor" strokeWidth="1.3" />
      <circle cx="8.6" cy="10" r="1.5" fill="none" stroke="currentColor" strokeWidth="1.3" />
      <path
        d="M4.2 16.8 8.9 12.4l3.4 3.2 2.9-2.4 4.6 4"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function IconFail() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="1.6" />
      <path
        d="M12 7.4v5.4M12 16.2v.6"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </svg>
  )
}

/** 步骤条。phases 为空整条不渲染——没有节点信息就不要造五个假节点出来 */
function StepRail({ phases }: { phases: GenPhase[] }) {
  if (phases.length === 0) return null
  return (
    <ol className="gnst-steps">
      {phases.map((p, i) => (
        <li key={p.key} className={`gnst-step is-${p.state}`}>
          <span className="gnst-dot">
            {p.state === 'done' ? <IconCheck /> : p.state === 'failed' ? <b>!</b> : null}
          </span>
          <span className="gnst-step-label">{p.label}</span>
          {typeof p.ms === 'number' && p.ms >= 0 && (
            <span className="gnst-step-ms">{formatPhaseMs(p.ms)}</span>
          )}
          {i < phases.length - 1 && <i className="gnst-link" aria-hidden="true" />}
        </li>
      ))}
    </ol>
  )
}

export function GenerationStage(props: {
  /** 真实管线节点；空数组表示拿不到节点信息 */
  phases: GenPhase[]
  /** 已跑毫秒，由外部计时 */
  elapsedMs: number
  /** 流式中间图，没有就 null */
  partial: { index: number; b64: string } | null
  /** 本次出几张，决定骨架格子数 */
  count: number
  /** 宽/高 */
  ratio: number
  error: string | null
}): JSX.Element {
  const { phases, elapsedMs, partial, count, ratio, error } = props

  const aspect = Number.isFinite(ratio) && ratio > 0 ? ratio : 1
  const cells = Math.max(1, Math.min(Math.floor(count) || 1, MAX_CELLS))
  const cols = gridCols(cells)
  const rows = Math.ceil(cells / cols)

  // 中间图交叉淡入：新图叠在旧图上淡进来，动画跑完再把旧的摘掉。
  // 直接换 src 是硬切，画面会闪一下黑底
  const [layers, setLayers] = useState<{ id: number; src: string }[]>([])
  const seq = useRef(0)
  useEffect(() => {
    if (partial === null) {
      setLayers([])
      return
    }
    seq.current += 1
    const id = seq.current
    const src = `data:image/png;base64,${partial.b64}`
    setLayers((prev) => [...prev.slice(-1), { id, src }])
    const timer = window.setTimeout(() => {
      setLayers((prev) => prev.filter((l) => l.id === id))
    }, 420)
    return () => window.clearTimeout(timer)
  }, [partial])

  const cellsStyle = useMemo(
    () =>
      ({
        gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
        // 格子宽度由可用高度反推，保证 rows 行都塞得进视口
        maxWidth: `calc((${BUDGET_VH}vh - ${(rows - 1) * GAP}px) / ${rows} * ${aspect} * ${cols} + ${(cols - 1) * GAP}px)`,
        '--gnst-ratio': `${aspect}`,
      }) as CSSProperties,
    [cols, rows, aspect],
  )
  const heroStyle = useMemo(
    () =>
      ({
        maxWidth: `calc(${BUDGET_VH}vh * ${aspect})`,
        '--gnst-ratio': `${aspect}`,
      }) as CSSProperties,
    [aspect],
  )

  const elapsedText = formatElapsed(elapsedMs)

  if (error !== null && error !== '') {
    return (
      <div className="gnst gnst-is-failed" role="alert">
        <div className="gnst-fail">
          <span className="gnst-fail-mark">
            <IconFail />
          </span>
          <b className="gnst-fail-title">出图失败</b>
          <p className="gnst-fail-msg">{error}</p>
          <StepRail phases={phases} />
          <p className="gnst-fail-time">已跑 {elapsedText}</p>
        </div>
      </div>
    )
  }

  const runningPhase = phases.find((p) => p.state === 'running')
  const headline = runningPhase
    ? `正在${runningPhase.label}`
    : phases.length > 0 && phases.every((p) => p.state === 'pending')
      ? '排队中'
      : '正在出图'

  return (
    <div className="gnst">
      <header className="gnst-head">
        <span className="gnst-pulse" aria-hidden="true">
          <i />
          <i />
        </span>
        <b className="gnst-title" role="status">
          {headline}
        </b>
        <span className="gnst-time">
          <span className="gnst-time-k">已跑</span>
          {elapsedText}
        </span>
      </header>

      {elapsedMs > SLOW_MS && <p className="gnst-slow">比平时久，通常十几秒到一分钟。</p>}

      <StepRail phases={phases} />

      {layers.length > 0 && partial !== null ? (
        <figure className="gnst-hero" style={heroStyle}>
          {layers.map((l) => (
            <img key={l.id} className="gnst-layer" src={l.src} alt="" />
          ))}
          <figcaption className="gnst-tag">
            <i className="gnst-tag-dot" aria-hidden="true" />
            上游推来的第 {partial.index + 1} 张中间图，还在画
          </figcaption>
        </figure>
      ) : (
        <div className="gnst-cells" style={cellsStyle} aria-hidden="true">
          {Array.from({ length: cells }, (_, i) => (
            <div key={i} className="gnst-cell" style={{ '--gnst-i': `${i}` } as CSSProperties}>
              <span className="gnst-cell-mark">
                <IconPicture />
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
