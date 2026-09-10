import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it } from 'vitest'

import { TalkWordText } from './TalkWordText'
import { useWordModalStore } from '../reader/wordModalStore'

describe('TalkWordText', () => {
  beforeEach(() => useWordModalStore.getState().close())
  it('preserves mixed-language text and keeps contractions as one word', () => {
    const html = renderToStaticMarkup(
      <TalkWordText
        text="试试：I'd like to check-in."
      />,
    )
    expect(html.match(/<button/g)).toHaveLength(4)
    expect(html).toContain('试试：')
    expect(html).toContain('title="查看 check-in 的单词卡"')
    expect(html.replace(/<[^>]*>/g, '')).toBe('试试：I&#x27;d like to check-in.')
  })

  it('selects the normalized word without submitting a reply', () => {
    const element = TalkWordText({ text: 'Reservation' })
    const button = element.props.children.find((child: unknown) => typeof child === 'object')
    button.props.onClick()
    expect(useWordModalStore.getState().stack).toEqual([{ kind: 'word', word: 'reservation', surface: 'Reservation', context: 'Reservation' }])
  })

  it('preserves the dictionary headword for the first-person pronoun', () => {
    const element = TalkWordText({ text: 'I' })
    const button = element.props.children.find((child: unknown) => typeof child === 'object')
    button.props.onClick()
    expect(useWordModalStore.getState().stack[0]).toMatchObject({ surface: 'I', context: 'I' })
    expect(button.props.type).toBe('button')
  })
})
