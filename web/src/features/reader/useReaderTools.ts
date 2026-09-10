/* 阅读器工具箱的状态与副作用（FR-375~385）：排版变量注入、专注、全屏、自动滚动、搜索高亮。

   从 ReaderPage 里拆出来单独放，是因为这些能力彼此独立、各自带自己的 effect，
   混在页面组件里会让那个已经很长的文件更难读。页面只消费返回值。 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { usePrefStore } from '../../lib/prefStore'

/** 四种正文字体的实际字体栈；易读体优先本机 OpenDyslexic，装了才生效 */
const FONT_STACK: Record<string, string> = {
  serif: '"Iowan Old Style", "Source Serif 4", Charter, Georgia, "Times New Roman", serif',
  sans: '"Avenir Next", Avenir, -apple-system, "PingFang SC", "Helvetica Neue", sans-serif',
  mono: '"SF Mono", "JetBrains Mono", "Fira Code", Menlo, Consolas, monospace',
  dyslexic: '"OpenDyslexic", "Comic Sans MS", Verdana, sans-serif',
}

export interface ReaderToolsResult {
  /** 注入正文容器的排版 CSS 变量 */
  proseStyle: React.CSSProperties
  /** 纸张主题 data 属性值，auto 时为 undefined（跟随全局深浅色） */
  paperTheme: string | undefined
  focusMode: boolean
  setFocusMode: (v: boolean) => void
  isFullscreen: boolean
  toggleFullscreen: () => Promise<void>
  autoScroll: boolean
  setAutoScroll: (v: boolean) => void
}

export function useReaderTools(
  scrollRef: React.RefObject<HTMLDivElement | null>,
): ReaderToolsResult {
  const r = usePrefStore((s) => s.prefs.reader)
  const [focusMode, setFocusMode] = useState(false)
  const [isFullscreen, setIsFullscreen] = useState(false)
  const [autoScroll, setAutoScroll] = useState(false)

  const proseStyle = useMemo<React.CSSProperties>(
    () =>
      ({
        '--prose-font': FONT_STACK[r.font] ?? FONT_STACK.serif,
        '--prose-size': `${r.fontSize}px`,
        '--prose-lh': String(r.lineHeight),
        '--prose-width': `${r.pageWidth}px`,
        '--prose-gap': String(r.paragraphGap),
        '--prose-ls': `${r.letterSpacing}px`,
        '--prose-align': r.justify ? 'justify' : 'start',
      }) as React.CSSProperties,
    [r.font, r.fontSize, r.lineHeight, r.pageWidth, r.paragraphGap, r.letterSpacing, r.justify],
  )

  /* ── 全屏：Fullscreen API 只渲染全屏元素的后代子树，所以整到 .main 上，
        浮层（词卡/菜单）才不会消失（CLAUDE.md 记过这个坑）。 */
  const toggleFullscreen = useCallback(async () => {
    const el = scrollRef.current?.closest('.main') ?? document.documentElement
    try {
      if (document.fullscreenElement === null) await el.requestFullscreen()
      else await document.exitFullscreen()
    } catch {
      /* 内嵌浏览器面板会拒绝 requestFullscreen，静默即可 */
    }
  }, [scrollRef])

  useEffect(() => {
    const sync = () => setIsFullscreen(document.fullscreenElement !== null)
    document.addEventListener('fullscreenchange', sync)
    return () => document.removeEventListener('fullscreenchange', sync)
  }, [])

  /* ── 自动滚动：按 px/s 匀速推进。用 rAF 的时间差算位移，
        页签切走时 rAF 冻结、时间差会突然很大，所以夹住单帧步长。 */
  useEffect(() => {
    if (!autoScroll) return
    const el = scrollRef.current
    if (!el) return
    let raf = 0
    let last = performance.now()
    let acc = 0
    const step = (now: number) => {
      const dt = Math.min(now - last, 100) / 1000
      last = now
      acc += r.autoScrollSpeed * dt
      const whole = Math.floor(acc)
      if (whole > 0) {
        acc -= whole
        el.scrollTop += whole
        // 到底自动停，省得用户以为卡住了
        if (el.scrollTop + el.clientHeight >= el.scrollHeight - 2) {
          setAutoScroll(false)
          return
        }
      }
      raf = requestAnimationFrame(step)
    }
    raf = requestAnimationFrame(step)
    return () => cancelAnimationFrame(raf)
  }, [autoScroll, r.autoScrollSpeed, scrollRef])

  // 用户手动滚/点一下就停自动滚动（跟视频播放器同一套直觉）
  useEffect(() => {
    if (!autoScroll) return
    const el = scrollRef.current
    if (!el) return
    const stop = () => setAutoScroll(false)
    el.addEventListener('wheel', stop, { passive: true })
    el.addEventListener('touchstart', stop, { passive: true })
    return () => {
      el.removeEventListener('wheel', stop)
      el.removeEventListener('touchstart', stop)
    }
  }, [autoScroll, scrollRef])

  return {
    proseStyle,
    paperTheme: r.paperTheme === 'auto' ? undefined : r.paperTheme,
    focusMode,
    setFocusMode,
    isFullscreen,
    toggleFullscreen,
    autoScroll,
    setAutoScroll,
  }
}

/** 搜索命中在正文里的高亮标记：命中区间下发给 ProseView，由它在渲染时套 <mark> */
export function useSearchHighlight(hits: SearchHitLike[]): Map<number, Array<[number, number]>> {
  return useMemo(() => {
    const map = new Map<number, Array<[number, number]>>()
    for (const h of hits) {
      const bucket = map.get(h.paragraphId)
      if (bucket) bucket.push([h.start, h.end])
      else map.set(h.paragraphId, [[h.start, h.end]])
    }
    return map
  }, [hits])
}

interface SearchHitLike {
  paragraphId: number
  start: number
  end: number
}

/** 记住"当前视口最靠上的段落"，供插书签与统计使用 */
export function useVisibleParagraph(scrollRef: React.RefObject<HTMLDivElement | null>): {
  current: () => number | null
} {
  const lastRef = useRef<number | null>(null)
  const current = useCallback(() => {
    const el = scrollRef.current
    if (!el) return lastRef.current
    const top = el.getBoundingClientRect().top
    for (const node of Array.from(el.querySelectorAll<HTMLElement>('[data-pid]'))) {
      if (node.getBoundingClientRect().bottom > top + 8) {
        const pid = Number(node.dataset.pid)
        if (Number.isFinite(pid)) {
          lastRef.current = pid
          return pid
        }
      }
    }
    return lastRef.current
  }, [scrollRef])
  return { current }
}
