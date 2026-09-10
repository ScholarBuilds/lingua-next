/* 分析结果版本入口（M5-FA）：v{n} 小按钮 → 版本列表 Popover（portal 渲染，
   不受面板滚动容器裁切）→ activate 切换后回填结果。
   寻址键与服务端 content_key 一致（api-reader-m5.contentKey）。 */

import { useState } from 'react'

import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'

import { IconCheck } from '../../components/icons'
import { contentKey, readerApi } from '../../lib/api-reader-m5'
import type { AnalysisVersion, AnalyzeDone, VersionQuery } from '../../lib/api-reader-m5'
import { IconVersions } from './local-icons'

interface VersionsButtonProps<T> {
  scope: VersionQuery['scope']
  kind: VersionQuery['kind']
  /** 参与 content_hash 的文本（词 / 句 / 短语） */
  content: string
  /** 参与 context_hash 的文本，无则空串 */
  context?: string
  version: string | number | null
  onActivated: (data: AnalyzeDone<T>) => void
}

export function VersionsButton<T>({
  scope,
  kind,
  content,
  context,
  version,
  onActivated,
}: VersionsButtonProps<T>) {
  const [open, setOpen] = useState(false)
  const [versions, setVersions] = useState<AnalysisVersion[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [failed, setFailed] = useState(false)
  const [activating, setActivating] = useState<number | null>(null)

  const load = async () => {
    setLoading(true)
    setFailed(false)
    try {
      const [chash, ctxHash] = await Promise.all([
        contentKey(content),
        context ? contentKey(context) : Promise.resolve(''),
      ])
      setVersions(
        await readerApi.analyzeVersions({
          scope,
          kind,
          content_hash: chash,
          context_hash: ctxHash,
        }),
      )
    } catch {
      setFailed(true)
    } finally {
      setLoading(false)
    }
  }

  const activate = async (v: AnalysisVersion) => {
    if (v.is_active || activating !== null) return
    setActivating(v.id)
    try {
      const data = await readerApi.activateAnalysis<T>(v.id)
      onActivated(data)
      setOpen(false)
    } catch {
      setFailed(true)
    } finally {
      setActivating(null)
    }
  }

  if (version === null || version === undefined) return null

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (next) void load()
      }}
    >
      <PopoverTrigger asChild>
        <button className="ver-btn" title="历史版本">
          <IconVersions />v{version}
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-[240px] bg-card p-1" align="end">
        <div className="ver-pop-list">
          {loading && <div className="ver-hint">加载版本…</div>}
          {failed && <div className="ver-hint err">版本列表加载失败</div>}
          {versions !== null && versions.length === 0 && !loading && (
            <div className="ver-hint">暂无历史版本</div>
          )}
          {versions?.map((v) => (
            <button
              key={v.id}
              className={`ver-item${v.is_active ? ' active' : ''}`}
              disabled={activating !== null}
              onClick={() => void activate(v)}
            >
              <b>v{v.version ?? '?'}</b>
              <span className="ver-model">{v.model}</span>
              {v.is_active ? (
                <IconCheck className="ver-check" />
              ) : (
                <span className="ver-use">{activating === v.id ? '切换中…' : '启用'}</span>
              )}
            </button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  )
}
