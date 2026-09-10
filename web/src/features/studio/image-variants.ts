/* 画布图片的变体选择与显示比例（模块 17 · FR-468 / D1）。
 *
   抽成独立模块只有一个理由：让测试能直接测，不用拉起整棵渲染依赖
   （本仓 vitest 跑在 node、没有 jsdom；`image-math.ts` 是同一个先例）。

   比例那一段的蓝本对照：Infinite-Canvas `static/js/smart-canvas.js`
   的 `singleImageLayout`（:1673，单图按自然尺寸等比装框）与
   `smartGroupThumbLayout`（:1498，多图按张数选列数）。 */

import type { CanvasItem } from '../../lib/api-studio'

/** 服务端派生变体的目标宽度（`domain/image_assets.DISPLAY_WIDTH` / `THUMB_WIDTH`）。
 *
 *  `display` 只有 768——这就是"画布上的图糊"的全部原因：Retina 屏上一个 637px
 *  宽的节点需要 1274 物理像素。 */
const THUMB_W = 192
const DISPLAY_W = 768

/** 让浏览器按 DPR 与真实渲染宽度自己挑变体。
 *
 *  钉死 `display` 时，Retina 屏上一个 637px 宽的节点需要 1274 物理像素，
 *  而 display 只有 768 —— 放大 1.66 倍，肉眼就是糊；把画布放大看得更糊。
 *  蓝本读的是本地原图，所以它任何缩放下都清楚。
 *
 *  用 `srcset` 而不是自己按 `scale × dpr` 算变体：这是浏览器原生能力，
 *  它会考虑 DPR、只下载选中的那一档、并且**放大后不会降级**回小图。
 *  自己算的话每次缩放都要重挑 src，来回切换等于反复重新请求。
 *
 *  `full` 只在原图确实比 display 大时才列——小图列上去只会让浏览器
 *  下一张和 display 一样大的原图（还是未压缩的 PNG）。 */
export function itemSrcSet(it: CanvasItem): string | undefined {
  if (it.asset_id === undefined) return undefined // 外部图没有变体
  const base = `/api/images/assets/${it.asset_id}`
  const full = it.w

  /* 描述符必须是那个 URL **真正**返回的宽度，不是我们希望它多宽。
     服务端的 `_resize_webp` 在原图本来就更窄时不放大、直接回原图
     （`variant_key` 回落）。所以一张 420 宽的图，`/display` 拿到的是 420，
     标成 768w 的话浏览器会以为它够用来铺 700px 的位置——还是糊，
     而且这种糊比原来更难查：srcset 明明"生效"了。 */
  const shown = (target: number): number => (full === undefined ? target : Math.min(target, full))

  const parts = [`${base}/thumb ${shown(THUMB_W)}w`]
  const displayW = shown(DISPLAY_W)
  parts.push(`${base}/display ${displayW}w`)
  /* full 只在它确实比 display 大时才列。原图 ≤768 时两条 URL 返回的是同一张图，
     列上去只会让浏览器在同宽的两档里挑，可能拉那张未压缩的 PNG。 */
  if (full !== undefined && full > displayW) parts.push(`${base}/full ${full}w`)
  return parts.join(', ')
}

/** `sizes`：这张图在**布局 CSS 像素**里有多宽。
 *
 *  必须把画布缩放乘进去。`transform: scale()` 不改变布局尺寸，浏览器算 srcset
 *  时看不见它——不乘的话画布放大到 2× 时浏览器仍按原尺寸挑图，越放大越糊，
 *  而这正是用户最想看清楚的时候。 */
export function itemSizes(cssWidth: number, scale: number): string {
  return `${Math.max(1, Math.round(cssWidth * Math.max(1, scale)))}px`
}

/* ==================== 显示比例（D1） ==================== */

/** 还不知道比例时先摆成方的。
 *
 *  1 是唯一不偏心的猜法——猜横的正是「竖版图塞进偏方的框里」的成因，
 *  与 `canvasStore.pendingAspect` 最后那档同一条判据。 */
export const UNKNOWN_ASPECT = 1

/** 两张图的比例差到多少才算「不是同一个画幅」。
 *  1024×1536 与 1000×1500 是同一个画幅，不该因为舍入被判成混排。 */
const ASPECT_TOLERANCE = 0.02

/** 有效比例（宽/高）。非有限值、零、负数一律当作「不知道」 */
function ratioOf(w?: number, h?: number): number | undefined {
  if (w === undefined || h === undefined) return undefined
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return undefined
  return w / h
}

/** 量到的长宽比。**只存比例、不存像素尺寸**，也不入库（BR-143）。
 *
 *  两个理由，第一个是正确性：画布上挂的 `<img>` 带 srcset，而
 *  `naturalWidth` 在 srcset 场景下返回的是**密度校正后的 CSS 尺寸**
 *  （768w 的图铺在 420px 的位置上读到 420，仓里记过这条）。当成原图宽度
 *  写回 `item.w` 会当场毒到 `itemSrcSet`——它拿 `it.w` 当 `full` 档的宽度
 *  描述符，标成 420 之后浏览器再也不会去取原图，画布反而更糊。
 *  长宽两边被同一个系数缩放，所以**比例是这里唯一量得准的东西**。
 *
 *  第二个理由是 BR-143：写回文档意味着打开一张旧画布、图一加载完就产生
 *  一次脏改动与自动保存——用户什么都没做，画布的 updated_at 就变了。
 *
 *  代价只是每个会话每张图多量一次，缓存在模块里跨节点共享。 */
const measured = new Map<string, number>()

/** 缓存键。入库图按资产号，外部图按 URL——同一张图在多个节点里只量一次 */
function aspectKey(it: CanvasItem): string | undefined {
  if (it.asset_id !== undefined) return `a${it.asset_id}`
  const url = it.url ?? ''
  return url === '' ? undefined : `u${url}`
}

/** 这张图该按什么比例摆。文档里的 w/h 优先，其次是 `onLoad` 量到的。
 *
 *  两个都没有就返回 `undefined` 而**不是 1**：调用方要能分清「它是方的」
 *  和「还不知道」——前者可以定型，后者只是暂时占个位。 */
export function itemAspect(it: CanvasItem): number | undefined {
  const own = ratioOf(it.w, it.h)
  if (own !== undefined) return own
  const key = aspectKey(it)
  return key === undefined ? undefined : measured.get(key)
}

/** 记下 `<img>` 量到的比例。返回 true = 这是新信息，调用方该重渲染一次让节点定型。
 *
 *  文档里已经有 w/h 的不覆盖：那是原图的真实像素，比 srcset 校正过的量值可信。 */
export function rememberAspect(it: CanvasItem, naturalW: number, naturalH: number): boolean {
  if (ratioOf(it.w, it.h) !== undefined) return false
  const key = aspectKey(it)
  const ratio = ratioOf(naturalW, naturalH)
  if (key === undefined || ratio === undefined) return false
  /* 已经量到过就按容差判「是不是同一个画幅」，不做精确比较：缩远缩近会在
     thumb 与 display 之间换 src、各自量到的比例只差舍入的那一点点，
     精确比较的话每越过一次远近阈值都要白重渲染一遍。 */
  const known = measured.get(key)
  if (known !== undefined && Math.abs(ratio - known) / known <= ASPECT_TOLERANCE) return false
  measured.set(key, ratio)
  return true
}

/** 清掉量到的比例。只给测试用——用例之间不清的话缓存会互相串。 */
export function clearMeasuredAspects(): void {
  measured.clear()
}

/** 写进 CSS `aspect-ratio` 的值。不知道比例时先摆成方的。 */
export function aspectStyle(ratio: number | undefined): string {
  return String(ratio ?? UNKNOWN_ASPECT)
}

/** 多图网格摆几列。
 *
 *  **必须与 `canvasStore.mediaGridBox` 同一个判据**（蓝本 `smartGroupThumbLayout`
 *  的 `min(4, max(2, ceil(√n)))`）：节点宽度是按那边的列数算出来的，两边不一致
 *  时格子要么被挤扁、要么右边空出一条。所以入参是**总张数**而不是实际摆出来的
 *  格子数（超过 8 张会折叠成 +N，但宽度预算仍是按总张数给的）。 */
export function gridColumns(count: number): number {
  if (count <= 1) return 1
  return Math.min(4, Math.max(2, Math.ceil(Math.sqrt(count))))
}

/** 多图网格里每一格摆成什么比例。
 *
 *  同一次出图的几张比例一致，就让格子跟着那个比例——竖图摆成竖格，
 *  不再被压成方块。用户手攒的一堆图比例各异时回落成方格，由
 *  `object-fit: contain` 保证每一张仍然完整可见（只是留白多一点）。
 *  全都取不到尺寸时也回落方格，等 `onLoad` 量到再定型。 */
export function gridCellAspect(items: CanvasItem[]): number {
  let shared: number | undefined
  for (const it of items) {
    const ratio = itemAspect(it)
    if (ratio === undefined) continue
    if (shared === undefined) {
      shared = ratio
      continue
    }
    if (Math.abs(ratio - shared) / shared > ASPECT_TOLERANCE) return UNKNOWN_ASPECT
  }
  return shared ?? UNKNOWN_ASPECT
}
