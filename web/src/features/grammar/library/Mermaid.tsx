/* Mermaid 共享全局配置，渲染须串行；临时节点不能参与页面布局。 */

import { useEffect, useRef, useState, useSyncExternalStore } from 'react'

import { ImageViewer } from '../../../components/ImageViewer'

type MermaidApi = typeof import('mermaid').default

let mermaidReady: Promise<MermaidApi> | null = null

function loadMermaid(): Promise<MermaidApi> {
  if (mermaidReady === null) {
    mermaidReady = import('mermaid').then((mod) => mod.default)
  }
  return mermaidReady
}

/* ---- 跟随主题 ----

   mermaid 的 theme 是**全局配置**，初始化时写死一次的话，暗色主题下
   图仍是浅色节点底、深色文字——整页翻黑就它一块白板。
   `initialize` 可以反复调，所以每次渲染前按当前主题设一遍；
   主题一变，下面的订阅会让所有图重渲染。 */

function isDark(): boolean {
  const stamped = document.documentElement.dataset.theme
  if (stamped === 'dark') return true
  if (stamped === 'light') return false
  return window.matchMedia('(prefers-color-scheme: dark)').matches
}

/* 一个订阅供所有图共用：一页十几张图各挂一个 MutationObserver 是白费 */
const themeListeners = new Set<() => void>()
let themeWatching = false

function subscribeTheme(fn: () => void): () => void {
  themeListeners.add(fn)
  if (!themeWatching) {
    themeWatching = true
    const notify = () => themeListeners.forEach((f) => f())
    new MutationObserver(notify).observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
    })
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', notify)
  }
  return () => themeListeners.delete(fn)
}

function useMermaidTheme(): 'dark' | 'neutral' {
  return useSyncExternalStore(
    subscribeTheme,
    () => (isDark() ? 'dark' : 'neutral'),
    () => 'neutral' as const,
  )
}

/* 渲染串行化：mermaid 内部有全局状态，两张图同时渲染会互相踩，
   表现为其中一张莫名失败并留下临时容器 */
let queue: Promise<unknown> = Promise.resolve()

function enqueue<T>(job: () => Promise<T>): Promise<T> {
  const run = queue.then(job, job)
  queue = run.catch(() => undefined)
  return run
}

/** 扫掉 mermaid 留在 body 上的临时容器（含别人留下的） */
export function sweepStrayContainers(): number {
  const strays = document.querySelectorAll('body > div[id^="dglib-mmd-"]')
  strays.forEach((el) => el.remove())
  return strays.length
}

let seq = 0

export function Mermaid({ code, caption }: { code: string; caption?: string }) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [ready, setReady] = useState(false)
  const [zoom, setZoom] = useState<string | null>(null)
  const theme = useMermaidTheme()

  useEffect(() => {
    let cancelled = false
    setError(null)
    setReady(false)
    const id = `glib-mmd-${++seq}`

    void enqueue(async () => {
      if (cancelled) return
      let container: HTMLDivElement | null = null
      try {
        const mermaid = await loadMermaid()
        if (cancelled) return
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: 'strict',
          theme,
          fontFamily: 'var(--font-ui)',
        })
        const ok = await mermaid.parse(code, { suppressErrors: true })
        if (cancelled) return
        if (ok === false) {
          setError('图表语法不合法')
          return
        }
        container = document.createElement('div')
        container.className = 'glib-mmd-render'
        container.setAttribute('aria-hidden', 'true')
        container.style.width = `${hostRef.current?.clientWidth ?? 760}px`
        document.body.append(container)
        const { svg } = await mermaid.render(id, code, container)
        if (cancelled || hostRef.current === null) return
        hostRef.current.innerHTML = svg
        setReady(true)
      } catch (e) {
        if (!cancelled) setError((e as Error).message ?? '渲染失败')
      } finally {
        container?.remove()
        sweepStrayContainers()
      }
    })

    return () => {
      cancelled = true
    }
  }, [code, theme])

  /** SVG 序列化成 data URI 交给通用看图件——缩放、平移、1:1 全部复用 */
  const openZoom = () => {
    const svg = hostRef.current?.querySelector('svg')
    if (svg === null || svg === undefined) return
    const clone = svg.cloneNode(true) as SVGElement
    // 视口尺寸要写死，否则脱离容器后没有内在尺寸，看图件量不到
    const box = svg.getBoundingClientRect()
    clone.setAttribute('width', String(Math.round(box.width) || 800))
    clone.setAttribute('height', String(Math.round(box.height) || 600))
    clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg')
    const text = new XMLSerializer().serializeToString(clone)
    setZoom(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(text)}`)
  }

  if (error !== null) {
    return (
      <div className="glib-mmd-error glib-nowords">
        <p>图表渲染失败：{error.split('\n')[0]}</p>
        <pre>{code}</pre>
      </div>
    )
  }

  return (
    <>
      <div
        className={`glib-mmd glib-nowords${ready ? '' : ' pending'}`}
        ref={hostRef}
        role="button"
        aria-label={ready ? '放大图表' : '图表加载中'}
        aria-busy={!ready}
        tabIndex={0}
        title="点击放大"
        onClick={openZoom}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            openZoom()
          }
        }}
      />
      {zoom !== null && (
        <ImageViewer
          images={[{ id: 'mmd', url: zoom, caption: caption ?? '图表' }]}
          index={0}
          onIndex={() => {}}
          onClose={() => setZoom(null)}
        />
      )}
    </>
  )
}
