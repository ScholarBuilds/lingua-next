/* 提示词草稿进 innerHTML 之前的转义守卫。
 *
   这条是真出过事的路径：`html: node.prompt_draft_html ?? draft` —— 没存过 html 的节点
   会把**纯文本草稿**当 html 交给 `el.innerHTML`。后果两级：
   轻的是 `a < b` 进框变形，重的是词库里一条带 `<img onerror>` 的条目直接执行脚本。

   现在调用方走 mentionFromText 升格（正路），组件里再加一道 safeHtml 兜底（保险）。
   两道都得有：正路会被下一个调用方绕过，兜底不会。 */

import { describe, expect, it } from 'vitest'

import { mentionFromText } from './MentionInput'

describe('mentionFromText · 纯文本升格', () => {
  it('尖括号被转义，不会当标签解析', () => {
    const v = mentionFromText('a < b && c > d')
    expect(v.html).not.toContain('<b')
    expect(v.html).toContain('&lt;')
    expect(v.html).toContain('&gt;')
  })

  it('带 onerror 的 img 变成可见文字而不是可执行标签', () => {
    const v = mentionFromText('<img src=x onerror=alert(1)>')
    expect(v.html).not.toMatch(/<img/i)
    expect(v.html).toContain('&lt;img')
  })

  it('引号也转义——它们会从属性里逃出去', () => {
    const v = mentionFromText('say "hi" and \'bye\'')
    expect(v.html).not.toContain('"hi"')
  })

  it('换行变成 <br>，这是唯一允许生成的标签', () => {
    const v = mentionFromText('第一行\n第二行')
    expect(v.html).toContain('<br>')
    expect(v.text).toBe('第一行\n第二行')
  })

  it('text 保持原样，只有 html 被转义——发给模型的是 text', () => {
    const raw = '<b>粗</b> & 特殊 < 字符'
    expect(mentionFromText(raw).text).toBe(raw)
  })

  it('空串不产出任何标记', () => {
    const v = mentionFromText('')
    expect(v.html).toBe('')
    expect(v.refs).toEqual([])
  })

  it('纯文本升格后没有引用——它本来就没有 @ 芯片', () => {
    expect(mentionFromText('随便一段话').refs).toEqual([])
  })
})
