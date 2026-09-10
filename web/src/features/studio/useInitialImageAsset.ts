import { useEffect, useRef } from 'react'
import { toast } from 'sonner'

import { apiImage } from '../../lib/api-image'
import type { ImageAsset } from '../../lib/api-image'

/** 消费跨工具链接里的 `?asset=<id>`，只在页面首次打开时加载一次。 */
export function useInitialImageAsset(onAsset: (asset: ImageAsset) => void): void {
  const callback = useRef(onAsset)
  callback.current = onAsset

  useEffect(() => {
    const raw = new URLSearchParams(window.location.search).get('asset')
    if (raw === null || !/^\d+$/.test(raw) || Number(raw) < 1) return
    let alive = true
    void apiImage.asset(Number(raw)).then(
      (asset) => {
        if (alive) callback.current(asset)
      },
      (error: unknown) => {
        if (alive) {
          toast.error(error instanceof Error ? error.message : `资产 #${raw} 加载失败`)
        }
      },
    )
    return () => {
      alive = false
    }
  }, [])
}
