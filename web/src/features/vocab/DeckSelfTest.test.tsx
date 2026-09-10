import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import type { DeckFilter, DeckItem } from '../../lib/api-deck'
import { DeckSelfTest } from './DeckSelfTest'
import { useCardMask } from './MaskedText'

const item: DeckItem = {
  word: 'example', phonetic: null, translation: '例子', definition: null,
  frq: null, freq_band: null, tags: [], collins: null, exchange: null,
  status: 'learning', bucket: 'learning', difficult: true, mark: 'hard',
  vocab_id: null, due_at: null, group_key: null, example_en: null,
  example_zh: null, dict_miss: false,
}

function MaskedAnswer() {
  const mask = useCardMask('zh', item.word)
  return <span className={mask.cls('zh')} {...mask.bind('zh')}>{item.translation}</span>
}

describe('词汇遮挡自测', () => {
  it.each<DeckFilter>(['all', 'new', 'learning', 'mastered', 'difficult'])('在 %s 分类提供自测入口且未选词时禁用标记', filter => {
    const html = renderToStaticMarkup(<DeckSelfTest enabled filter={filter} items={[]} onMark={async () => {}} onOpenWord={() => {}}>{() => null}</DeckSelfTest>)
    expect(html).toContain('aria-label="遮挡自测"')
    expect(html).toContain('disabled="">1 学习中')
    expect(html).toContain('disabled="">2 困难词')
    expect(html).toContain('disabled="">3 已掌握')
    expect(html).toContain('disabled="">空格 查看答案')
    expect(html).toContain('disabled="">V 打开词卡')
    expect(html).toContain('Esc 关闭词卡')
  })

  it('自测与普通浏览保留相同的服务端筛选结果', () => {
    for (const enabled of [true, false]) {
      const html = renderToStaticMarkup(<DeckSelfTest enabled={enabled} filter="learning" items={[item]} onMark={async () => {}} onOpenWord={() => {}}>{items => <span>{items.length} 个词</span>}</DeckSelfTest>)
      expect(html).toContain('1 个词')
      if (!enabled) expect(html).not.toContain('aria-label="遮挡自测"')
    }
  })

  it('遮挡直接绑定原元素并提供可聚焦的揭示入口', () => {
    const html = renderToStaticMarkup(<MaskedAnswer />)
    expect(html).toBe('<span class=" mk" role="button" tabindex="0" title="点一下看中文" aria-label="点一下看中文">例子</span>')
  })
})
