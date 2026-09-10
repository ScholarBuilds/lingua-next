/* 图片编辑器用到的纯计算。
 *
   单独成模块而不是留在 CanvasEditor.tsx 里：那个文件 import 了 MaskCanvas → konva，
   而 konva 在 node 环境要 canvas 原生模块，vitest 里一 import 就炸。
   纯函数放这里，测试直接测，不拖进任何渲染依赖。 */

/** 超过这个像素量就该提醒一句。4K 标准 3840×2160 ≈ 830 万像素 */
export const FOUR_K_PIXELS = 3840 * 2160

/** 常见画幅。顺序无关，取最接近的那个 */
const KNOWN: Array<[string, number]> = [
  ['1:1', 1],
  ['4:3', 4 / 3],
  ['3:4', 3 / 4],
  ['3:2', 3 / 2],
  ['2:3', 2 / 3],
  ['16:9', 16 / 9],
  ['9:16', 9 / 16],
  ['21:9', 21 / 9],
]

/** 把宽高约成最接近的常见比例名。
 *
 *  给扩图侧栏「出图也按这个尺寸（16:9）」那一行用——光看 1536×864
 *  用户未必立刻反应过来那是 16:9。
 *  差得太远就不硬套名字，直接报小数比：把 6:1 说成「21:9」比不说更糟。 */
export function ratioLabel(w: number, h: number): string {
  const r = w / Math.max(1, h)
  let best = KNOWN[0]
  for (const k of KNOWN) if (Math.abs(k[1] - r) < Math.abs(best[1] - r)) best = k
  return Math.abs(best[1] - r) / r < 0.04 ? best[0] : `${(Math.round(r * 100) / 100).toFixed(2)}:1`
}

/* ==================== 宫格切分 ==================== */

/** 切分出来的一格，全部是**原图像素坐标** */
export interface SplitRect {
  x: number
  y: number
  w: number
  h: number
  row: number
  col: number
}

/** 切割线的位置，取值 0~1（相对整边）。不含 0 与 1 那两条外边 */
export type Cuts = { xs: number[]; ys: number[] }

/** 等分若干刀。`n=2` 给一条中线 `[0.5]` */
export function evenCuts(n: number): number[] {
  const k = Math.max(1, Math.round(n))
  return Array.from({ length: k - 1 }, (_, i) => (i + 1) / k)
}

/** 把 0~1 的切割线归一化：夹进 (0,1)、排序、去掉挨太近的重复刀。
 *
 *  `minGap` 用相对值而不是像素：同一张图缩放显示时，用户拖出来的两条线
 *  在屏幕上看着分得开、换算回原图可能只差一两个像素，切出来是一条黑边。 */
export function normalizeCuts(values: number[], minGap = 0.01): number[] {
  const sorted = values
    .filter((v) => Number.isFinite(v) && v > 0 && v < 1)
    .sort((a, b) => a - b)
  const out: number[] = []
  for (const v of sorted) {
    if (out.length > 0 && v - out[out.length - 1] < minGap) continue
    out.push(v)
  }
  return out
}

/** 按切割线把 `w×h` 切成若干格。
 *
 *  `gap` 是**切割线两侧各扣一半**（蓝本同款）：一条线上扣 gap/2、下扣 gap/2，
 *  于是相邻两格之间正好空出 gap 个像素。在外边不扣——外边没有邻居。
 *
 *  为什么不是「每格各缩 gap」：那样最外圈也会缩，整张图的四周凭空少一圈，
 *  而用户想要的是「格与格之间留缝」。
 *
 *  gap 大到把某一格挤没时，那一格**跳过**而不是给出负宽——
 *  负宽的 `drawImage` 不报错，只画出一张空白图。 */
export function splitRects(
  w: number,
  h: number,
  cuts: Cuts,
  gap = 0,
): SplitRect[] {
  const g = Math.max(0, Math.round(gap))
  const half = g / 2
  const xs = [0, ...normalizeCuts(cuts.xs).map((v) => v * w), w]
  const ys = [0, ...normalizeCuts(cuts.ys).map((v) => v * h), h]

  const out: SplitRect[] = []
  for (let r = 0; r + 1 < ys.length; r += 1) {
    for (let c = 0; c + 1 < xs.length; c += 1) {
      // 内侧的边各让半个 gap；最外圈那两条边不让
      const x0 = Math.round(xs[c] + (c === 0 ? 0 : half))
      const x1 = Math.round(xs[c + 1] - (c + 2 === xs.length ? 0 : half))
      const y0 = Math.round(ys[r] + (r === 0 ? 0 : half))
      const y1 = Math.round(ys[r + 1] - (r + 2 === ys.length ? 0 : half))
      const cw = x1 - x0
      const ch = y1 - y0
      if (cw < 1 || ch < 1) continue
      out.push({ x: x0, y: y0, w: cw, h: ch, row: r + 1, col: c + 1 })
    }
  }
  return out
}

/** 这套切割线会切出几张。给「切成 N 张」按钮上的数字用 */
export function splitCount(cuts: Cuts): number {
  return (normalizeCuts(cuts.xs).length + 1) * (normalizeCuts(cuts.ys).length + 1)
}

/** 该在哪儿加下一条切割线：**当前最大那段空隙的中点**。
 *
 *  固定加在 0.5 是不行的——默认就有一条 0.5，再加一条会被去重直接丢掉，
 *  用户点了「加一条线」毫无反应（实测就是）。
 *  从最大空隙下手，还顺带保证了连点几次会均匀铺开。 */
export function nextCut(values: number[]): number {
  const cuts = normalizeCuts(values)
  const edges = [0, ...cuts, 1]
  let best = 0.5
  let widest = -1
  for (let i = 0; i + 1 < edges.length; i += 1) {
    const span = edges[i + 1] - edges[i]
    if (span > widest) {
      widest = span
      best = edges[i] + span / 2
    }
  }
  return best
}
