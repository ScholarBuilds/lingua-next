/* 画布内核 · 对齐参考线的渲染（模块 17 · CR-005 §3.1）
 *
   挂在 `.cvc-world` 里，坐标即世界坐标（world 层已经做过 transform）。

   描边走 `vector-effect="non-scaling-stroke"`：参考线是**量具**，
   在 0.2 倍和 3 倍下都该是同样细的一根。跟着 transform 缩放的话，
   放大时糊成一条粗带子，缩小时细到看不见——两头都失去参照价值。

   `.cvc-links` 那层没这么做是有意的：连线是画布内容，粗细跟着内容缩才对。 */

import type { SnapGuide } from './snapping'

import './canvas-core.css'

export function AlignGuides({ guides }: { guides: readonly SnapGuide[] }): JSX.Element | null {
  if (guides.length === 0) return null
  return (
    <svg className="cvc-guides" aria-hidden="true" xmlns="http://www.w3.org/2000/svg">
      {guides.map((g) => {
        const x1 = g.axis === 'x' ? g.at : g.start
        const x2 = g.axis === 'x' ? g.at : g.end
        const y1 = g.axis === 'x' ? g.start : g.at
        const y2 = g.axis === 'x' ? g.end : g.at
        return (
          <line
            key={`${g.axis}:${g.at}`}
            className="cvc-guide"
            x1={x1}
            y1={y1}
            x2={x2}
            y2={y2}
            vectorEffect="non-scaling-stroke"
          />
        )
      })}
    </svg>
  )
}
