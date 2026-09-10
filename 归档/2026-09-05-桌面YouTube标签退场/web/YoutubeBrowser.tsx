import { useEffect, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'

import { youtubeCommand } from '@/lib/shell'
import type { YoutubeState } from '@/lib/shell'
import { apiVideo } from '@/lib/api-video'
import { useUrlValue } from '@/lib/urlState'
import { useWorkspaceStore, workspaceSnapshot } from '@/lib/workspaceStore'

export function YoutubeBrowser() {
  const area = useRef<HTMLDivElement>(null)
  const qc = useQueryClient()
  const [requested] = useUrlValue<string>('youtube', '')
  const [input, setInput] = useState('')
  const [state, setState] = useState<YoutubeState>({ url: '' })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const available = !!window.linguaShell?.youtube
  const memoryReady = useWorkspaceStore(s => s.ready)

  useEffect(() => {
    if (!available || !memoryReady) return
    let disposed = false
    let lastBounds = ''
    const refreshBounds = () => {
      if (disposed || !area.current) return
      const blocked = document.querySelector('[role="dialog"], [role="alertdialog"], [data-radix-popper-content-wrapper]') !== null
      const rect = area.current.getBoundingClientRect()
      let left = Math.max(0, rect.left), top = Math.max(0, rect.top)
      let right = Math.min(window.innerWidth, rect.right), bottom = Math.min(window.innerHeight, rect.bottom)
      for (let parent = area.current.parentElement; parent; parent = parent.parentElement) {
        const style = getComputedStyle(parent)
        const clip = parent.getBoundingClientRect()
        if (/auto|scroll|hidden|clip/.test(style.overflowX)) { left = Math.max(left, clip.left); right = Math.min(right, clip.right) }
        if (/auto|scroll|hidden|clip/.test(style.overflowY)) { top = Math.max(top, clip.top); bottom = Math.min(bottom, clip.bottom) }
      }
      const bounds = { x: left, y: top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) }
      const hidden = blocked || !bounds.width || !bounds.height
      const key = hidden ? 'hidden' : JSON.stringify(bounds)
      if (lastBounds === key) return
      lastBounds = key
      void youtubeCommand(hidden ? { action: 'hide' } : { action: 'show', bounds }).catch(e => {
        if (!disposed) setError(String(e))
      })
    }
    const start = async () => {
      const current = await youtubeCommand({ action: 'state' })
      if (disposed) return
      const saved = workspaceSnapshot('video', 'youtube').selected
      const url = requested || (current.title ? '' : saved)
      if (url) await youtubeCommand({ action: 'navigate', url })
      if (disposed) await youtubeCommand({ action: 'hide' })
      else refreshBounds()
    }
    void start().catch(e => { if (!disposed) setError(String(e)) })
    const resize = new ResizeObserver(refreshBounds)
    if (area.current) resize.observe(area.current)
    const overlays = new MutationObserver(refreshBounds)
    overlays.observe(document.body, { childList: true, subtree: true })
    const timer = setInterval(() => {
      void youtubeCommand({ action: 'state' }).then(next => {
        if (disposed) return
        setState(next)
        if (next.url) useWorkspaceStore.getState().put('video', 'youtube', { selected: next.url })
      }).catch(e => { if (!disposed) setError(String(e)) })
    }, 1000)
    window.addEventListener('resize', refreshBounds)
    document.addEventListener('scroll', refreshBounds, true)
    return () => {
      disposed = true; clearInterval(timer); resize.disconnect(); overlays.disconnect()
      window.removeEventListener('resize', refreshBounds)
      document.removeEventListener('scroll', refreshBounds, true)
      void youtubeCommand({ action: 'hide' }).catch(e => toast.error(`无法关闭浏览视图：${String(e)}`))
    }
  }, [available, memoryReady, requested])

  const act = (action: 'back' | 'forward' | 'reload') => {
    void youtubeCommand({ action }).catch(e => setError(String(e)))
  }
  const navigate = () => {
    const text = input.trim()
    if (!text) return
    const url = /^https?:\/\//.test(text) ? text : `https://www.youtube.com/results?search_query=${encodeURIComponent(text)}`
    setError(null)
    void youtubeCommand({ action: 'navigate', url }).catch(e => setError(String(e)))
  }
  const collect = async () => {
    setBusy(true)
    try {
      const current = await youtubeCommand({ action: 'state' })
      const result = await apiVideo.collectOnline(current.url, current.title || 'YouTube 视频')
      toast.success(result.existed ? '已在学习库中' : '已收藏在线引用，不会下载视频')
      void qc.invalidateQueries({ queryKey: ['videos'] })
    } catch (e) { toast.error(String(e)) } finally { setBusy(false) }
  }
  return <section className="yt-workspace">
    <div className="yt-toolbar">
      <button className="btn" disabled={!state.canGoBack} onClick={() => act('back')}>后退</button>
      <button className="btn" disabled={!state.canGoForward} onClick={() => act('forward')}>前进</button>
      <button className="btn" disabled={!available} onClick={() => act('reload')}>刷新</button>
      <input className="input" value={input} onChange={e => setInput(e.target.value)} placeholder="搜索 YouTube 或粘贴视频链接"
        aria-label="搜索或地址" onKeyDown={e => { if (e.key === 'Enter') navigate() }} />
      <button className="btn" disabled={!available} onClick={navigate}>前往</button>
      <button className="btn btn-primary" disabled={!available || busy} onClick={() => void collect()}>收藏当前视频</button>
      <button className="btn" disabled={!available || busy} onClick={() => {
        void youtubeCommand({ action: 'state' }).then(current => {
          const path = new URL(current.url).pathname
          if (!/^\/(channel\/|@)/.test(path)) throw new Error('请先打开频道主页')
          return apiVideo.subscribe(current.url)
        }).then(() => toast.success('订阅已添加')).catch(e => toast.error(String(e)))
      }}>订阅当前频道</button>
    </div>
    <p className="yt-notice">浏览不会下载视频。登录、地区及播放限制由 YouTube 决定；离开后暂停播放。</p>
    {(error || state.error) && <p role="alert" className="we-err">{error || state.error}</p>}
    {!available ? <div className="state-block">内置 YouTube 仅在更新后的桌面客户端可用。</div> : <div ref={area} className="yt-native-area" aria-label="YouTube 浏览区域" />}
  </section>
}
