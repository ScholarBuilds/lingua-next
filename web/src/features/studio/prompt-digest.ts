/* 列表项那一行摘要，与详情栏的篇幅统计。

   起因是列表里挑不出东西：这些模板的正文动辄两三百词英文，卡片上截三行看到的是
   `a cinematic portrait of {{主体}}, shot on 85mm, shallow depth of field, golden…`，
   两条「人像」模板截出来的前三行几乎一模一样，一眼分不出哪条是要的。

   两条口径：
   - **有「适用场景」就用它**。它是人写的中文一句话，说清什么时候用——正是列表里
     该显示的东西。摘要只在没写场景时才登场，并且要让人看出这是正文摘要不是用途，
     否则用户会以为自己写过说明。
   - **摘要按分句切，不按字数硬截**。硬截会把 `85mm, shallow depth of` 这种半截短语
     摆到列表上，读起来比不显示还糟。 */

/** 提示词的篇幅。词数按空白切——正向提示词绝大多数是英文短语流，
    词数比字符数更贴近「这条有多长」的直觉；中文正文回落到字符数那一栏去看。 */
export interface PromptStats {
  chars: number
  words: number
  lines: number
}

export function promptStats(text: string): PromptStats {
  const body = text ?? ''
  const trimmed = body.trim()
  return {
    chars: body.length,
    words: trimmed === '' ? 0 : trimmed.split(/\s+/).length,
    lines: body === '' ? 0 : body.split('\n').length,
  }
}

/** 分句切开。中英文的逗号句号分号换行都算——提示词是短语流，逗号才是主分隔符。 */
function clauses(text: string): string[] {
  return text
    .split(/[,，.。;；\n]+/)
    .map((part) => part.trim())
    .filter((part) => part !== '')
}

/** 正文摘要：按分句攒到 `limit` 为止，攒不满一句也至少给一句（硬截兜底）。

    单句就超长时才硬截——那种正文本来就没有可读的切点，给个带省略号的开头
    比什么都不显示强。 */
export function promptSummary(body: string, limit = 72): string {
  // 只压空格与制表符，换行留给 clauses 当分隔符：多段式提示词的换行就是分句处，
  // 先压成空格的话「第一段 第二段」会被当成一句攒进来
  const parts = clauses((body ?? '').replace(/[^\S\n]+/g, ' '))
  if (parts.length === 0) return ''
  let out = ''
  for (const part of parts) {
    if (out === '') {
      out = part
      if (out.length >= limit) return `${out.slice(0, limit)}…`
      continue
    }
    if (out.length + part.length + 2 > limit) return `${out}…`
    out = `${out}, ${part}`
  }
  return out
}

export interface PromptDigest {
  text: string
  /** 这行字是人写的「适用场景」还是从正文现摘的。界面据此决定要不要标一下——
      不标的话用户会以为自己给这条写过用途说明 */
  fromScene: boolean
}

/** 列表项显示哪一行。场景优先，没写才摘正文。 */
export function promptDigest(item: { scene: string; body: string }, limit = 72): PromptDigest {
  const scene = (item.scene ?? '').trim()
  if (scene !== '') return { text: scene, fromScene: true }
  return { text: promptSummary(item.body ?? '', limit), fromScene: false }
}
