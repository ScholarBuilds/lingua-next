/* 入库进度中心（需求 09 v6 FR-67~70）：顶栏常驻入口 + 抽屉。

   替掉 v5 那个只在发现页角落的队列——处理进度是跨页面的全局状态，
   在哪个页面都该看得见。数据走 SSE 推送而非轮询（FR-68），空闲零请求。 */

import { useMutation, useQueryClient } from '@tanstack/react-query'

import { useEscapeClose } from '../../components/Overlay'
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { useNavigate } from 'react-router-dom'
import { toast } from 'sonner'

import { IconClose } from '../../components/icons'
import { apiPipeline } from '../../lib/api-pipeline'
import type { ActiveItem, ActivePayload } from '../../lib/api-pipeline'
import { apiVideo } from '../../lib/api-video'
import { onTaskStreamConnected, subscribePipelineEvents } from '../studio/taskEvents'
import { ACTIVE_PIPELINE_STATUSES, foldActivePayload } from '../studio/taskQueries'

const EMPTY: ActivePayload = { items: [], active: 0 }

/* 全局折叠一份，多处消费。以前这里自己开一条 /api/pipeline/stream 的 EventSource
   收全量快照；现在实时增量走统一任务流的 pipeline 帧（单条 run 快照），
   /api/pipeline/active 只在建连 / 重连 / run 收口时拉一次基线——帧里看不出
   「成功但产出不达标」这类需要关注的项，靠基线收敛。 */
let latest: ActivePayload = EMPTY
const storeListeners = new Set<() => void>()
let detachFrames: (() => void) | null = null
let baselineTimer: ReturnType<typeof setTimeout> | null = null
let baselineSeq = 0
let baselineStartedAt = 0

function publish(next: ActivePayload): void {
  latest = next
  storeListeners.forEach((listener) => listener())
}

async function pullBaseline(): Promise<void> {
  const seq = ++baselineSeq
  baselineStartedAt = Date.now()
  try {
    const payload = await apiPipeline.active()
    // 期间又发起过新基线（或全部退订）就丢弃，别用旧响应盖新状态
    if (seq !== baselineSeq || storeListeners.size === 0) return
    publish(payload)
  } catch {
    // 基线拉不到就先靠帧折叠；下一次重连成功会再试
  }
}

function scheduleBaseline(delay: number): void {
  if (baselineTimer !== null) return
  baselineTimer = setTimeout(() => {
    baselineTimer = null
    void pullBaseline()
  }, delay)
}

function attachActiveStore(): void {
  if (detachFrames !== null) return
  const offFrames = subscribePipelineEvents((frame) => {
    publish(foldActivePayload(latest, frame))
    if (!ACTIVE_PIPELINE_STATUSES.has(frame.status)) scheduleBaseline(600)
  })
  const offConnected = onTaskStreamConnected(() => {
    // 首连时 attach 已经拉过一次，2s 内不重复；真正的重连要重拉补断线漏帧
    if (Date.now() - baselineStartedAt > 2000) scheduleBaseline(0)
  })
  void pullBaseline()
  detachFrames = () => {
    offFrames()
    offConnected()
    if (baselineTimer !== null) {
      clearTimeout(baselineTimer)
      baselineTimer = null
    }
    baselineSeq += 1
  }
}

function subscribeActiveStore(listener: () => void): () => void {
  storeListeners.add(listener)
  attachActiveStore()
  return () => {
    storeListeners.delete(listener)
    if (storeListeners.size === 0 && detachFrames !== null) {
      detachFrames()
      detachFrames = null
    }
  }
}

/** 全局订阅一次，多处消费：徽标、浮层与抽屉共用同一份折叠状态与同一条 SSE 连接 */
export function useActivePipeline(): ActivePayload {
  return useSyncExternalStore(subscribeActiveStore, () => latest)
}

export function ProgressCenter() {
  const payload = useActivePipeline()
  const [open, setOpen] = useState(false)
  const busy = payload.active
  const failed = payload.items.filter((i) => i.status === 'failed').length
  const degraded = payload.items.filter((i) => i.status === 'degraded').length
  const badge = busy + failed + degraded

  // 手头的事都处理完才自动收起。只判"列表为空"会把"闲时点开看看"也一并关掉，
  // 所以只在 非空 → 空 这个转变上收
  const prevCount = useRef(payload.items.length)
  useEffect(() => {
    const count = payload.items.length
    if (open && prevCount.current > 0 && count === 0) setOpen(false)
    prevCount.current = count
  }, [open, payload.items.length])

  return (
    <>
      <button
        className={`pc-entry${busy > 0 ? ' busy' : failed > 0 ? ' failed' : ''}`}
        title="入库进度"
        onClick={() => setOpen((v) => !v)}
      >
        <IconPipeline spinning={busy > 0} />
        {badge > 0 && <span className="pc-badge">{badge}</span>}
      </button>
      {open && <ProgressDrawer payload={payload} onClose={() => setOpen(false)} />}
    </>
  )
}

function ProgressDrawer({
  payload,
  onClose,
}: {
  payload: ActivePayload
  onClose: () => void
}) {
  const qc = useQueryClient()
  const navigate = useNavigate()

  const retry = useMutation({
    mutationFn: (videoId: number) =>
      apiPipeline.rerun({ video_id: videoId, scope: 'failed' }),
    onSuccess: () => toast.success('已从失败节点重跑'),
    onError: (e: Error) => toast.error(e.message || '重跑失败'),
  })

  const cancel = useMutation({
    mutationFn: (videoId: number) => apiVideo.cancelImport(videoId),
    onSuccess: () => {
      toast.success('已取消并移除')
      void qc.invalidateQueries({ queryKey: ['videos'] })
      void qc.invalidateQueries({ queryKey: ['feed'] })
    },
    onError: (e: Error) => toast.error(e.message || '取消失败'),
  })

  const failedItems = payload.items.filter((i) => i.status === 'failed')
  useEscapeClose(onClose)

  return (
    <>
      <div className="pc-scrim" onClick={onClose} />
      <aside className="pc-drawer">
        <div className="pc-head">
          <b>入库进度</b>
          <span className="pcd-sub">
            {payload.active > 0 ? `${payload.active} 条处理中` : '当前空闲'}
          </span>
          <div style={{ flex: 1 }} />
          {failedItems.length > 1 && (
            <button
              className="btn-ghost-sm"
              onClick={() => failedItems.forEach((i) => retry.mutate(i.video_id))}
            >
              全部重跑
            </button>
          )}
          <button className="icon-btn" title="关闭" onClick={onClose}>
            <IconClose />
          </button>
        </div>

        {payload.items.length === 0 && (
          <div className="pcd-empty">没有正在处理或待处理的视频</div>
        )}

        <div className="pc-list">
          {payload.items.map((item) => (
            <ProgressRow
              key={item.video_id}
              item={item}
              onOpen={() => {
                onClose()
                navigate(`/video/${item.video_id}/pipeline`)
              }}
              onRetry={() => retry.mutate(item.video_id)}
              onCancel={() => cancel.mutate(item.video_id)}
            />
          ))}
        </div>
      </aside>
    </>
  )
}

const STATUS_LABEL: Record<string, string> = {
  processing: '处理中',
  pending: '排队中',
  downloading: '下载中',
  transcribing: '转写中',
  translating: '翻译中',
  ready: '已完成',
  degraded: '产出不达标',
  failed: '失败',
}

function ProgressRow({
  item,
  onOpen,
  onRetry,
  onCancel,
}: {
  item: ActiveItem
  onOpen: () => void
  onRetry: () => void
  onCancel: () => void
}) {
  const running = ['processing', 'pending', 'downloading', 'transcribing', 'translating'].includes(
    item.status,
  )
  return (
    <div className={`pc-row ${item.status}`}>
      <div className="pc-row-main" onClick={onOpen}>
        <div className="pc-title" title={item.title}>
          {item.title}
        </div>
        <div className="pc-meta">
          <span className={`pc-state ${item.status}`}>
            {STATUS_LABEL[item.status] ?? item.status}
          </span>
          {/* 进度按节点分段，不再是笼统的 0-100（FR-69） */}
          {item.current_label !== null && <span>· {item.current_label}</span>}
          {item.total_steps > 0 && (
            <span className="pc-steps">
              {item.done_steps}/{item.total_steps} 节点
            </span>
          )}
        </div>
        {running && (
          <div className="pc-bar">
            <i style={{ width: `${Math.min(100, item.progress)}%` }} />
          </div>
        )}
        {item.error !== null && item.error !== '' && (
          <div className="pc-err" title={item.error}>
            {item.failed_steps.length > 0 && <b>{item.failed_steps.join('、')}：</b>}
            {item.error.slice(0, 80)}
          </div>
        )}
      </div>
      <div className="pc-row-act">
        <button className="btn-ghost-sm" onClick={onOpen}>
          链路
        </button>
        {(item.status === 'failed' || item.status === 'degraded') && (
          <button className="btn-ghost-sm" onClick={onRetry}>
            重跑
          </button>
        )}
        {running && (
          <button className="btn-ghost-sm" onClick={onCancel}>
            取消
          </button>
        )}
      </div>
    </div>
  )
}

function IconPipeline({ spinning }: { spinning: boolean }) {
  return (
    <svg
      className={spinning ? 'pc-spin' : undefined}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="5" cy="12" r="2.2" />
      <circle cx="12" cy="6" r="2.2" />
      <circle cx="12" cy="18" r="2.2" />
      <circle cx="19" cy="12" r="2.2" />
      <path d="M7 11l3-3.4M7 13l3 3.4M14 7.4l3 3.2M14 16.6l3-3.2" />
    </svg>
  )
}
