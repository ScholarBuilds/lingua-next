/* 流式开关（模块 16 FR-433 / AC-113）。

   上游支持 `stream=true` + `partial_images`，能推真实的中间图。但**中转网关是否透传
   SSE 未经验证**，所以这里不预设立场：默认「未探测」，走老路（状态 + 已跑秒数）；
   用户显式点一次探测，探通了才开。

   探测会真花一次钱（要出一张最小的图才知道推不推中间帧），所以要先说清楚再点。
   探不通就老实显示不支持——**任何情况下都不伪造中间帧或百分比**。 */

import { useMutation } from '@tanstack/react-query'
import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'

import { apiImage } from '@/lib/api-image'
import './StreamChip.css'

const KEY = 'img-stream-support'

export type StreamState = 'unknown' | 'on' | 'off'

/** 探测结论存本地：它是网关的属性，不随页面刷新变化，没必要每次开页都花一次钱 */
export function useStreamSupport(): [StreamState, (v: StreamState) => void] {
  const [state, setState] = useState<StreamState>('unknown')
  useEffect(() => {
    const saved = window.localStorage.getItem(KEY)
    if (saved === 'on' || saved === 'off') setState(saved)
  }, [])
  const update = useCallback((v: StreamState) => {
    setState(v)
    if (v === 'unknown') window.localStorage.removeItem(KEY)
    else window.localStorage.setItem(KEY, v)
  }, [])
  return [state, update]
}

export function StreamChip({
  state,
  onState,
  alias = 'image-free',
}: {
  state: StreamState
  onState: (v: StreamState) => void
  alias?: string
}) {
  const probe = useMutation({
    mutationFn: () => apiImage.streamProbe(alias),
    onSuccess: (d) => {
      onState(d.supported ? 'on' : 'off')
      if (d.supported) toast.success(`流式可用：${d.detail}`)
      else toast.warning(`流式不可用，退回普通模式。${d.detail}`)
    },
    onError: (e: Error) => toast.error(e.message),
  })

  const label =
    probe.isPending ? '探测中…' : state === 'on' ? '流式 · 开' : state === 'off' ? '流式 · 不支持' : '流式 · 未探测'

  return (
    <span className="strm">
      <button
        className={`strm-chip strm-${state}`}
        disabled={probe.isPending}
        onClick={() => probe.mutate()}
        title={
          state === 'unknown'
            ? '探测中转是否透传流式。会真出一张最小的图，花一次钱'
            : state === 'on'
              ? '出图过程中显示上游推来的真实中间图。点一下重新探测'
              : '中转没有透传流式，出图时只显示状态与已跑秒数。点一下重新探测'
        }
      >
        {label}
      </button>
      {state === 'on' && (
        <button className="strm-off" onClick={() => onState('off')} title="临时关掉流式">
          关
        </button>
      )}
    </span>
  )
}
