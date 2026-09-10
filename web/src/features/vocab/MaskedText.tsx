/* 词卡遮挡：藏中文 / 藏英文时把一边盖住，点一下揭开这一张。

   > [!danger] 遮挡必须是原元素身上的一个类，不能加包裹元素
   >
   > 第一版包了一层 `<span class="mk">`（inline-block + 背景），布局当场变了：
   > `.dd-tile-trans` 是 `display: -webkit-box` + `-webkit-line-clamp: 2`，
   > 而 clamp 数的是**行盒**。塞进去一个 inline-block，整段文字变成一个
   > 不可断的原子子项，clamp 失效、块被撑高，于是开关一开一关卡片就变高、
   > 整片网格跟着跳。inline-block 自带的基线间隙又额外加了几像素。
   >
   > 现在只往原元素上加一个类：`position: relative`（不改流）
   > + `color: transparent`（不改字号行高）+ 绝对定位的 `::after` 遮罩（脱流）。
   > 三样都不参与布局计算，masked 与不 masked 的盒子逐像素一致。

   > [!info] 揭开是整张卡，不是单个字段
   >
   > 一张卡上有单词、音标、释义、例句、译文，藏中文时其中两块被盖。
   > 逐块揭开的话，用户要核对一个词得点两次；而「揭开全部」又等于没开。
   > 所以状态挂在卡上：点任意一块被盖的地方，这张卡的被盖部分一起亮出来。 */

import { useEffect, useState } from 'react'
import { useDeckSelfTest } from './DeckSelfTest'

/** 遮哪一边。两个开关互斥，三态足够表达 */
export type MaskMode = 'none' | 'zh' | 'en'

export interface CardMask {
  /** 拼到原元素 className 后面，没遮就是空串 */
  cls: (side: 'zh' | 'en') => string
  /** 被遮的元素要挂上它：吃掉冒泡，否则「看一眼答案」会顺带打开词卡详情 */
  bind: (side: 'zh' | 'en') => {
    onClickCapture?: (e: React.MouseEvent) => void
    onKeyDown?: (e: React.KeyboardEvent) => void
    role?: 'button'
    tabIndex?: number
    title?: string
    'aria-label'?: string
  }
}

const HINT: Record<'zh' | 'en', string> = {
  zh: '点一下看中文',
  en: '点一下看英文',
}

export function useCardMask(mask: MaskMode, word?: string): CardMask {
  const selfTest = useDeckSelfTest()
  const [revealed, setRevealed] = useState(false)

  // 换开关时收回来。不重置的话，藏中文时揭开过的卡，切到藏英文仍是揭开的
  useEffect(() => {
    setRevealed(false)
  }, [mask])

  const hiddenSide = (selfTest && word ? selfTest.revealed.has(word) : revealed) ? 'none' : mask
  const reveal = () => {
    setRevealed(true)
    if (word) selfTest?.reveal(word)
  }

  return {
    cls: (side) => (hiddenSide === side ? ' mk' : ''),
    bind: (side) =>
      hiddenSide === side
        ? {
            onClickCapture: (e: React.MouseEvent) => {
              e.stopPropagation()
              reveal()
            },
            onKeyDown: (e: React.KeyboardEvent) => {
              if (e.key === ' ' && selfTest) return
              if (e.key !== 'Enter' && e.key !== ' ') return
              e.preventDefault()
              e.stopPropagation()
              reveal()
            },
            role: 'button',
            tabIndex: 0,
            title: HINT[side],
            'aria-label': HINT[side],
          }
        : {},
  }
}
