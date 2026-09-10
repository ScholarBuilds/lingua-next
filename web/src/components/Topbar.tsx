/* 页面顶栏。

   > [!info] 它原来不是组件，是 14 份手抄
   >
   > 每个页面各写一遍 `<header className="topbar">`，于是同一条栏在 14 处
   > 各自决定放什么、怎么对齐：13 处重复写了 `<div style={{flex:1}} />` 撑中间，
   > 两处额外挂 `sh-topbar` 才会在窄屏换行，返回键有的用返回组件、
   > 有的用 `btn-ghost-sm`、有的干脆只有一个不可点的标题。
   > 没有共享契约的直接后果是：大多数页面的顶栏中间 95% 是空的，
   > 因为「这里该放什么」从来没有被定义过。

   契约是三段：**位置**（左）· **动作**（右），中间的空隙由组件自己撑。

   - `back`：返回上一层。有它就说明这一页是从别处进来的
   - `crumbs`：祖先层级，可点回去；当前页不进这个数组
   - `title`：当前在哪。它是这条栏存在的理由，永远显示
   - `meta`：贴着标题的状态（计数、难度星、口音标签），不是动作
   - `actions`：这一页能做什么。放不下时整条换行，不挤压标题

   窄屏换行是默认行为，不再需要页面自己加 `sh-topbar`——
   那个类当初只有书架和两个学习页加了，其余页面在窄屏下是被压扁的。 */

import type { ReactNode } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'

import { currentHistoryIdx, previousVisitInModule } from '../lib/navHistory'
import { moduleForPath } from '../lib/workspaceStore'
import { IconArrowLeft, IconChevronRight } from './icons'

export interface Crumb {
  label: string
  /** 有 to 或 onClick 才可点；当前页不该出现在 crumbs 里 */
  to?: string
  onClick?: () => void
}

export interface TopbarProps {
  /* 返回上一层。
     `to` 走「深链返回」语义（BR-G-012，2026-09-05 修订）：**上一页在本模块内**才退一步
     回到用户真正来的地方；深链直接打开、或上一页是切菜单来的别的模块（从阅读切到单词本
     再按返回，退到阅读不是用户要的）都去 `to`——本模块的父级。**不能退化成普通
     `<Link to>`**——那样从站内跳进来再返回会跳到固定上级而不是上一页。
     `onClick` 留给页内状态回退（比如词库从详情回列表，路由没变）。 */
  back?: { to?: string; onClick?: () => void; label: string }
  crumbs?: Crumb[]
  title: ReactNode
  /** 紧跟标题的状态标记：计数徽章、难度星、口音标签 */
  meta?: ReactNode
  /** 右侧动作区 */
  actions?: ReactNode
}

function CrumbLink({ crumb }: { crumb: Crumb }) {
  if (crumb.to !== undefined) {
    return (
      <Link className="tb-crumb-link" to={crumb.to}>
        {crumb.label}
      </Link>
    )
  }
  if (crumb.onClick !== undefined) {
    return (
      <button className="tb-crumb-link" onClick={crumb.onClick}>
        {crumb.label}
      </button>
    )
  }
  return <span className="tb-crumb-text">{crumb.label}</span>
}

/** 退一步会落在本模块内才算「有上一页」：序号由 App 在每次 location 变化时记录（lib/navHistory） */
function hasModuleHistory(pathname: string): boolean {
  const idx = currentHistoryIdx()
  return idx !== undefined && idx > 0 && previousVisitInModule(idx, moduleForPath(pathname))
}

function TopbarBack({ back }: { back: NonNullable<TopbarProps['back']> }) {
  const navigate = useNavigate()
  const location = useLocation()
  const backOne = back.to !== undefined && hasModuleHistory(location.pathname)
  const label = backOne ? '返回上一页' : `返回${back.label}`
  return (
    <button
      className="tb-back"
      title={label}
      aria-label={label}
      onClick={() => {
        if (back.onClick !== undefined) back.onClick()
        else if (backOne) navigate(-1)
        else if (back.to !== undefined) navigate(back.to)
      }}
    >
      <IconArrowLeft />
    </button>
  )
}

export function Topbar({ back, crumbs, title, meta, actions }: TopbarProps) {
  return (
    <header className="topbar">
      {back !== undefined && <TopbarBack back={back} />}

      {/* 面包屑用 nav 包住并起名：页面里同时存在主导航与它，
          读屏的 landmark 列表里两个无名 navigation 分不出谁是谁 */}
      <nav className="tb-where" aria-label="当前位置">
        {crumbs?.map((c) => (
          <span className="tb-crumb" key={c.label}>
            <CrumbLink crumb={c} />
            <IconChevronRight />
          </span>
        ))}
        <h1 className="tb-title">{title}</h1>
        {meta !== undefined && <span className="tb-meta">{meta}</span>}
      </nav>

      {/* 中间的空隙由组件撑。原来是 13 个页面各写一遍 `style={{flex:1}}` */}
      <div className="tb-gap" />

      {actions !== undefined && <div className="tb-actions">{actions}</div>}
    </header>
  )
}
