/* 视频卡（对照 design/mockups/video-library.html）：六状态——未开始 / 学习中 /
   已学完 / 已收藏 / 处理中 / 失败；悬停快捷操作；进度环。 */

import { useState } from 'react'
import type { MouseEvent, ReactNode } from 'react'

import { IconCheck, IconChevronRight, IconDownload, IconPlay, IconTrash } from '../../components/icons'
import { videoThumbUrl } from '../../lib/api-video'
import type { VideoCardV2 } from '../../lib/api-video'
import { VIconBookmark, VIconInfoCircle, VIconRefresh } from './icons'
import { isFinished, isStarted } from './videoStudyStore'
import type { LibEntry } from './videoStudyStore'
import { formatClock, formatDate } from './videoUtils'

export const ACCENT_LABELS: Record<string, string> = {
  american: '美音',
  british: '英音',
  australian: '澳音',
  canadian: '加音',
  indian: '印度音',
  non_native: '非母语',
  mixed: '多口音',
}

export const ERROR_KIND_LABELS: Record<string, string> = {
  bot_check: 'Bot 校验',
  network: '网络错误',
  other: '处理出错',
}

const STAGE_LABELS: Record<string, string> = {
  pending: '排队',
  downloading: '下载',
  transcribing: '转写',
  translating: 'AI 加工',
}

/** 无封面时按 id 生成确定性渐变（对照设计稿的多彩封面底） */
export function coverGradient(id: number): string {
  const hue = (id * 137.508) % 360
  return (
    `radial-gradient(circle at 76% 18%, rgba(255,255,255,0.2), transparent 42%), ` +
    `radial-gradient(circle at 18% 88%, rgba(0,0,0,0.18), transparent 46%), ` +
    `linear-gradient(150deg, hsl(${hue} 38% 52%), hsl(${(hue + 24) % 360} 42% 28%))`
  )
}

export function Stars({ n }: { n: number | null }) {
  if (n === null || n <= 0) return null
  const full = Math.min(5, Math.max(1, n))
  return (
    <span className="vm-stars" title={`难度 ${full}/5`}>
      {'★'.repeat(full)}
      {full < 5 && <i>{'★'.repeat(5 - full)}</i>}
    </span>
  )
}

const RING_C = 2 * Math.PI * 13.5

export function ProgressRing({ pct }: { pct: number }) {
  const done = pct >= 100
  const dash = (Math.min(100, Math.max(0, pct)) / 100) * RING_C
  return (
    <svg className="vm-ring" viewBox="0 0 32 32">
      <circle className="rbg" cx="16" cy="16" r="13.5" />
      <circle
        className={`rfg${done ? ' done' : ''}`}
        cx="16"
        cy="16"
        r="13.5"
        strokeDasharray={`${dash} ${RING_C}`}
        transform="rotate(-90 16 16)"
      />
      <text x="16" y="19.5">
        {done ? '✓' : Math.round(pct)}
      </text>
    </svg>
  )
}

function stop(e: MouseEvent, fn: () => void): void {
  e.stopPropagation()
  fn()
}

interface VideoCardProps {
  video: VideoCardV2
  entry: LibEntry | undefined
  faved: boolean
  /** 最近学习的视频显示"上次 m:ss"角标 */
  isResume: boolean
  onOpen: () => void
  onToggleFav: () => void
  onRetry: () => void
  onDelete: () => void
  onEnrich: () => void
  onGoCredentials: () => void
  /** 打开全链路追踪页：错误细节、每步产出与重跑入口都在那里（v6 FR-71） */
  onTrace: () => void
}

export function VideoCard({
  video: v,
  entry,
  faved,
  isResume,
  onOpen,
  onToggleFav,
  onRetry,
  onDelete,
  onEnrich,
  onGoCredentials,
  onTrace,
}: VideoCardProps) {
  const [imgFailed, setImgFailed] = useState(false)

  // degraded：流程跑完但产物不达标（句层为空/译文不全）。视频能看，但要显式标黄
  // 并给出去链路页的入口，不能像 v6 之前那样静默伪装成 ready（FR-79）
  const degraded = v.status === 'degraded'
  const ready = v.status === 'ready' || degraded
  const failed = v.status === 'failed'
  const busy = !ready && !failed

  const pct = entry?.pct ?? 0
  const finished = ready && isFinished(entry)
  const started = isStarted(entry)

  const title = v.title_zh ?? v.title
  const dateStr = formatDate(v.created_at)

  /* ---- 处理中卡 ---- */
  if (busy) {
    const order = ['pending', 'downloading', 'transcribing', 'translating']
    const stageIdx = Math.max(0, order.indexOf(v.status))
    const stages: ReactNode[] = []
    const visible = ['downloading', 'transcribing', 'translating']
    visible.forEach((s, i) => {
      const si = order.indexOf(s)
      if (i > 0) stages.push(<IconChevronRight key={`c${s}`} />)
      if (si < stageIdx) {
        stages.push(
          <span key={s} className="done-step">
            {STAGE_LABELS[s]} ✓
          </span>,
        )
      } else if (si === stageIdx) {
        stages.push(
          <b key={s}>
            {STAGE_LABELS[s]} {v.progress}%
          </b>,
        )
      } else {
        stages.push(<span key={s}>{STAGE_LABELS[s]}</span>)
      }
    })
    return (
      <div className="card vm-vcard" style={{ cursor: 'default' }}>
        <div className="vm-cover proc">
          <IconDownload />
          <span>
            {STAGE_LABELS[v.status] ?? v.status}中 · {v.progress}%
          </span>
        </div>
        <div className="vm-vbody">
          <div className="vm-vtitle" style={{ color: 'var(--ink-secondary)' }}>
            {title}
          </div>
          <div
            className="vm-vsumm"
            style={{ display: 'flex', flexDirection: 'column', gap: 7, justifyContent: 'center' }}
          >
            <span className="vm-skl" style={{ width: '92%' }} />
            <span className="vm-skl" style={{ width: '64%' }} />
          </div>
          <div className="vm-stages">
            {stages}
            {v.status === 'pending' && (
              <span className="chip" style={{ marginLeft: 'auto' }}>
                排队中
              </span>
            )}
          </div>
          <div className="vm-pbar">
            <i style={{ width: `${v.status === 'pending' ? 2 : v.progress}%` }} />
          </div>
          <div className="vm-vfoot">
            <span className="info">yt-dlp{dateStr !== '' ? ` · ${dateStr}` : ''}</span>
            <button className="btn-ghost-sm" style={{ marginLeft: 'auto' }} onClick={onDelete}>
              取消
            </button>
          </div>
        </div>
      </div>
    )
  }

  /* ---- 失败卡 ---- */
  if (failed) {
    const kindLabel = ERROR_KIND_LABELS[v.error_kind ?? 'other'] ?? '处理出错'
    return (
      <div className="card vm-vcard" style={{ cursor: 'default' }}>
        <div className="vm-cover fail">
          <VIconInfoCircle />
          <span>处理中断于 {v.progress}%</span>
        </div>
        <div className="vm-vbody">
          <div className="vm-vtitle" style={{ color: 'var(--ink-secondary)' }} title={v.title}>
            {title}
          </div>
          <div className="vm-vmeta" style={{ marginTop: 2 }}>
            <span className="chip err">下载失败 · {kindLabel}</span>
          </div>
          <div className="vm-vsumm" style={{ minHeight: 'auto' }}>
            {v.error_kind === 'bot_check'
              ? '来源站要求登录验证。配置 Cookies 凭证后重试，或更换代理线路。'
              : (v.error ?? '未知错误')}
          </div>
          <div className="vm-vfoot">
            <button className="btn btn-soft btn-sm" onClick={onRetry}>
              <VIconRefresh />
              重试
            </button>
            <button className="btn btn-sm" onClick={onTrace}>
              查看链路
            </button>
            {v.error_kind === 'bot_check' ? (
              <button className="btn-ghost-sm" style={{ marginLeft: 'auto' }} onClick={onGoCredentials}>
                去配置凭证
              </button>
            ) : (
              <button className="btn-ghost-sm" style={{ marginLeft: 'auto' }} onClick={onDelete}>
                删除
              </button>
            )}
          </div>
        </div>
      </div>
    )
  }

  /* ---- 就绪卡（未开始 / 学习中 / 已学完）---- */
  const enriching =
    v.enrich_status !== null && v.enrich_status !== 'done' && v.enrich_status !== 'failed'
  const playTitle = finished ? '再学一遍' : started ? '继续学习' : '开始学习'

  return (
    <div
      className={`card vm-vcard${finished ? ' finished' : ''}`}
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === 'Enter') onOpen()
      }}
    >
      <div className="vm-cover" style={{ background: coverGradient(v.id) }}>
        {v.thumb_url !== null && !imgFailed && (
          <img
            src={videoThumbUrl(v.thumb_url)}
            alt={v.title}
            loading="lazy"
            onError={() => setImgFailed(true)}
          />
        )}
        {finished && (
          <span className="vm-vdone" title="已学完">
            <IconCheck />
          </span>
        )}
        {isResume && entry !== undefined && !finished && (
          <span className="vm-vbadge">
            <IconPlay />
            上次 {formatClock(entry.lastPosS)}
          </span>
        )}
        <div className="vm-play">
          <IconPlay />
        </div>
        {v.channel !== null && <span className="vm-author">{v.channel}</span>}
        {v.duration_s !== null && v.duration_s > 0 && (
          <span className="vm-dur">{formatClock(v.duration_s)}</span>
        )}
        <div className="vm-hover">
          <button
            title={faved ? '取消收藏' : '收藏'}
            className={faved ? 'faved' : ''}
            onClick={(e) => stop(e, onToggleFav)}
          >
            <VIconBookmark filled={faved} />
          </button>
          <button className="vm-main" title={playTitle} onClick={(e) => stop(e, onOpen)}>
            <IconPlay />
          </button>
          {degraded ? (
            <button title="查看全链路：看缺哪一环、就地重跑" onClick={(e) => stop(e, onTrace)}>
              <VIconInfoCircle />
            </button>
          ) : finished || !started ? (
            <button title="删除" onClick={(e) => stop(e, onDelete)}>
              <IconTrash />
            </button>
          ) : (
            <button title="重新加工" onClick={(e) => stop(e, onEnrich)}>
              <VIconRefresh />
            </button>
          )}
        </div>
      </div>
      <div className="vm-vbody">
        <div className="vm-vtitle" title={v.title}>
          {title}
        </div>
        <div className="vm-vsumm">
          {v.summary_zh ??
            (enriching ? 'AI 摘要生成中…' : v.enrich_status === 'failed' ? 'AI 加工失败，可在悬停菜单重新加工' : v.title)}
        </div>
        <div className="vm-vmeta">
          {degraded && (
            <span className="chip warn" title="产出不达标，点开链路页看缺哪一环">
              产出不达标
            </span>
          )}
          <Stars n={v.difficulty} />
          {v.accent !== null && (
            <span className="chip accent">{ACCENT_LABELS[v.accent] ?? v.accent}</span>
          )}
          {v.topics.slice(0, 2).map((t) => (
            <span key={t} className="chip">
              {t}
            </span>
          ))}
          {enriching && (
            <span className="chip">
              <span className="spinner" />
              AI 加工中
            </span>
          )}
          {v.enrich_status === 'failed' && <span className="chip err">加工失败</span>}
        </div>
        <div className="vm-vfoot">
          <span className="info">
            {v.vocab_count !== null ? `${v.vocab_count.toLocaleString()} 词` : ''}
            {entry !== undefined && entry.total > 0 ? ` · ${entry.total} 句` : ''}
            {dateStr !== '' ? ` · ${dateStr}` : ''}
          </span>
          {started || finished ? (
            <ProgressRing pct={pct} />
          ) : faved ? (
            <span className="bmark" title="已收藏">
              <VIconBookmark filled />
            </span>
          ) : (
            <span className="not-started">未开始</span>
          )}
        </div>
      </div>
    </div>
  )
}
