/** 订阅一条 CSS 媒体查询。用来让**布局结构**跟着视口变，而不只是让样式变。
 *
 *  纯 CSS 能做的（隐藏、换排列）就别用它——多一次渲染。它存在的理由是
 *  「窄屏时这几个按钮要挪进下拉菜单」这类 CSS 表达不了的结构变化：
 *  CSS 只能把同一批 DOM 藏起来，藏起来的按钮仍占着 tab 顺序与无障碍树。 */

import { useEffect, useState } from 'react'

export function useMediaQuery(query: string): boolean {
  const [hit, setHit] = useState(() =>
    typeof window === 'undefined' ? false : window.matchMedia(query).matches,
  )
  useEffect(() => {
    const mql = window.matchMedia(query)
    // 订阅前先同步一次：query 变了的那一帧，state 还是上一条查询的结果
    setHit(mql.matches)
    const on = (e: MediaQueryListEvent): void => setHit(e.matches)
    mql.addEventListener('change', on)
    return () => mql.removeEventListener('change', on)
  }, [query])
  return hit
}
