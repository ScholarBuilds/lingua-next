import { describe, expect, it, vi } from 'vitest'

import { scrollWithin } from './reader-scroll'

function fixture(targetTop = 520, targetHeight = 40) {
  const scrollTo = vi.fn()
  const scrollIntoView = vi.fn()
  const scroller = {
    scrollTop: 300,
    clientTop: 2,
    clientHeight: 600,
    getBoundingClientRect: () => ({ top: 100 }),
    scrollTo,
  } as unknown as HTMLElement
  const target = {
    getBoundingClientRect: () => ({ top: targetTop, height: targetHeight }),
    scrollIntoView,
  } as unknown as HTMLElement
  return { scroller, target, scrollTo, scrollIntoView }
}

describe('讲义正文定位', () => {
  it('标题对齐正文上沿，扣除边框并保留阅读间距', () => {
    const f = fixture()
    scrollWithin(f.scroller, f.target)
    expect(f.scrollTo).toHaveBeenCalledExactlyOnceWith({ top: 702, behavior: 'instant' })
    expect(f.scrollIntoView).not.toHaveBeenCalled()
  })

  it('搜索命中居中，不滚动其他祖先', () => {
    const f = fixture()
    scrollWithin(f.scroller, f.target, 'center')
    expect(f.scrollTo).toHaveBeenCalledExactlyOnceWith({ top: 438, behavior: 'instant' })
    expect(f.scrollIntoView).not.toHaveBeenCalled()
  })

  it('超过视口的搜索块从顶部显示', () => {
    const f = fixture(520, 900)
    scrollWithin(f.scroller, f.target, 'center')
    expect(f.scrollTo).toHaveBeenCalledWith({ top: 718, behavior: 'instant' })
  })

  it('目标接近文首时不产生负滚动位置', () => {
    const f = fixture(-190)
    scrollWithin(f.scroller, f.target, 'center')
    expect(f.scrollTo).toHaveBeenCalledWith({ top: 0, behavior: 'instant' })
  })
})
