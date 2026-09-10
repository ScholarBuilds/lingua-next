/* 陪读回答的轻量 Markdown 渲染（M5-FA）：粗体 / 行内代码 / 列表 / 引用 / 标题。
   正则级实现，不引第三方库；未覆盖的语法按原文纯文本展示。
   clickWords 开启时纯文本经词元化组件渲染为可点词（语境取所在行）。 */

import { Fragment } from 'react'
import type { ReactNode } from 'react'

import { ClickableEn } from './ClickableEn'

const INLINE_RE = /(\*\*[^*]+\*\*|`[^`]+`)/g

function renderInline(
  text: string,
  keyPrefix: string,
  clickWords: boolean,
  contextLine: string,
): ReactNode[] {
  const out: ReactNode[] = []
  const plain = (t: string, key: string): ReactNode =>
    clickWords ? <ClickableEn key={key} text={t} context={contextLine} /> : (
      <Fragment key={key}>{t}</Fragment>
    )
  const parts = text.split(INLINE_RE)
  parts.forEach((part, i) => {
    if (part === '') return
    if (part.startsWith('**') && part.endsWith('**') && part.length > 4) {
      out.push(<b key={`${keyPrefix}-${i}`}>{plain(part.slice(2, -2), 'b')}</b>)
    } else if (part.startsWith('`') && part.endsWith('`') && part.length > 2) {
      out.push(<code key={`${keyPrefix}-${i}`}>{plain(part.slice(1, -1), 'c')}</code>)
    } else {
      out.push(plain(part, `${keyPrefix}-${i}`))
    }
  })
  return out
}

export function MarkdownLite({
  text,
  clickWords = false,
}: {
  text: string
  /** 英文可点词（打开中央词卡；是否生效仍受右栏开关控制） */
  clickWords?: boolean
}) {
  const lines = text.split('\n')
  const blocks: ReactNode[] = []
  let listBuf: ReactNode[] = []

  const flushList = (key: string) => {
    if (listBuf.length === 0) return
    blocks.push(<ul key={key}>{listBuf}</ul>)
    listBuf = []
  }

  lines.forEach((line, i) => {
    const trimmed = line.trim()
    const listMatch = /^([-*]|\d+[.)])\s+(.*)$/.exec(trimmed)
    if (listMatch) {
      listBuf.push(
        <li key={`li-${i}`}>{renderInline(listMatch[2], `li-${i}`, clickWords, listMatch[2])}</li>,
      )
      return
    }
    flushList(`ul-${i}`)
    if (trimmed === '') return
    const heading = /^#{1,4}\s+(.*)$/.exec(trimmed)
    if (heading) {
      blocks.push(
        <div key={`h-${i}`} className="md-h">
          {renderInline(heading[1], `h-${i}`, clickWords, heading[1])}
        </div>,
      )
      return
    }
    if (trimmed.startsWith('> ')) {
      blocks.push(
        <blockquote key={`q-${i}`}>
          {renderInline(trimmed.slice(2), `q-${i}`, clickWords, trimmed.slice(2))}
        </blockquote>,
      )
      return
    }
    blocks.push(<p key={`p-${i}`}>{renderInline(trimmed, `p-${i}`, clickWords, trimmed)}</p>)
  })
  flushList('ul-tail')

  return <div className="md-lite">{blocks}</div>
}
