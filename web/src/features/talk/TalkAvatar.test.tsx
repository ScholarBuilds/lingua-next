import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it, vi } from 'vitest'

import { TalkAvatar } from './TalkAvatar'

it('renders a 3D stage and a loading state without sampling audio during React rendering', () => {
  const readLevel = vi.fn()
  const html = renderToStaticMarkup(<TalkAvatar status="listening" readLevel={readLevel} />)
  expect(html).toContain('talk-avatar-canvas')
  expect(html).toContain('正在准备数字人')
  expect(html).toContain('语音和字幕不受影响')
  expect(html).not.toContain('talk-portrait')
  expect(readLevel).not.toHaveBeenCalled()
})
