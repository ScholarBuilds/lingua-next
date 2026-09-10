import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'

vi.mock('./library/GrammarLibrary', () => ({
  GrammarLibrary: ({ collection, libraryId }: { collection: string; libraryId?: string }) => <div>library:{collection}:{libraryId}</div>,
}))
vi.mock('./library/SoftwareLibraryPicker', () => ({
  SoftwareLibraryPicker: () => <div>software-picker</div>,
}))

import { GrammarPage } from './GrammarPage'

describe('英语讲义分类', () => {
  it.each(['column', 'vocabulary', 'patterns', 'scenes'])('四个普通入口共用讲义阅读器：%s', tab => {
    const html = renderToStaticMarkup(<MemoryRouter initialEntries={[`/grammar?tab=${tab}`]}><GrammarPage /></MemoryRouter>)
    for (const label of ['英语基础语法', '英语词汇', '英语句型手册', '英语场景', '软件英语']) expect(html).toContain(label)
    for (const label of ['语法点', '句子实验室', '写作纠错', '错题本']) expect(html).not.toContain(label)
    expect(html).toContain(`library:${tab === 'column' ? 'grammar' : tab}:`)
  })

  it('软件英语入口先显示软件库，带软件参数时才进入阅读器', () => {
    const picker = renderToStaticMarkup(<MemoryRouter initialEntries={['/grammar?tab=software']}><GrammarPage /></MemoryRouter>)
    expect(picker).toContain('software-picker')
    expect(picker).not.toContain('library:software')
    const reader = renderToStaticMarkup(<MemoryRouter initialEntries={['/grammar?tab=software&software=macos-system-settings&doc=lesson.md']}><GrammarPage /></MemoryRouter>)
    expect(reader).toContain('library:software:macos-system-settings')
  })
})
