/* 全屏浮层宿主（需求 09 v9.4 FR-127）。

   Fullscreen API 只渲染全屏元素的后代子树：视频全屏时全屏元素是 .vm-screen，
   挂在页面根上的词卡/帮助浮层不在这棵子树里，等于凭空消失（点了词没反应）。
   这里把浮层在全屏期间 portal 进全屏元素，退出全屏再回到原位。 */

import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { createPortal } from 'react-dom'

interface LegacyDocument extends Document {
  webkitFullscreenElement?: Element | null
}

function currentFullscreenElement(): HTMLElement | null {
  const d = document as LegacyDocument
  const el = d.fullscreenElement ?? d.webkitFullscreenElement ?? null
  return el instanceof HTMLElement ? el : null
}

/** 当前全屏元素，非全屏时为 null；Safari 16.4 以下只有 webkit 前缀事件 */
export function useFullscreenElement(): HTMLElement | null {
  const [el, setEl] = useState<HTMLElement | null>(null)
  useEffect(() => {
    const sync = () => setEl(currentFullscreenElement())
    sync()
    document.addEventListener('fullscreenchange', sync)
    document.addEventListener('webkitfullscreenchange', sync)
    return () => {
      document.removeEventListener('fullscreenchange', sync)
      document.removeEventListener('webkitfullscreenchange', sync)
    }
  }, [])
  return el
}

export function FullscreenPortal({ children }: { children: ReactNode }) {
  const host = useFullscreenElement()
  if (host === null) return <>{children}</>
  return createPortal(children, host)
}
