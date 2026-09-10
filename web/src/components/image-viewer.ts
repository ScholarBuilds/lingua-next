/* 看大图的纯逻辑：缩放钳制、平移边界、翻页。

   与渲染分开是因为这几件事**错了都不报错，只是手感不对**：缩放越界后图跑没了、
   平移不设边界能把图拖出视野再也找不回来、翻页越界回到第一张让人以为点错了。
   这类问题在页面上很难自证，写成纯函数才盯得住。 */

/** 缩放档位。1 = 适应窗口（fit），不是原始像素 1:1 */
export const MIN_SCALE = 1
export const MAX_SCALE = 8
/** 滚轮一格的缩放系数。1.15 是试出来的：再大一格就跳过了想停的位置 */
export const WHEEL_STEP = 1.15

export interface Pan {
  x: number
  y: number
}

export function clampScale(scale: number): number {
  if (!Number.isFinite(scale)) return MIN_SCALE
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale))
}

/** 缩放后图片超出视口的那一半，就是平移的边界。

    没缩放（scale=1）时图片正好铺满，边界为 0——**此时必须钉死在原位**，
    否则轻轻一拖图就飘走了，而用户没有任何办法把它拖回来（他不知道该拖多远）。 */
export function panBound(viewport: number, content: number, scale: number): number {
  const overflow = content * scale - viewport
  return overflow <= 0 ? 0 : overflow / 2
}

export function clampPan(pan: Pan, box: { w: number; h: number }, content: { w: number; h: number }, scale: number): Pan {
  const bx = panBound(box.w, content.w, scale)
  const by = panBound(box.h, content.h, scale)
  // 加 0 是为了把 -0 归一成 0：-0 进 CSS transform 无害，但会让快照与
  // 相等断言莫名其妙地不过，排查起来比它值得的时间长
  return {
    x: Math.min(bx, Math.max(-bx, pan.x)) + 0,
    y: Math.min(by, Math.max(-by, pan.y)) + 0,
  }
}

/** 以光标为锚点缩放：光标底下那个点在缩放前后要停在原地。

    直接改 scale 而不动 pan 的话，画面是**从中心**放大的——用户想看右上角那块细节，
    放大后它跑出视野了，得再拖回来。以光标为锚是看图件的基本手感。 */
export function zoomAt(
  pan: Pan,
  from: number,
  to: number,
  cursor: { x: number; y: number },
  box: { w: number; h: number },
): Pan {
  const ratio = to / from
  // 光标相对画面中心的偏移
  const cx = cursor.x - box.w / 2
  const cy = cursor.y - box.h / 2
  return {
    x: cx - (cx - pan.x) * ratio,
    y: cy - (cy - pan.y) * ratio,
  }
}

/** 适应窗口时图片实际占的尺寸（contain，不裁切）。

    **不放大小图**：一张 192×128 的缩略图铺满 1600px 视口只会糊成一片，
    还不如按原始大小摆在中间。 */
export function fitSize(
  natural: { w: number; h: number },
  box: { w: number; h: number },
): { w: number; h: number } {
  if (natural.w <= 0 || natural.h <= 0 || box.w <= 0 || box.h <= 0) return { w: 0, h: 0 }
  const k = Math.min(box.w / natural.w, box.h / natural.h, 1)
  return { w: natural.w * k, h: natural.h * k }
}

/** 「1:1」按钮该把 scale 设成多少：让图片按原始像素显示 */
export function oneToOneScale(natural: { w: number; h: number }, box: { w: number; h: number }): number {
  const fit = fitSize(natural, box)
  if (fit.w <= 0) return MIN_SCALE
  return clampScale(natural.w / fit.w)
}

/** 翻页。**到头停住不环绕**：一百二十张图里从第一张往左跳到最后一张，
    用户只会以为自己点错了。返回 null 表示到头了，调用方据此不动。 */
export function stepIndex(index: number, total: number, delta: number): number | null {
  if (total <= 0) return null
  const next = index + delta
  if (next < 0 || next >= total) return null
  return next
}
