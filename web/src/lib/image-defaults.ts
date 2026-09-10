/* 生图默认参数的前端单一事实源（需求 17 §6.4.1 · CR-005 §3.5）。
 *
   与 `server/domain/image_defaults.py` 对称。后端那边的默认值原本以字面量
   `"medium"` 散在十三处，前端同样散着三处（画布的两处出图分支 + 参数下拉的默认值）——
   「把默认改成 high」这句话落到代码上就是十六次搜索替换，漏一处不报错，
   只会让那条链路继续出中等质量的图。

   所以这里也定一条规矩：**前端要用生图质量的默认值，只能从本模块取**。

   两层：

   1. `FALLBACK_QUALITY` —— 出厂默认，同步可用，页面还没拉到配置时就用它；
   2. 配置中心的全局值 —— 由 `/images/catalog` 带回来（`default_quality`），
      拉到之后覆盖缓存。

   用户在某个节点上微调的值优先级最高，不经这里。 */

import { useQuery } from '@tanstack/react-query'
import { useEffect } from 'react'

import { apiImage } from './api-image'

export const QUALITIES = ['low', 'medium', 'high'] as const

export type Quality = (typeof QUALITIES)[number]

/** 出厂默认。CR-005 §3.5 把它从 medium 提到 high */
export const FALLBACK_QUALITY: Quality = 'high'

let current: Quality = FALLBACK_QUALITY

/** 当前全局默认。同步读，永远有值 */
export function defaultQuality(): Quality {
  return current
}

/** 把 `/images/catalog` 带回来的全局默认存下来。非法值忽略，不改现状 */
export function setDefaultQuality(value: string | undefined | null): void {
  if (typeof value !== 'string') return
  const want = value.trim().toLowerCase()
  if ((QUALITIES as readonly string[]).includes(want)) current = want as Quality
}

/** 把节点/任务上存的值规整成合法档位；空值或非法值走全局默认。
 *
 *  容忍非法值而不是抛错：这个值常来自历史画布数据，
 *  旧节点里可能存着已经废弃的档名，打开画布时不该整页崩掉。 */
export function normalizeQuality(value: unknown): Quality {
  if (typeof value !== 'string') return current
  const want = value.trim().toLowerCase()
  return (QUALITIES as readonly string[]).includes(want) ? (want as Quality) : current
}

/** 测试用：回到出厂默认 */
export function resetDefaultQuality(): void {
  current = FALLBACK_QUALITY
}

/* ==================== React 接入 ==================== */

/** 把配置中心的全局默认灌进本模块。任何要用默认质量的页面调一次即可。
 *
 *  走的是和生图控制台同一个 queryKey：TanStack Query 会共享缓存，
 *  画布和控制台同时开着也只发一次请求。 */
export function useImageDefaults(): Quality {
  const catalog = useQuery({ queryKey: ['img-catalog'], queryFn: apiImage.catalog, staleTime: 5 * 60_000 })
  const fromServer = catalog.data?.default_quality
  useEffect(() => {
    setDefaultQuality(fromServer)
  }, [fromServer])
  return normalizeQuality(fromServer)
}
