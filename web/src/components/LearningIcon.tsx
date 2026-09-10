import type { CSSProperties, HTMLAttributes } from 'react'

export type LearningGlyph =
  | 'play'
  | 'pause'
  | 'previous-sentence'
  | 'next-sentence'
  | 'speed'
  | 'voice'
  | 'captions'
  | 'focus-sentence'
  | 'restart'
  | 'ab-loop'
  | 'repeat-sentence'
  | 'interval'
  | 'translate'
  | 'reply-suggestions'
  | 'word-card'
  | 'collect-word'

const CELLS: Record<LearningGlyph, readonly [number, number]> = {
  play: [0, 0],
  pause: [1, 0],
  'previous-sentence': [2, 0],
  'next-sentence': [3, 0],
  speed: [0, 1],
  voice: [1, 1],
  captions: [2, 1],
  'focus-sentence': [3, 1],
  restart: [0, 2],
  'ab-loop': [1, 2],
  'repeat-sentence': [2, 2],
  interval: [3, 2],
  translate: [0, 3],
  'reply-suggestions': [1, 3],
  'word-card': [2, 3],
  'collect-word': [3, 3],
}

interface LearningIconProps extends HTMLAttributes<HTMLSpanElement> {
  name: LearningGlyph
  size?: number
}

export function LearningIcon({ name, size = 22, className = '', style, ...props }: LearningIconProps) {
  const [column, row] = CELLS[name]
  return (
    <span
      {...props}
      className={`learning-icon${className ? ` ${className}` : ''}`}
      style={{
        width: size,
        height: size,
        backgroundImage: 'url(/brand/image2/learning-action-atlas.webp)',
        backgroundPosition: `${(column * 100) / 3}% ${(row * 100) / 3}%`,
        backgroundSize: '400% 400%',
        ...style,
      } as CSSProperties}
      aria-hidden
    />
  )
}
