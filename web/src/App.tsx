import { Fragment, lazy, Suspense, useEffect, useState } from 'react'
import { Link, Outlet, useLocation } from 'react-router-dom'

import { Toaster } from '@/components/ui/sonner'

import { BrandIcon } from './components/BrandIcon'
import { NexusVisual, nexusDomainForPath } from './components/NexusVisual'
import { CommandPalette } from './components/CommandPalette'
import { useMascotStore } from './features/mascot/mascotStore'
import { RailRunning } from './features/pipeline/RailRunning'
import { RunningDock } from './features/pipeline/RunningDock'
import { hasShell } from './lib/shell'
import { SettingsModal, useOpenSettings } from './features/settings/SettingsModal'
import { useTaskSummary } from './features/studio/taskHistory'
import { usePlayerStore } from './features/reader/playerStore'
import { useReaderStore } from './features/reader/readerStore'
import { usePrefStore } from './lib/prefStore'
import { useWordVoices } from './lib/api-tts'
import { setWordVoices } from './lib/audio'
import { TooltipProvider } from '@/components/ui/tooltip'
import { useInstantTooltip } from './lib/useInstantTooltip'
import { WorkspaceMemory, usePageScrollMemory } from './components/WorkspaceMemory'
import { moduleForPath, useWorkspaceStore } from './lib/workspaceStore'
import { ModuleBoundary } from './components/ModuleBoundary'
import { ListenGlobal } from './features/vocab/ListenGlobal'
import { currentHistoryIdx, recordVisit } from './lib/navHistory'
import { railTarget } from './lib/railTarget'

const RealtimeSessionHost = lazy(async () => ({ default: (await import('./features/talk/RealtimeSessionPage')).RealtimeSessionHost }))

function PersistentSessionHost() {
  const { pathname } = useLocation()
  const [visited, setVisited] = useState(pathname.startsWith('/talk'))
  useEffect(() => { if (pathname.startsWith('/talk')) setVisited(true) }, [pathname])
  return visited ? <ModuleBoundary name="语音会话"><Suspense fallback={null}><RealtimeSessionHost /></Suspense></ModuleBoundary> : null
}

/** 「任务」导航项的徽标：管线与工坊任务合成一个入口（CR-006 D4），在跑与失败一起数 */
function TasksBadge() {
  const summary = useTaskSummary()
  const busy = summary.data?.active ?? 0
  const failed = summary.data?.attention ?? 0
  const n = busy + failed
  if (n === 0) return null
  /* 光一个数字读屏念出来是「3」，不知道 3 什么。文字给辅助技术，数字给眼睛。
     眼睛看到的是 busy+failed，朗读也必须把两半都说全。 */
  const what = [busy > 0 && `${busy} 个在跑`, failed > 0 && `${failed} 个失败`]
    .filter(Boolean)
    .join('，')
  return (
    <span className={`rail-badge${busy > 0 ? '' : ' bad'}`}>
      <span className="sr-only">{what}</span>
      <span aria-hidden>{n}</span>
    </span>
  )
}

/** 主题三态解析：system 跟随操作系统，显式 light/dark 优先 */
function useResolvedDark(): boolean {
  const theme = usePrefStore((s) => s.prefs.theme)
  const [systemDark, setSystemDark] = useState(
    () => window.matchMedia('(prefers-color-scheme: dark)').matches,
  )

  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = (e: MediaQueryListEvent) => setSystemDark(e.matches)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])

  return theme === 'dark' || (theme === 'system' && systemDark)
}

/** 按词钉死的音色表 → lib/audio 内存表。放在根上装一次，词卡 / 学新词 / 复习 /
    听读所有 `playTts(word, 'word')` 调用点零改动就吃到覆盖 */
function useWordVoicesBridge() {
  const { data } = useWordVoices()
  useEffect(() => {
    if (data !== undefined) setWordVoices(data)
  }, [data])
}

/** 偏好 → 消费侧单向同步：服务端注水或设置页修改后推给各运行时 store。
    各 store 的 setter 反向写 prefStore 时值相同会被 update() 短路，不会成环 */
function usePrefsBridge(dark: boolean) {
  const transStyle = usePrefStore((s) => s.prefs.reader.transStyle)
  const follow = usePrefStore((s) => s.prefs.reader.follow)
  const clickable = usePrefStore((s) => s.prefs.reader.clickableWords)
  const readerVoice = usePrefStore((s) => s.prefs.reader.voice)
  const mascotEnabled = usePrefStore((s) => s.prefs.mascot.enabled)
  const mascotModel = usePrefStore((s) => s.prefs.mascot.modelId)

  // 启动注水：服务端 prefs 整包（后端未就绪时静默保持本地缓存）
  useEffect(() => {
    void usePrefStore.getState().hydrate()
  }, [])

  useEffect(() => {
    if (dark) document.documentElement.setAttribute('data-theme', 'dark')
    else document.documentElement.removeAttribute('data-theme')
  }, [dark])

  useEffect(() => {
    if (transStyle === 'muted') document.documentElement.removeAttribute('data-trans-style')
    else document.documentElement.setAttribute('data-trans-style', transStyle)
  }, [transStyle])

  useEffect(() => {
    if (usePlayerStore.getState().follow !== follow) {
      usePlayerStore.setState({ follow, followSuspended: false })
    }
  }, [follow])

  // 阅读器音色偏好 → 播放器；null 表示跟随配置中心的场景绑定，不覆盖
  useEffect(() => {
    if (readerVoice !== null && usePlayerStore.getState().voice !== readerVoice) {
      usePlayerStore.getState().setVoice(readerVoice)
    }
  }, [readerVoice])

  useEffect(() => {
    if (useReaderStore.getState().clickableWords !== clickable) {
      useReaderStore.setState({ clickableWords: clickable })
    }
  }, [clickable])

  useEffect(() => {
    if (useMascotStore.getState().enabled !== mascotEnabled) {
      useMascotStore.setState({ enabled: mascotEnabled })
    }
  }, [mascotEnabled])

  useEffect(() => {
    if (mascotModel !== null && useMascotStore.getState().modelId !== mascotModel) {
      useMascotStore.setState({ modelId: mascotModel })
    }
  }, [mascotModel])
}

/* 展开态的分组标题。图标栏只能用无名分隔线分组，而「这几个是学习、
   那一个是创作」传达不了——能给组命名正是带标签竖列相对图标栏的核心优势。
   按活动分组、不按角色（CR-006 D3）：「今天」在组外，「任务」在底部。 */
const NAV_GROUP_TITLES = ['学习', '创作'] as const

interface NavItem {
  key: string
  label: string
  icon: React.ReactNode
  to?: string
  active?: boolean
  disabled?: boolean
}

/* 导航项用链接而不是按钮。

   > [!danger] 用 `<button onClick={navigate(to)}>` 做页面跳转会丢掉一整排浏览器原生能力
   >
   > 中键新标签页、⌘/Ctrl 点击、右键「在新标签页打开」、复制链接地址、
   > 拖到书签栏——这些全部依赖元素本身是链接，JS 跳转一个都补不回来。
   > 读屏也会把它读成「按钮」而不是「链接」，用户不知道点了会换页。
   >
   > 换成 `NavLink` 顺带白拿 `aria-current="page"`：原来「哪一项是当前页」
   > 只写在 CSS class 里，读屏用户完全读不到。

   禁用项（即将上线）仍用 `<button disabled>`：它确实不是链接，没有目的地。 */
function RailLink({
  item,
  children,
  variant = 'rail',
  collapsed,
}: {
  item: NavItem
  children?: React.ReactNode
  variant?: 'rail' | 'appbar'
  collapsed?: boolean
}) {
  const base = variant === 'appbar' ? 'appbar-item' : 'rail-item'
  const location = useLocation()
  const remember = usePrefStore(s => s.prefs.ui.rememberPosition)
  const module = moduleForPath(item.to ?? '/')
  const lastRoute = useWorkspaceStore(s => s.records[`${module}:last-route`]?.route)
  /* 折叠态标签用 .sr-only 而不是不渲染：可访问名必须留着，
     否则读屏听到的是十个没有名字的链接。视觉上的提示走 title。 */
  const body = (
    <>
      {item.icon}
      <span className={collapsed === true ? 'sr-only' : 'rail-label'}>{item.label}</span>
      {children}
    </>
  )

  if (item.disabled === true || item.to === undefined) {
    return (
      <button className={base} disabled title={`${item.label}（即将上线）`}>
        {body}
      </button>
    )
  }

  /* 用 `Link` 而不是 `NavLink`，选中态自己判。

     > [!danger] `NavLink` 不会把你传的 `aria-current` 原样发出去
     >
     > 它只在**自己**算出的 `isActive` 为真时才发射，传进去的值只决定
     > 「发射什么」，不决定「发不发」。而本项目的选中判据比它宽：
     > 「任务」在 `/pipeline/*` 下也算选中（管线中心并进了任务，D4），
     > 这时 NavLink 对 `/tasks` 的 isActive 为假 → **一个字都不发**，
     > 视觉上高亮着、读屏却读不到「当前页」。
     > 它还会自己追加一个 `active` token，前缀命中的路由会渲染成
     > `class="rail-item active active"`。
     >
     > 换成 `Link` 之后 class 与 aria-current 同源，都由调用方的 `item.active` 决定。 */
  const target = railTarget({
    to: item.to,
    active: item.active === true,
    here: `${location.pathname}${location.search}${location.hash}`,
    pathname: location.pathname,
    lastRoute: remember ? lastRoute : undefined,
  })

  return (
    <Link
      to={target}
      className={`${base}${item.active === true ? ' active' : ''}`}
      aria-current={item.active === true ? 'page' : undefined}
      title={collapsed === true ? item.label : undefined}
    >
      {body}
    </Link>
  )
}

/** 沉浸式路由：顶部布局下隐藏全局导航条，由页面自带 topbar 独占一条（不叠两条） */
export function isImmersive(pathname: string): boolean {
  return (
    pathname.startsWith('/read/') ||
    /^\/video\/[^/]+/.test(pathname) ||
    pathname.startsWith('/talk/session')
  )
}

export function App() {
  usePageScrollMemory()
  const dark = useResolvedDark()
  usePrefsBridge(dark)
  useWordVoicesBridge()
  // 全产品的 title 提示统一即时浮出（FR-357）
  useInstantTooltip()
  const location = useLocation()
  // 顶栏返回箭头要知道「上一页是不是本模块的」（BR-G-012 修订）
  useEffect(() => {
    recordVisit(
      currentHistoryIdx(),
      moduleForPath(location.pathname),
      `${location.pathname}${location.search}`,
    )
  }, [location])
  const navLayout = usePrefStore((s) => s.prefs.ui.navLayout)
  const savedNavCollapsed = usePrefStore((s) => s.prefs.ui.navCollapsed)
  const [narrowWindow, setNarrowWindow] = useState(() => window.matchMedia('(max-width: 600px)').matches)
  useEffect(() => {
    const media = window.matchMedia('(max-width: 600px)')
    const update = () => setNarrowWindow(media.matches)
    media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [])
  const compactSoftware = narrowWindow && (
    location.pathname.startsWith('/software-english') ||
    (location.pathname === '/grammar' && new URLSearchParams(location.search).get('tab') === 'software')
  )
  const navCollapsed = compactSoftware || savedNavCollapsed

  /* ⌘K / Ctrl+K 在任何页面都能开（CR-006 D6），再按一次关。
     不判焦点在不在输入框：这个组合键浏览器默认也不给文本框用。 */
  const [paletteOpen, setPaletteOpen] = useState(false)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setPaletteOpen((v) => !v)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const pathname = location.pathname
  const visualDomain = nexusDomainForPath(pathname)
  const settingsActive = pathname.startsWith('/settings')

  const todayItem: NavItem = {
    key: 'today',
    label: '今天',
    icon: <BrandIcon name="today" />,
    to: '/',
    active: pathname === '/',
  }
  const learnItems: NavItem[] = [
    // 阅读器是从阅读进去的，/read/* 下仍算「阅读」选中
    { key: 'read', label: '阅读', icon: <BrandIcon name="read" />, to: '/read', active: pathname.startsWith('/read') },
    { key: 'video', label: '视频', icon: <BrandIcon name="video" />, to: '/video', active: pathname.startsWith('/video') },
    { key: 'vocab', label: '词汇', icon: <BrandIcon name="vocab" />, to: '/vocab', active: pathname.startsWith('/vocab') },
    { key: 'dict', label: '查词', icon: <BrandIcon name="search" />, to: '/dict', active: pathname.startsWith('/dict') },
    { key: 'grammar', label: '英语讲义', icon: <BrandIcon name="grammar" />, to: '/grammar', active: pathname.startsWith('/grammar') },
    { key: 'talk', label: '对话', icon: <BrandIcon name="talk" />, to: '/talk', active: pathname.startsWith('/talk') },
  ]
  const createItems: NavItem[] = [
    // 生图控制台不再占一级导航：它是工坊「生图控制台 / 图片编辑」两张卡片的落点，
    // `/image` 路由保留，深链、工坊卡片与对话页的「送进控制台」都还走这里
    { key: 'studio', label: '工坊', icon: <BrandIcon name="studio" />, to: '/studio', active: pathname.startsWith('/studio') },
  ]
  /* 管线并入任务（D4）：/pipeline/* 的域页与主体页深链保留，导航高亮「任务」 */
  const tasksItem: NavItem = {
    key: 'tasks',
    label: '任务',
    icon: <BrandIcon name="tasks" />,
    to: '/tasks',
    active: pathname === '/tasks' || pathname.startsWith('/pipeline'),
  }
  const navGroups = [learnItems, createItems]

  // 右下角快捷切换写显式主题；三态（含跟随系统）在设置 · 阅读与外观里选
  const toggleTheme = () => usePrefStore.getState().update({ theme: dark ? 'light' : 'dark' })

  const openSettings = useOpenSettings()
  const topMode = navLayout === 'top'
  const inShell = hasShell()
  const immersive = isImmersive(pathname)
  // 曾经有过「整屏独占、连 rail 一起藏」的第三档（生图页用），三轮已废除：
  // 生图是常驻工作区，每次回词库看效果都要先点返回，跳转频率压过了画布面积（CR-001）
  const showAppbar = topMode && !immersive

  return (
    /* 图标操作条靠即时提示才认得出（FR-349）：delayDuration 0，指过去就出 */
    <TooltipProvider delayDuration={0}>
    <div className={`app${topMode ? ' layout-top' : ''}${inShell ? ' shell' : ''}`}>
      {/* 键盘用户每次换页都要穿过 13 个导航项才够得着正文。平时不可见，一聚焦就落到左上角。
          目标是 <Outlet /> 外面那层，路由换了它还在，不必每个页面自己挂锚点。 */}
      <a className="skip-link" href="#main">
        跳到主内容
      </a>
      {!topMode && (
        <nav className={`rail${navCollapsed ? ' collapsed' : ''}`} aria-label="主导航">
          {/* 壳里标题栏与 Dock 已经有图标，这一格留给红黄绿三个点当拖动区（titleBarStyle hiddenInset） */}
          <div className={`rail-logo${inShell ? ' rail-drag' : ''}`}>
            {!inShell && <img src="/brand/logo-96.png" alt="NEXUS" />}
          </div>
          <button className="rail-cmd" onClick={() => setPaletteOpen(true)} title="搜索与命令（⌘K）">
            <BrandIcon name="search" />
            <span className={navCollapsed ? 'sr-only' : 'rail-cmd-label'}>搜索、跳转、命令</span>
            {!navCollapsed && <kbd>⌘K</kbd>}
          </button>
          <RailLink item={todayItem} collapsed={navCollapsed} />
          {navGroups.map((group, gi) => (
            <Fragment key={gi}>
              {/* 展开时给组起名，折叠时退回一条分隔线 */}
              {navCollapsed ? (
                <div className="rail-sep" role="presentation" />
              ) : (
                <div className="rail-group">{NAV_GROUP_TITLES[gi]}</div>
              )}
              {group.map((it) => (
                <RailLink key={it.key} item={it} collapsed={navCollapsed} />
              ))}
            </Fragment>
          ))}
          <div className="rail-spacer" />
          <RailLink item={tasksItem} collapsed={navCollapsed}>
            <TasksBadge />
          </RailLink>
          {/* RunningDock 收进「任务」项下面（D4）；折叠态没有地方放，只剩徽标 */}
          {!navCollapsed && <RailRunning />}
          {!compactSoftware && <button
            className="rail-item rail-toggle"
            onClick={() => usePrefStore.getState().update({ ui: { navCollapsed: !navCollapsed } })}
            aria-expanded={!navCollapsed}
            title={navCollapsed ? '展开导航' : '收起导航'}
          >
            <BrandIcon name="collapse" />
            <span className={navCollapsed ? 'sr-only' : 'rail-label'}>
              {navCollapsed ? '展开' : '收起'}
            </span>
          </button>}
          <button className="rail-item" onClick={toggleTheme} title="切换深浅色">
            <BrandIcon name="theme" />
            <span className={navCollapsed ? 'sr-only' : 'rail-label'}>主题</span>
          </button>
          <button
            className={`rail-item${settingsActive ? ' active' : ''}`}
            onClick={() => openSettings()}
            title={navCollapsed ? '设置' : undefined}
          >
            <BrandIcon name="settings" />
            <span className={navCollapsed ? 'sr-only' : 'rail-label'}>设置</span>
          </button>
        </nav>
      )}

      {showAppbar && (
        <header className="appbar">
          <div className="rail-logo appbar-logo">
            <img src="/brand/logo-96.png" alt="NEXUS" />
          </div>
          <nav className="appbar-nav" aria-label="主导航">
            {/* 与侧栏同一组 NavItem、同一个 RailLink：两种布局下都是真链接，
                不会出现一个能 ⌘ 点开新标签页、一个不能。 */}
            <RailLink item={todayItem} variant="appbar" />
            {navGroups.map((group, gi) => (
              <Fragment key={gi}>
                <div className="appbar-sep" role="presentation" />
                {group.map((it) => (
                  <RailLink key={it.key} item={it} variant="appbar" />
                ))}
              </Fragment>
            ))}
            <div className="appbar-sep" role="presentation" />
            <RailLink item={tasksItem} variant="appbar">
              <TasksBadge />
            </RailLink>
          </nav>
          <div className="appbar-spacer" />
          <button className="icon-btn" title="搜索与命令（⌘K）" onClick={() => setPaletteOpen(true)}>
            <BrandIcon name="search" />
          </button>
          <button className="icon-btn" title="切换深浅色" onClick={toggleTheme}>
            <BrandIcon name="theme" />
          </button>
          <button
            className={`appbar-item${settingsActive ? ' active' : ''}`}
            onClick={() => openSettings()}
          >
            <BrandIcon name="settings" />
            设置
          </button>
        </header>
      )}

      {/* tabIndex={-1}：锚点跳转后焦点要真的落进来，否则读屏还停在链接上，
          「跳过去了」只是滚动了一下 */}
      <div id="main" tabIndex={-1} className="app-main workspace-column" data-visual-domain={visualDomain}>
        <WorkspaceMemory />
        <PersistentSessionHost />
        <div className="workspace-route">
        <NexusVisual name={visualDomain} className="workspace-visual" />
        <Outlet />
        {/* 听读跨页常驻（BR-184）：媒体键与迷你条挂在页面外面，路由换了它们还在 */}
        <ListenGlobal />
        </div>
      </div>

      {/* 顶部布局没有侧栏可收，在跑面板仍走右下角浮层 */}
      {topMode && <RunningDock />}

      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />

      {/* 设置弹窗：任意页面可开，关闭回原页原状态（FR-93） */}
      <SettingsModal />

      {immersive && (
        <button className="theme-toggle" onClick={toggleTheme} title="切换深浅色">
          <BrandIcon name="theme" />
        </button>
      )}

      <Toaster position="bottom-center" />
    </div>
    </TooltipProvider>
  )
}
