import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { LearningIcon } from './LearningIcon'
import { VocabCoverArtwork, vocabCoverCell } from '../features/vocab/VocabCover'

describe('learning Image2 assets', () => {
  it('maps a learning action to the stable 4x4 atlas', () => {
    const html = renderToStaticMarkup(<LearningIcon name="reply-suggestions" />)
    expect(html).toContain('/brand/image2/learning-action-atlas.webp')
    expect(html).toContain('background-size:400% 400%')
  })

  it('maps built-in and scenario decks without replacing unknown custom covers', () => {
    expect(vocabCoverCell({ key: 'cet6', name: '六级' })).toEqual([4, 0])
    expect(vocabCoverCell({ key: 'scene-cafe', name: '咖啡馆点单' })).toEqual([4, 1])
    expect(vocabCoverCell({ key: 'personal', name: '我的旅行短语' })).toBeNull()

    const html = renderToStaticMarkup(
      <VocabCoverArtwork deck={{ key: 'scene-goodbye', name: '告别' }} />,
    )
    expect(html).toContain('/brand/image2/vocab-cover-atlas.webp')
    expect(html).toContain('viewBox="1228.8 768 307.2 256"')
    expect(html).toContain('preserveAspectRatio="xMidYMid slice"')
  })
})
