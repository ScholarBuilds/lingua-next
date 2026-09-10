/* 画布页顶栏的分级降级。
 *
 * 顶栏一行要放 25 个控件，1512 视口下实测 scrollWidth 1625 / clientWidth 1448——
 * 溢出 177px，画布标题被压到 16px、按钮文字逐字竖排、最右侧的按钮直接点不到。
 * 根因是旧逻辑只有一个 1360 的开关：过了就把 12 个次要按钮**全部**摊开，
 * 而摊开后的宽度需要 1900+ 才装得下。
 *
 * 这里换成业内工具条通用的 priority+ 分级：按视口宽度分五档，
 * 每档规定「留几个次要按钮在栏上」，其余原样进「更多」菜单。
 * 分组是纯函数，宽度进去、两个数组出来，不依赖 DOM，可以直接测。
 *
 * 阈值同时被 canvas.css 的 @media 用（收 .scv-kind / .scv-hint），
 * 两处改一处就会错位，所以数字只在这里出现一次，CSS 那边注释指回本文件。 */

import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'

import { IconChevronDown } from '../../components/icons'

export type TopbarTier = 'xs' | 'sm' | 'md' | 'lg' | 'xl'

/** 视口宽度阈值（px）。画布页左侧是 64px 的 `--rail-w`，顶栏可用宽度 = 视口 - 64。
 *
 *  阈值不是拍的，是按**最坏情况**估出来的：中文按钮 12px 字号一字一格、
 *  图标 16 + 间距 6、btn-sm 左右各 10 内边距、按钮间距 8、三段间距 10、栏内边距 14×2。
 *  这套估法在改版前的布局上给出 1965，而实测 scrollWidth 是 1625——它偏保守 21%，
 *  所以每一档按估算值取阈值，实际还会更宽松。宁可空一点，
 *  也不要再出现「按钮被挤出栏外点不到」。
 *  sm/md 取设计令牌里的 --bp-lg / --bp-xl（1024 / 1280），另两档没有对应令牌。 */
export const TOPBAR_BREAKPOINTS = { sm: 1024, md: 1280, lg: 1500, xl: 2200 } as const

/** 各档留在栏上的次要按钮数量，其余进「更多」。12 是次要按钮总数，xl 即全摊开。
 *
 *  按上面那套保守估法，各档内容宽 / 可用宽（取该档最窄的那个视口，可用宽 = 视口 - 64）：
 *  xs 524/任意 · sm 828/960 · md 1117/1216 · lg 1419/1436 · xl 2085/2136 */
export const TOPBAR_KEEP: Record<TopbarTier, number> = { xs: 0, sm: 1, md: 3, lg: 6, xl: 12 }

/** 给 useMediaQuery 用的查询串。四条一起订阅，命中的最高档就是当前档。 */
export const TOPBAR_MEDIA = {
  sm: `(min-width: ${TOPBAR_BREAKPOINTS.sm}px)`,
  md: `(min-width: ${TOPBAR_BREAKPOINTS.md}px)`,
  lg: `(min-width: ${TOPBAR_BREAKPOINTS.lg}px)`,
  xl: `(min-width: ${TOPBAR_BREAKPOINTS.xl}px)`,
} as const

export type TopbarMatches = { sm: boolean; md: boolean; lg: boolean; xl: boolean }

/** 视口宽度 → 档位。测试与 SSR 用这条，运行时走 tierFromMatches。 */
export function topbarTier(width: number): TopbarTier {
  if (width >= TOPBAR_BREAKPOINTS.xl) return 'xl'
  if (width >= TOPBAR_BREAKPOINTS.lg) return 'lg'
  if (width >= TOPBAR_BREAKPOINTS.md) return 'md'
  if (width >= TOPBAR_BREAKPOINTS.sm) return 'sm'
  return 'xs'
}

/** 四条媒体查询的命中结果 → 档位。
 *  取命中的最高档而不是逐条 if 串联：min-width 是向下包含的，
 *  真实浏览器里 xl 命中时 lg/md/sm 一定也命中，但测试里可以只给一个 true，
 *  这样写对两种输入都成立。 */
export function tierFromMatches(m: TopbarMatches): TopbarTier {
  if (m.xl) return 'xl'
  if (m.lg) return 'lg'
  if (m.md) return 'md'
  if (m.sm) return 'sm'
  return 'xs'
}

/** 最窄一档收成纯图标：文字进 title / aria-label，命中区靠 CSS 撑满 32px。 */
export function topbarIconOnly(tier: TopbarTier): boolean {
  return tier === 'xs'
}

/** 按档位把次要工具切成「留在栏上的」与「进更多菜单的」。
 *
 *  两条不变量，测试直接盯着它们：
 *  - 一个都不丢：bar.length + more.length === items.length
 *  - 顺序不变：bar 是原数组的前缀，more 是剩下的后缀 */
export function splitTopbarItems<T>(
  items: readonly T[],
  tier: TopbarTier,
): { bar: T[]; more: T[] } {
  const keep = Math.max(0, Math.min(items.length, TOPBAR_KEEP[tier]))
  return { bar: items.slice(0, keep), more: items.slice(keep) }
}

export type TopbarItem = {
  key: string
  /** 菜单里的文案。可以带状态（「收起资产库」） */
  label: string
  /** 栏上的文案。省略时用 label——栏上要短且不随状态变，否则按钮宽度会跳 */
  barLabel?: string
  title?: string
  icon?: ReactNode
  disabled?: boolean
  active?: boolean
  onSelect: () => void
}

/** 顶栏的「更多」。**只装当前档放不下的那些**，放得下的按钮不会同时出现在两处。
 *
 *  为什么不是纯 CSS 隐藏：藏起来的按钮仍在 tab 顺序和无障碍树里，
 *  窄屏用户按 Tab 会一路走过一串看不见的控件。这里是真的换一套 DOM。 */
export function TopbarMore({ items }: { items: TopbarItem[] }) {
  const [open, setOpen] = useState(false)
  const wrap = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    if (!open) return
    /* 监听 mousedown 而不是 click：打开菜单的那次 click 还在冒泡，
       刚注册的 listener 会立刻收到它并把菜单关掉（表现为「点了没反应」）*/
    const off = (e: MouseEvent): void => {
      if (wrap.current?.contains(e.target as Node) !== true) setOpen(false)
    }
    window.addEventListener('mousedown', off)
    return () => window.removeEventListener('mousedown', off)
  }, [open])
  if (items.length === 0) return null
  return (
    <div className="scv-barmore" ref={wrap}>
      <button
        className={open ? 'btn btn-outline btn-sm is-active' : 'btn btn-outline btn-sm'}
        aria-expanded={open}
        aria-haspopup="menu"
        title={`放不下的 ${items.length} 个工具都在这里`}
        onClick={() => setOpen((v) => !v)}
      >
        更多 <IconChevronDown />
      </button>
      {open && (
        <div className="scv-barmore-pop" role="menu">
          {items.map((it) => (
            <button
              key={it.key}
              role="menuitem"
              title={it.title}
              disabled={it.disabled}
              onClick={() => {
                setOpen(false)
                it.onSelect()
              }}
            >
              {it.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
