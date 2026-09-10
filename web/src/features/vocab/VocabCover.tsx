import type { HTMLAttributes } from 'react'

import type { Deck } from '../../lib/api-deck'

const KEY_CELLS: Record<string, readonly [number, number]> = {
  __vocab__: [0, 0],
  zk: [1, 0],
  gk: [2, 0],
  cet4: [3, 0],
  cet6: [4, 0],
  ky: [0, 1],
  toefl: [1, 1],
  ielts: [2, 1],
  gre: [3, 1],
}

const NAME_CELLS: Record<string, readonly [number, number]> = {
  生词本: [0, 0],
  中考: [1, 0],
  高考: [2, 0],
  四级: [3, 0],
  六级: [4, 0],
  考研: [0, 1],
  托福: [1, 1],
  雅思: [2, 1],
  GRE: [3, 1],
  咖啡馆点单: [4, 1],
  超市购物: [0, 2],
  餐厅点餐: [1, 2],
  编程通用: [2, 2],
  面试: [3, 2],
  问候寒暄: [4, 2],
  自我介绍: [0, 3],
  邀约: [1, 3],
  道歉与感谢: [2, 3],
  闲聊话题: [3, 3],
  告别: [4, 3],
}

export function vocabCoverCell(deck: Pick<Deck, 'key' | 'name'>): readonly [number, number] | null {
  return KEY_CELLS[deck.key] ?? NAME_CELLS[deck.name.trim()] ?? null
}

interface VocabCoverArtworkProps extends HTMLAttributes<HTMLSpanElement> {
  deck: Pick<Deck, 'key' | 'name'>
}

export function VocabCoverArtwork({ deck, className = '', style, ...props }: VocabCoverArtworkProps) {
  const cell = vocabCoverCell(deck)
  if (cell === null) return null
  const [column, row] = cell
  return (
    <span
      {...props}
      className={`vocab-cover-art${className ? ` ${className}` : ''}`}
      style={style}
      aria-hidden
    >
      <svg viewBox={`${column * 307.2} ${row * 256} 307.2 256`} preserveAspectRatio="xMidYMid slice" focusable="false">
        <image href="/brand/image2/vocab-cover-atlas.webp" width="1536" height="1024" />
      </svg>
    </span>
  )
}
