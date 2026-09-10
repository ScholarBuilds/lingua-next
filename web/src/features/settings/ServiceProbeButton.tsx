import { useMutation } from '@tanstack/react-query'
import { useEffect, useRef } from 'react'
import { playUrl } from '../../lib/audio'
import type { ServiceProbeResult } from '../../lib/api-config'

export function ServiceProbeButton({ run, label = '测试延迟', disabled = false, compact = false }: {
  run: () => Promise<ServiceProbeResult>
  label?: string
  disabled?: boolean
  compact?: boolean
}) {
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const probe = useMutation({ mutationFn: run, onSuccess: (result) => {
    if (mounted.current && result.ok && result.audio) playUrl(`data:${result.mime_type ?? 'audio/mpeg'};base64,${result.audio}`)
  } })
  return <div className="service-probe">
    <button className="btn-ghost-sm" disabled={disabled || probe.isPending} onClick={(event) => {
      event.stopPropagation()
      probe.mutate()
    }}>{probe.isPending ? '测试中…' : label}</button>
    {probe.error && <span role="alert">{probe.error.message}</span>}
    {probe.data && <span role="status" title={probe.data.detail} className={probe.data.ok ? 'service-probe-ok' : 'service-probe-error'}>
      {probe.data.ok ? '通过' : '失败'} · {probe.data.latency_ms} ms
    </span>}
    {probe.data && !probe.data.ok && <span role="alert">{probe.data.detail}</span>}
    {probe.data?.ok && probe.data.audio && <button className="btn-ghost-sm" onClick={() => {
      playUrl(`data:${probe.data?.mime_type ?? 'audio/mpeg'};base64,${probe.data?.audio}`)
    }}>重播</button>}
    {probe.data?.ok && !compact && <details className="service-probe-detail"><summary>测试详情</summary>
      <p>{probe.data.detail}</p>
      {probe.data.session_ms !== undefined && <p>会话建立 {probe.data.session_ms} ms · 首段音频 {probe.data.latency_ms} ms</p>}
      {probe.data.sample && <p>{probe.data.sample}</p>}
    </details>}
  </div>
}
