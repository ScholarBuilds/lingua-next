import { useEffect, useLayoutEffect, useRef } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'

import { usePrefStore } from '@/lib/prefStore'
import { moduleForPath, rememberedRoute, useWorkspaceStore, workspaceSnapshot } from '@/lib/workspaceStore'

export function WorkspaceMemory() {
  const location = useLocation()
  const navigate = useNavigate()
  const enabled = usePrefStore(s => s.prefs.ui.rememberPosition)
  const ready = useWorkspaceStore(s => s.ready)
  const error = useWorkspaceStore(s => s.error)
  const initialized = useRef(false)
  const initial = useRef(location)

  useEffect(() => { void useWorkspaceStore.getState().hydrate() }, [])
  useEffect(() => {
    const flush = () => { void useWorkspaceStore.getState().flush() }
    window.addEventListener('pagehide', flush)
    return () => window.removeEventListener('pagehide', flush)
  }, [])

  useLayoutEffect(() => {
    if (!ready || !enabled) return
    const route = rememberedRoute(`${location.pathname}${location.search}${location.hash}`)
    const module = moduleForPath(location.pathname)
    if (!route || !module) return
    if (!initialized.current) {
      initialized.current = true
      const saved = workspaceSnapshot('today', 'startup').route
      const start = initial.current
      if (start.pathname === '/' && !start.search && !start.hash && location.key === start.key && saved && saved !== '/') {
        const target = rememberedRoute(saved)
        if (target) { navigate(target, { replace: true }); return }
      }
    }
    const store = useWorkspaceStore.getState()
    store.put(module, 'last-route', { route })
    store.put('today', 'startup', { route })
  }, [ready, enabled, location, navigate])

  return error ? <div role="status" className="workspace-save-status">
    {error} <button onClick={async () => {
      await useWorkspaceStore.getState().hydrate()
      await useWorkspaceStore.getState().flush()
    }}>重试读写</button>
  </div> : null
}

export function usePageScrollMemory() {
  const { pathname, search } = useLocation()
  const enabled = usePrefStore(s => s.prefs.ui.rememberPosition)
  const ready = useWorkspaceStore(s => s.ready)
  useLayoutEffect(() => {
    const module = moduleForPath(pathname)
    const route = rememberedRoute(`${pathname}${search}`)
    if (!module || !route || !enabled || !ready) return
    const root = document.getElementById('main')
    if (!root) return
    const saved = workspaceSnapshot(module, `scroll:${route}`)
    let restoring = true
    let changed = false
    const positions = { ...saved.scroll }
    const scrollKey = (element: HTMLElement) => element.dataset.scrollMemory || element.id || [...element.classList].join('.')
    const containers = () => [root, ...root.querySelectorAll<HTMLElement>(
      '[data-scroll-memory], .content, .content-inner, .glib-tree-list, .glib-outline-scroll, .reader-content, .vm-feed, .grammar-tab-body',
    )].filter(el => !el.closest('[role="dialog"]'))
    const restore = () => {
      for (const el of containers()) {
        const key = scrollKey(el)
        if (key && positions[key] !== undefined && el.scrollHeight > el.clientHeight) el.scrollTop = positions[key]
      }
    }
    restore()
    const observer = new ResizeObserver(() => { if (restoring) restore() })
    observer.observe(root)
    const mutations = new MutationObserver(() => { if (restoring) restore() })
    mutations.observe(root, { childList: true, subtree: true })
    const stopRestoring = () => { restoring = false; observer.disconnect(); mutations.disconnect() }
    const timer = window.setTimeout(stopRestoring, 4000)
    const onScroll = (event: Event) => {
      if (restoring || !(event.target instanceof HTMLElement)) return
      const el = event.target
      const key = scrollKey(el)
      if (!key || key.length > 120 || !containers().includes(el)
        || (!(key in positions) && Object.keys(positions).length >= 24)) return
      positions[key] = el.scrollTop
      changed = true
      useWorkspaceStore.getState().put(module, `scroll:${route}`, { scroll: positions })
    }
    root.addEventListener('wheel', stopRestoring, { passive: true })
    root.addEventListener('pointerdown', stopRestoring)
    root.addEventListener('keydown', stopRestoring)
    root.addEventListener('scroll', onScroll, true)
    return () => {
      clearTimeout(timer); stopRestoring()
      root.removeEventListener('wheel', stopRestoring)
      root.removeEventListener('pointerdown', stopRestoring)
      root.removeEventListener('keydown', stopRestoring)
      root.removeEventListener('scroll', onScroll, true)
      if (changed) void useWorkspaceStore.getState().flush()
    }
  }, [pathname, search, enabled, ready])
}
