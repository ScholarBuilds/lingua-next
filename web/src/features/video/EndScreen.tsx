/* 播完推荐（需求 09 v9 FR-113 / v9.3 FR-123）：B 站 end screen 同款形态。
   同频道未学优先 → 同难度（±1 星）未学，推荐数据复用视频库列表，零新后端。
   卡片按舞台可用高度自适应，永远不出滚动条；「换一批」在候选池里循环翻页。 */

import { useQuery } from '@tanstack/react-query'
import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'

import { apiVideo, videoThumbUrl } from '../../lib/api-video'
import type { VideoCardV2 } from '../../lib/api-video'
import { usePlayerPrefs } from './playerPrefs'
import { coverGradient } from './VideoCard'
import { VIconPlaySolid, VIconRefresh } from './icons'
import { formatClock } from './videoUtils'

const AUTO_NEXT_SECONDS = 8
/** 一屏几张：3 列 × 2 行，短屏由 CSS 收成 1 行 */
const PAGE_SIZE = 6

export function EndScreen({
  current,
  onReplay,
}: {
  current: { id: number; channel: string | null; difficulty: number | null }
  onReplay: () => void
}) {
  const navigate = useNavigate()
  const autoNext = usePlayerPrefs((s) => s.autoNext)
  const [countdown, setCountdown] = useState<number | null>(null)
  const [page, setPage] = useState(0)

  const videosQuery = useQuery({ queryKey: ['videos'], queryFn: apiVideo.videos })

  /* 候选池整体排序：同频道 → 同难度 ±1 → 其余，「换一批」在池里循环取窗口 */
  const pool = useMemo(() => {
    const all = (videosQuery.data ?? []).filter(
      (v) => v.id !== current.id && v.status === 'ready',
    )
    const sameChannel = all.filter(
      (v) => current.channel !== null && v.channel === current.channel,
    )
    const sameLevel = all.filter(
      (v) =>
        !sameChannel.includes(v) &&
        current.difficulty !== null &&
        v.difficulty !== null &&
        Math.abs(v.difficulty - current.difficulty) <= 1,
    )
    const rest = all.filter((v) => !sameChannel.includes(v) && !sameLevel.includes(v))
    return [...sameChannel, ...sameLevel, ...rest]
  }, [videosQuery.data, current])

  const recs = useMemo(() => {
    if (pool.length === 0) return []
    const size = Math.min(PAGE_SIZE, pool.length)
    const start = (page * PAGE_SIZE) % pool.length
    return Array.from({ length: size }, (_, i) => pool[(start + i) % pool.length])
  }, [pool, page])

  // 自动连播（默认关）：8 秒倒计时进第一推荐，期间可取消
  useEffect(() => {
    if (!autoNext || recs.length === 0) return
    setCountdown(AUTO_NEXT_SECONDS)
    const timer = setInterval(() => {
      setCountdown((c) => {
        if (c === null) {
          clearInterval(timer)
          return null
        }
        if (c <= 1) {
          clearInterval(timer)
          navigate(`/video/${recs[0].id}`)
          return null
        }
        return c - 1
      })
    }, 1000)
    return () => clearInterval(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoNext, recs.length])

  return (
    <div className="vm-end">
      <div className="vm-end-head">
        <button className="btn btn-soft btn-sm" onClick={onReplay}>
          <VIconPlaySolid style={{ width: 13, height: 13 }} />
          重播本片
        </button>
        {pool.length > PAGE_SIZE && (
          <button
            className="btn btn-soft btn-sm"
            title="换一批推荐"
            onClick={() => {
              setPage((p) => p + 1)
              setCountdown(null) // 手动翻页视为接管，取消自动连播倒计时
            }}
          >
            <VIconRefresh style={{ width: 13, height: 13 }} />
            换一批
          </button>
        )}
        <div style={{ flex: 1 }} />
        {countdown !== null && recs.length > 0 && (
          <span className="vm-end-count">
            {countdown}s 后播放《{recs[0].title_zh ?? recs[0].title}》
            <button className="btn-ghost-sm" onClick={() => setCountdown(null)}>
              取消
            </button>
          </span>
        )}
      </div>
      {recs.length > 0 && (
        <div className="vm-end-grid">
          {recs.map((v) => (
            <RecCard key={v.id} video={v} onOpen={() => navigate(`/video/${v.id}`)} />
          ))}
        </div>
      )}
    </div>
  )
}

function RecCard({ video: v, onOpen }: { video: VideoCardV2; onOpen: () => void }) {
  return (
    <button className="vm-end-card" onClick={onOpen} title={v.title_zh ?? v.title}>
      <span className="vm-end-cover" style={{ background: coverGradient(v.id) }}>
        {v.thumb_url !== null && <img src={videoThumbUrl(v.thumb_url)} alt="" loading="lazy" />}
        {v.duration_s !== null && <em>{formatClock(v.duration_s)}</em>}
      </span>
      <span className="vm-end-title">{v.title_zh ?? v.title}</span>
      <span className="vm-end-meta">
        {v.channel}
        {v.difficulty !== null && ` · ${'★'.repeat(v.difficulty)}`}
      </span>
    </button>
  )
}
