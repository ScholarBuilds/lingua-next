/* 画布内核 · 连线层（模块 17 · CR-005 §3.1 / 需求 §6.6）
 *
   移植自 Infinite-Canvas `static/js/smart-canvas.js` 连线渲染段（约 6394~6436 行）。

   每条连线画四个元素，缺一个手感就塌一块：

   | 元素          | 作用                                                    |
   | ------------- | ------------------------------------------------------- |
   | `.cvc-line`   | 主路径，级联时走流动动效                                |
   | `.cvc-hit`    | stroke-width:14 的透明路径——**这是「线好点中」的全部原因** |
   | `.cvc-end`    | 终点圆点，让人看出方向                                  |
   | `.cvc-cut`    | 中点删除按钮，悬停才显形                                |

   SVG 尺寸这里和蓝本不一样：蓝本钉死 6000×4000 的 viewBox，节点拖出这个范围
   连线就没了。这里用 `100% + overflow:visible`（尺寸在 canvas-core.css 里），
   坐标直接用世界坐标，画多远都在。

   **不能给 `width="0"`**：零尺寸的根 SVG 在 Chrome 里完全不绘制，
   即使 overflow:visible、即使 getBoundingClientRect 量得到几何——
   实测线在 DOM 里、颜色对、opacity 1，屏幕上就是没有。 */

import { memo, useMemo } from 'react'

import { connectionMidpoint, connectionPath } from './geometry'
import type { ConnectionKind, Rect } from './geometry'
import { selectModeOf } from './selection'
import type { SelectMode } from './selection'

/** 一条**画出来的**连线。注意 `indices` 是数组：同一来源连到同一分组的多个成员
 *  会合并成一条线（蓝本 `smart-canvas.js:6374`），这条线背后压着好几条真实的边。
 *  命中判定靠这串下标回指原数据（`data-conn-index` 写成逗号分隔，
 *  `useCanvasInput` 的默认命中函数按逗号拆），切线和断开都是**整桶**处理——
 *  合并线上只断掉其中一条，剩下的线还在，用户会以为没删掉。 */
export interface RenderedConnection {
  indices: number[]
  from: string
  to: string
  kind: ConnectionKind
  /** 由多条边合并而来（终点画在分组本体上） */
  merged?: boolean
  /** 有 loop 正悬在这条线的中点上，松手就插进来——先给预览态 */
  inserting?: boolean
  /** 下游节点排队中：线走「等待」样式 */
  pending?: boolean
  /** 级联执行态：这一段正在跑 / 跑完了 / 还没轮到 */
  cascade?: 'active' | 'wait' | 'done'
  /** 两端任一被选中 */
  selected?: boolean
  /** 切线擦除已划中，松手就删——先给个预览态，让人知道松手会删掉哪几条 */
  erasing?: boolean
}

export interface ConnectionLayerProps {
  connections: RenderedConnection[]
  /** 节点 id → 世界坐标矩形。拿不到矩形的连线直接跳过，不画半截线 */
  rects: Map<string, Rect>
  /** 关掉流动动效（用户偏好或系统 prefers-reduced-motion） */
  reduceMotion?: boolean
  /** 点中点的删除按钮。给的是整桶下标，合并线一次断干净 */
  onCut?: (indices: number[]) => void
  /** 点中线本身：选中它。选中之后 Delete 才有得删——`selectedEdgeIds` 这条路
   *  在store 里一直建着，却从来没有入口把边选上，等于删除边只能靠中点那个小叉。 */
  onSelect?: (indices: number[], mode: SelectMode) => void
  /** 右键连线。给的是 client 坐标——菜单浮层按 client 定位 */
  onContextMenu?: (indices: number[], screen: { x: number; y: number }) => void
}

function classesFor(conn: RenderedConnection): string {
  const cls = ['cvc-line', `cvc-kind-${conn.kind}`]
  if (conn.pending) cls.push('cvc-pending')
  if (conn.cascade) cls.push('cvc-cascade', `cvc-cascade-${conn.cascade}`)
  if (conn.selected) cls.push('cvc-selected')
  if (conn.erasing) cls.push('cvc-erasing')
  if (conn.merged === true) cls.push('cvc-merged')
  if (conn.inserting === true) cls.push('cvc-inserting')
  return cls.join(' ')
}

function ConnectionLayerInner({ connections, rects, reduceMotion, onCut, onSelect, onContextMenu }: ConnectionLayerProps): JSX.Element {
  const drawn = useMemo(
    () =>
      connections
        .map((conn) => {
          const from = rects.get(conn.from)
          const to = rects.get(conn.to)
          if (!from || !to || conn.indices.length === 0) return null
          return {
            conn,
            /* 一条线一个 key/一份命中属性：逗号分隔的下标串同时当 React key 用，
               合并关系变了（有成员进出分组）key 自然就变，不会复用错的 DOM */
            tag: conn.indices.join(','),
            d: connectionPath(from, to, conn.kind),
            mid: connectionMidpoint(from, to, conn.kind),
            end: conn.kind === 'history' ? { x: to.x + to.width / 2, y: to.y } : { x: to.x, y: to.y + to.height / 2 },
          }
        })
        .filter((v): v is NonNullable<typeof v> => v !== null),
    [connections, rects],
  )

  return (
    <svg
      className={reduceMotion ? 'cvc-links cvc-links-still' : 'cvc-links'}
      xmlns="http://www.w3.org/2000/svg"
    >
      {drawn.map(({ conn, tag, d, mid, end }) => (
        <g
          key={tag}
          className={conn.selected === true ? 'cvc-conn cvc-conn-on' : 'cvc-conn'}
          data-conn-index={tag}
          onClick={
            onSelect === undefined
              ? undefined
              : (e) => {
                  e.stopPropagation()
                  onSelect(conn.indices, selectModeOf(e))
                }
          }
          onContextMenu={
            onContextMenu === undefined
              ? undefined
              : (e) => {
                  e.preventDefault()
                  e.stopPropagation()
                  onContextMenu(conn.indices, { x: e.clientX, y: e.clientY })
                }
          }
        >
          {/* 插入预览的虚线走内联属性而不是纯 CSS：这个态只在拖动的那几百毫秒里存在，
              样式表没跟上时预览会整个消失，而预览消失等于这个手势没有反馈 */}
          <path
            className={classesFor(conn)}
            d={d}
            fill="none"
            strokeDasharray={conn.inserting === true ? '10 6' : undefined}
          />
          {/* 命中区：宽 14 的透明描边。鼠标点线、切线擦除都靠它，视觉上不可见 */}
          <path className="cvc-hit" d={d} fill="none" data-conn-index={tag} />
          <circle className="cvc-end" cx={end.x} cy={end.y} r={3.5} data-conn-index={tag} />
          <g
            className="cvc-cut"
            transform={`translate(${mid.x} ${mid.y})`}
            data-conn-index={tag}
            onClick={(e) => {
              e.stopPropagation()
              onCut?.(conn.indices)
            }}
          >
            <title>{conn.merged === true ? `断开这 ${conn.indices.length} 条连线` : '断开这条连线'}</title>
            <circle r={8} />
            <path d="M-3 -3 L3 3 M3 -3 L-3 3" strokeLinecap="round" />
          </g>
        </g>
      ))}
    </svg>
  )
}

export const ConnectionLayer = memo(ConnectionLayerInner)

/** 拖拽中的临时连线：从起点跟着鼠标走，还没落到目标节点上。
 *
 *  单独一个组件是因为它每帧都变，和已落地的连线放一起会让整层跟着重画。 */
export function DraftConnection({ from, to, kind = 'flow' }: { from: Rect; to: Rect; kind?: ConnectionKind }): JSX.Element {
  const d = connectionPath(from, to, kind)
  return (
    <svg className="cvc-links cvc-links-draft" aria-hidden="true" xmlns="http://www.w3.org/2000/svg">
      <path className="cvc-line cvc-draft" d={d} fill="none" />
    </svg>
  )
}

/** 切线擦除的轨迹。跟着指针画一条会淡出的线，让人看见自己划到哪了。
 *
 *  坐标是**屏幕坐标**（不在 world 层里），所以不随缩放变粗变细。 */
export function EraseTrail({ points }: { points: { x: number; y: number }[] }): JSX.Element | null {
  if (points.length < 2) return null
  const d = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x} ${p.y}`).join(' ')
  return (
    <svg className="cvc-erase-trail" aria-hidden="true" xmlns="http://www.w3.org/2000/svg">
      <path className="cvc-erase-glow" d={d} fill="none" />
      <path className="cvc-erase-line" d={d} fill="none" />
    </svg>
  )
}
