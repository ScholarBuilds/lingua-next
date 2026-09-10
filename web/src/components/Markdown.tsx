/* AI 生成内容的统一 Markdown 渲染（FR-351、BR-81）。

   原先各处要么纯文本 `white-space: pre-wrap`（`**粗体**` 原样露出来），
   要么用手搓的正则版 markdownLite——只认粗体/行内码/列表/引用/标题，
   表格、有序列表、链接、嵌套一概漏。AI 输出什么语法不受我们控制，
   所以换成 react-markdown + remark-gfm（GFM 全集），不再自己维护解析器。 */

import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

interface MarkdownProps {
  text: string
  className?: string
}

export function Markdown({ text, className = '' }: MarkdownProps) {
  return (
    <div className={`md ${className}`.trim()}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          // 外链一律新窗口打开，且断掉 opener 引用
          a: ({ node: _n, ...props }) => (
            <a {...props} target="_blank" rel="noreferrer noopener" />
          ),
          // 宽表格自己横向滚，不把弹窗撑破
          table: ({ node: _n, ...props }) => (
            <div className="md-table-wrap">
              <table {...props} />
            </div>
          ),
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  )
}
