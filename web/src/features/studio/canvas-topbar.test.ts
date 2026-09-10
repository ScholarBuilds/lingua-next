/* 画布页顶栏的分级降级。
 *
 * 起因是一次实测：1512 视口下顶栏 scrollWidth 1625 / clientWidth 1448，溢出 177px。
 * 旧逻辑只有一个 1360 的开关，过了就把 12 个次要按钮全摊开，而全摊开要 1900+ 才装得下。
 * 分组本身是纯函数，所以能在这里锁死；「按钮实际渲染出来有多宽」测不了，
 * 只能靠门禁在浏览器里目视（见交付说明）。
 *
 * 本仓 vitest 跑在 node 环境（没有 jsdom），渲染断言走 `renderToStaticMarkup`。 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import {
  TOPBAR_BREAKPOINTS,
  TOPBAR_KEEP,
  TOPBAR_MEDIA,
  TopbarMore,
  splitTopbarItems,
  tierFromMatches,
  topbarIconOnly,
  topbarTier,
} from './canvas-topbar'
import type { TopbarItem, TopbarTier } from './canvas-topbar'

const TIERS: TopbarTier[] = ['xs', 'sm', 'md', 'lg', 'xl']

/** 与 CanvasPage 里的次要工具同构：12 个，顺序即优先级 */
const ITEMS: TopbarItem[] = [
  'media',
  'assets',
  'wf',
  'llm',
  'modelscope',
  'midjourney',
  'loop',
  'tplsave',
  'tpluse',
  'io',
  'logs',
  'repair',
].map((key) => ({ key, label: key, onSelect: () => {} }))

describe('topbarTier', () => {
  it('按阈值分档，边界值归到高档', () => {
    expect(topbarTier(0)).toBe('xs')
    expect(topbarTier(TOPBAR_BREAKPOINTS.sm - 1)).toBe('xs')
    expect(topbarTier(TOPBAR_BREAKPOINTS.sm)).toBe('sm')
    expect(topbarTier(TOPBAR_BREAKPOINTS.md - 1)).toBe('sm')
    expect(topbarTier(TOPBAR_BREAKPOINTS.md)).toBe('md')
    expect(topbarTier(TOPBAR_BREAKPOINTS.lg - 1)).toBe('md')
    expect(topbarTier(TOPBAR_BREAKPOINTS.lg)).toBe('lg')
    expect(topbarTier(TOPBAR_BREAKPOINTS.xl - 1)).toBe('lg')
    expect(topbarTier(TOPBAR_BREAKPOINTS.xl)).toBe('xl')
  })

  it('出事的那个视口（1512）落在 lg：栏上留 6 个，另 6 个进更多', () => {
    const tier = topbarTier(1512)
    expect(tier).toBe('lg')
    const { bar, more } = splitTopbarItems(ITEMS, tier)
    expect(bar).toHaveLength(6)
    expect(more).toHaveLength(6)
    // 旧逻辑在这个宽度把 12 个全摊开，正是溢出 177px 的来源
    expect(bar.length).toBeLessThan(ITEMS.length)
  })
})

describe('tierFromMatches', () => {
  it('全不命中就是最窄档', () => {
    expect(tierFromMatches({ sm: false, md: false, lg: false, xl: false })).toBe('xs')
  })

  it('真实浏览器里 min-width 向下包含，取最高命中档', () => {
    expect(tierFromMatches({ sm: true, md: true, lg: true, xl: true })).toBe('xl')
    expect(tierFromMatches({ sm: true, md: true, lg: true, xl: false })).toBe('lg')
    expect(tierFromMatches({ sm: true, md: true, lg: false, xl: false })).toBe('md')
    expect(tierFromMatches({ sm: true, md: false, lg: false, xl: false })).toBe('sm')
  })

  it('与 topbarTier 对同一宽度给出同一档', () => {
    for (const width of [320, 1039, 1040, 1279, 1280, 1479, 1480, 1839, 1840, 2560]) {
      const matches = {
        sm: width >= TOPBAR_BREAKPOINTS.sm,
        md: width >= TOPBAR_BREAKPOINTS.md,
        lg: width >= TOPBAR_BREAKPOINTS.lg,
        xl: width >= TOPBAR_BREAKPOINTS.xl,
      }
      expect(tierFromMatches(matches)).toBe(topbarTier(width))
    }
  })
})

describe('splitTopbarItems', () => {
  it('一个都不丢：两段加起来永远等于原数组', () => {
    for (const tier of TIERS) {
      const { bar, more } = splitTopbarItems(ITEMS, tier)
      expect([...bar, ...more]).toEqual(ITEMS)
    }
  })

  it('顺序不变：bar 是前缀、more 是后缀', () => {
    const { bar, more } = splitTopbarItems(ITEMS, 'md')
    expect(bar.map((i) => i.key)).toEqual(['media', 'assets', 'wf'])
    expect(more.map((i) => i.key)).toEqual([
      'llm',
      'modelscope',
      'midjourney',
      'loop',
      'tplsave',
      'tpluse',
      'io',
      'logs',
      'repair',
    ])
  })

  it('每一档都只是把分界往后挪，不重排也不换人', () => {
    for (const tier of TIERS) {
      const { bar, more } = splitTopbarItems(ITEMS, tier)
      expect(bar).toEqual(ITEMS.slice(0, bar.length))
      expect(more).toEqual(ITEMS.slice(bar.length))
    }
  })

  it('最窄档全部折进更多，最宽档全部摊开', () => {
    const narrowest = splitTopbarItems(ITEMS, 'xs')
    expect(narrowest.bar).toHaveLength(0)
    expect(narrowest.more).toHaveLength(ITEMS.length)
    const widest = splitTopbarItems(ITEMS, 'xl')
    expect(widest.bar).toHaveLength(ITEMS.length)
    expect(widest.more).toHaveLength(0)
  })

  it('越宽留在栏上的越多，不会出现「宽了反而收起来」', () => {
    const counts = TIERS.map((tier) => splitTopbarItems(ITEMS, tier).bar.length)
    for (let i = 1; i < counts.length; i += 1) {
      expect(counts[i]).toBeGreaterThanOrEqual(counts[i - 1])
    }
  })

  it('工具比档位配额少时不越界，也不会造出空洞', () => {
    const few = ITEMS.slice(0, 2)
    const { bar, more } = splitTopbarItems(few, 'xl')
    expect(bar).toEqual(few)
    expect(more).toEqual([])
    expect(splitTopbarItems([], 'lg')).toEqual({ bar: [], more: [] })
  })

  it('最宽档的配额刚好覆盖全部次要工具，多一个就会被永久藏进菜单', () => {
    expect(TOPBAR_KEEP.xl).toBe(ITEMS.length)
  })
})

describe('topbarIconOnly', () => {
  it('只有最窄档收成纯图标', () => {
    expect(TIERS.filter(topbarIconOnly)).toEqual(['xs'])
  })
})

describe('TopbarMore', () => {
  it('没有折叠项时整个不渲染，不留一个空按钮', () => {
    expect(renderToStaticMarkup(createElement(TopbarMore, { items: [] }))).toBe('')
  })

  it('有折叠项时渲染触发按钮，且默认合上', () => {
    const html = renderToStaticMarkup(createElement(TopbarMore, { items: ITEMS.slice(9) }))
    expect(html).toContain('scv-barmore')
    expect(html).toContain('更多')
    expect(html).toContain('aria-haspopup="menu"')
    expect(html).toContain('aria-expanded="false"')
    // 合上时菜单不在 DOM 里：纯 CSS 隐藏的话这些按钮仍在 tab 顺序和无障碍树里
    expect(html).not.toContain('role="menu"')
    expect(html).not.toContain('资源修复')
  })

  it('触发按钮的提示里带条数，用户知道菜单里有多少东西', () => {
    const html = renderToStaticMarkup(createElement(TopbarMore, { items: ITEMS.slice(7) }))
    expect(html).toContain('放不下的 5 个工具')
  })

  it('包裹层不再叫 .scv-more——那个类名被多图节点的「+N」格子占着', () => {
    const html = renderToStaticMarkup(createElement(TopbarMore, { items: ITEMS }))
    expect(html).not.toMatch(/class="scv-more[" ]/)
  })
})

describe('阈值与 canvas.css 同源', () => {
  /* JS 决定「哪些按钮进更多菜单」，CSS 决定「两条辅助文案什么时候收起」，
     两边用同一组阈值。分开写就会错位：文案先没了按钮还挤着，或者反过来。 */
  const css = readFileSync(
    fileURLToPath(new URL('./canvas.css', import.meta.url)),
    'utf8',
  )

  it('提示文案在 xl 以下收起', () => {
    expect(css).toContain(`@media (max-width: ${TOPBAR_BREAKPOINTS.xl - 1}px)`)
  })

  it('画布类型徽标在 md 以下收起', () => {
    expect(css).toContain(`@media (max-width: ${TOPBAR_BREAKPOINTS.md - 1}px)`)
  })

  it('媒体查询串按阈值拼，改常量不用手改字符串', () => {
    expect(TOPBAR_MEDIA.lg).toBe(`(min-width: ${TOPBAR_BREAKPOINTS.lg}px)`)
  })
})
