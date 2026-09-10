/* 阅读进度上报（M5-FA）：IntersectionObserver 记段落已读（50% 可见），
   前台可见时间累计时长，30s 节流 + 离开时 flush。已读段落不做视觉标记。 */

import { useEffect, useRef } from 'react'
import type { RefObject } from 'react'

import type { Article } from '../../lib/api'
import { readerApi } from '../../lib/api-reader-m5'
import type { ProgressBody } from '../../lib/api-reader-m5'

const FLUSH_INTERVAL_MS = 30_000

interface Options {
  articleId: string
  article: Article | undefined
  scrollRef: RefObject<HTMLDivElement | null>
  /** 段落 DOM 会随三态切换重建，切换后需重挂 observer */
  viewMode: string
}

export function useReadingProgress({ articleId, article, scrollRef, viewMode }: Options): void {
  // 待上报增量（服务端做并集合并，只发新增即可）
  const pendingReads = useRef(new Set<number>())
  const lastOrdinal = useRef<number | null>(null)
  const seconds = useRef(0)
  const flushing = useRef(false)
  // 只在文章就绪时更新：切章瞬间 article 短暂为 undefined，
  // 卸载 flush 仍要用上一篇的 id 把最后增量发出去
  const knownId = useRef<number | null>(null)
  if (article !== undefined) knownId.current = article.id

  // 切文章清零，避免上一章的增量串号
  useEffect(() => {
    pendingReads.current = new Set()
    lastOrdinal.current = null
    seconds.current = 0
  }, [articleId])

  // 前台可见计时：1s 心跳，仅页面可见时累加
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') seconds.current += 1
    }, 1000)
    return () => window.clearInterval(timer)
  }, [])

  // 段落 50% 可见即记已读；最近一次可见段落作为续读锚点
  useEffect(() => {
    const rootEl = scrollRef.current
    if (!article || !rootEl) return
    const ordinalByPid = new Map<number, number>()
    for (const p of article.paragraphs) ordinalByPid.set(p.id, p.ordinal)

    const io = new IntersectionObserver(
      (entries) => {
        let latest: number | null = null
        for (const entry of entries) {
          if (!entry.isIntersecting) continue
          const pid = Number((entry.target as HTMLElement).dataset.pid)
          const ordinal = ordinalByPid.get(pid)
          if (ordinal === undefined) continue
          pendingReads.current.add(ordinal)
          if (latest === null || ordinal > latest) latest = ordinal
        }
        if (latest !== null) lastOrdinal.current = latest
      },
      { root: rootEl, threshold: 0.5 },
    )
    for (const node of Array.from(rootEl.querySelectorAll<HTMLElement>('[data-pid]'))) {
      io.observe(node)
    }
    return () => io.disconnect()
  }, [article, scrollRef, viewMode])

  useEffect(() => {
    const buildBody = (): ProgressBody | null => {
      const id = knownId.current
      if (id === null) return null
      const reads = [...pendingReads.current]
      const dur = seconds.current
      if (reads.length === 0 && dur === 0) return null
      return {
        article_id: id,
        last_paragraph_ordinal: lastOrdinal.current ?? 0,
        read_paragraph_ordinals: reads,
        duration_s_delta: dur,
      }
    }

    const flush = async (): Promise<void> => {
      if (flushing.current) return
      const body = buildBody()
      if (body === null) return
      flushing.current = true
      // 先清增量，失败再回灌，避免与下一轮心跳重复计
      pendingReads.current = new Set()
      seconds.current = 0
      try {
        await readerApi.postProgress(body)
      } catch {
        for (const o of body.read_paragraph_ordinals) pendingReads.current.add(o)
        seconds.current += body.duration_s_delta
      } finally {
        flushing.current = false
      }
    }

    const beaconFlush = (): void => {
      const body = buildBody()
      if (body === null) return
      pendingReads.current = new Set()
      seconds.current = 0
      readerApi.sendProgressBeacon(body)
    }

    const timer = window.setInterval(() => void flush(), FLUSH_INTERVAL_MS)
    // 后台切走时顺手落一发，防止长时间挂后台丢时长
    const onVisibility = (): void => {
      if (document.visibilityState === 'hidden') beaconFlush()
    }
    window.addEventListener('pagehide', beaconFlush)
    window.addEventListener('beforeunload', beaconFlush)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      window.clearInterval(timer)
      window.removeEventListener('pagehide', beaconFlush)
      window.removeEventListener('beforeunload', beaconFlush)
      document.removeEventListener('visibilitychange', onVisibility)
      // 路由离开 / 切章：卸载时同步上报最后一段增量
      beaconFlush()
    }
  }, [articleId])
}
