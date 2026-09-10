/* 右栏英文词元化（M5 反馈迭代）：把纯文本中的英文单词渲染为可点词，
   点击打开中央词卡。只包裹纯文本内容，交互元素（按钮/下拉等）由调用方天然跳过。 */

import type { ReactNode } from 'react'

import { useReaderStore } from './readerStore'
import { useWordModalStore } from './wordModalStore'

/** 拆词：字母开头 + 撇号/连字符（don't、well-known），单字母不当词 */
const WORD_SPLIT_RE = /([A-Za-z][A-Za-z'-]+)/g

/** 语境上限：防止整段长文塞给 AI 语境释义 */
const CONTEXT_MAX = 400

interface ClickableEnProps {
  text: string
  /** 该词所在句 / 段文本，作为词卡 AI 语境；缺省用 text 自身 */
  context?: string
  /** 中央词卡内部用：无视右栏开关恒可点 */
  force?: boolean
}

export function ClickableEn({ text, context, force = false }: ClickableEnProps) {
  const enabled = useReaderStore((s) => s.clickableWords)
  const openWord = useWordModalStore((s) => s.openWord)

  if (!force && !enabled) return <>{text}</>
  const parts = text.split(WORD_SPLIT_RE)
  if (parts.length <= 1) return <>{text}</>
  const ctx = (context ?? text).slice(0, CONTEXT_MAX)

  const out: ReactNode[] = parts.map((part, i) =>
    // split 捕获组：奇数下标为命中的单词
    i % 2 === 1 ? (
      <span
        key={i}
        className="rt-w"
        onClick={(e) => {
          e.stopPropagation()
          openWord(part, ctx)
        }}
      >
        {part}
      </span>
    ) : (
      part
    ),
  )
  return <>{out}</>
}
