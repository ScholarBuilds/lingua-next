/* 拖选浮动工具条（需求 07 v2 FR-14）。

   在正文/字幕里拖选任意文本即弹出：问 AI / 查词组 / 朗读。覆盖单句按钮够不着的
   场景——半句、跨句、任意片段。Kindle / Readwise / Glasp 同范式。

   挂在容器上而非全局：避免在输入框、词卡、设置页里误弹。 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { RefObject } from 'react'

import { IconSparkle, IconSpeaker } from '../../components/icons'
import { playTts } from '../../lib/audio'
import { askAboutSelection } from './askAi'

interface Pos {
  x: number
  y: number
  text: string
}

/** 选区上限：整段以上交给"全文上下文"更合适，工具条只服务片段 */
const MAX_CHARS = 400

interface SelectionBarProps {
  /** 只在该容器内的选区才弹条 */
  containerRef: RefObject<HTMLElement | null>
  /** 出处标签（"03:21" / "第 3 段"），随引用卡展示 */
  source?: string
  /** 查词组：交给调用方走 phrase 分析 */
  onPhrase?: (text: string) => void
}

export function SelectionBar({ containerRef, source, onPhrase }: SelectionBarProps) {
  const [pos, setPos] = useState<Pos | null>(null)
  const barRef = useRef<HTMLDivElement>(null)

  const close = useCallback(() => setPos(null), [])

  useEffect(() => {
    const container = containerRef.current
    if (container === null) return

    const onUp = (e: MouseEvent) => {
      if (barRef.current?.contains(e.target as Node)) return // 点工具条本身不重算
      const sel = window.getSelection()
      const text = sel?.toString() ?? ''
      if (sel === null || sel.isCollapsed || text.trim() === '') {
        setPos(null)
        return
      }
      const anchor = sel.anchorNode
      if (anchor === null || !container.contains(anchor)) {
        setPos(null)
        return
      }
      // 选中英文才有意义（纯中文译文选区不弹）
      if (!/[A-Za-z]{2,}/.test(text)) {
        setPos(null)
        return
      }
      const rect = sel.getRangeAt(0).getBoundingClientRect()
      setPos({
        x: Math.min(Math.max(rect.left + rect.width / 2, 90), window.innerWidth - 90),
        y: Math.max(rect.top - 8, 44),
        text: text.trim().slice(0, MAX_CHARS),
      })
    }

    const onDown = (e: MouseEvent) => {
      if (!barRef.current?.contains(e.target as Node)) setPos(null)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setPos(null)
    }

    document.addEventListener('mouseup', onUp)
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    window.addEventListener('scroll', close, true)
    return () => {
      document.removeEventListener('mouseup', onUp)
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
      window.removeEventListener('scroll', close, true)
    }
  }, [containerRef, close])

  if (pos === null) return null

  const run = (fn: () => void) => {
    fn()
    window.getSelection()?.removeAllRanges()
    setPos(null)
  }

  return (
    <div
      ref={barRef}
      className="sel-bar"
      style={{ left: pos.x, top: pos.y, transform: 'translate(-50%, -100%)' }}
    >
      <button title="把这段交给 AI 陪读" onClick={() => run(() => askAboutSelection(pos.text, source))}>
        <IconSparkle />
        问 AI
      </button>
      {onPhrase !== undefined && (
        <>
          <span className="sep" />
          <button title="按词组解释这段" onClick={() => run(() => onPhrase(pos.text))}>
            查词组
          </button>
        </>
      )}
      <span className="sep" />
      <button title="朗读所选" onClick={() => run(() => playTts(pos.text, 'word'))}>
        <IconSpeaker />
      </button>
    </div>
  )
}
