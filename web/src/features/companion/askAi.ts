/* 「问 AI」统一入口（需求 07 v2 FR-12/14/22）。

   文章页与视频页共用：把一段文本显式加入陪读上下文，必要时顺带把陪读面板打开。
   会话未起时只入卡不强行开麦——用户可能想先攒几句再一起问。 */

import type { CompanionRef, RefKind } from './contextStore'
import { useCompanionContext } from './contextStore'

/** ms → mm:ss（视频出处标签） */
function clock(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000))
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`
}

export function askAboutSentence(opts: {
  /** 句子/学习句 id，用于去重 */
  id: number | string
  text: string
  /** 视频：起始毫秒；文章：段落序号 */
  startMs?: number
  ordinal?: number
}): void {
  const source =
    opts.startMs !== undefined
      ? clock(opts.startMs)
      : opts.ordinal !== undefined
        ? `第 ${opts.ordinal + 1} 句`
        : '正文'
  useCompanionContext.getState().addRef({
    key: `s:${opts.id}`,
    text: opts.text.trim(),
    source,
    kind: 'sentence',
  })
}

export function askAboutSelection(text: string, source = '选区'): void {
  const trimmed = text.trim()
  if (trimmed === '') return
  useCompanionContext.getState().addRef({
    key: `sel:${trimmed.slice(0, 48)}`,
    text: trimmed,
    source,
    kind: 'selection',
  })
}

/** 跟读比对结果交给陪读点评（FR-22）：把漏读/错读词一并交代清楚 */
export function askAboutShadowing(opts: {
  unitId: number
  reference: string
  items: Array<{ word: string; status: string; got?: string }>
  accuracy: number
}): void {
  const missed = opts.items.filter((i) => i.status === 'miss').map((i) => i.word)
  const wrong = opts.items
    .filter((i) => i.status === 'wrong')
    .map((i) => `${i.word}→${i.got ?? '?'}`)
  const parts = [`正确率 ${opts.accuracy}%`]
  if (missed.length) parts.push(`漏读：${missed.join(' ')}`)
  if (wrong.length) parts.push(`读错：${wrong.join(' ')}`)
  parts.push('请针对这些词点评发音并给纠正建议。')
  useCompanionContext.getState().addRef({
    key: `sh:${opts.unitId}`,
    text: opts.reference,
    source: '跟读录音',
    kind: 'shadow',
    note: parts.join('；'),
  })
}

export type { CompanionRef, RefKind }
