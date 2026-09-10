/* 把一段英文切成句，并造出 `SentencePanel` 要的选中态。

   放在这里而不是各功能里各写一份：讲义库的右键解析、场景短文的段落解析、
   将来任何「这段话给我拆开讲」的入口都要同一套判据——切法不一致的话，
   同一句在两个地方会被分析成不同的东西，缓存键也对不上。

   > [!danger] 句号不等于句末
   >
   > `Mr. Smith`、`3.5 hours`、`U.S.` 都带句点。按 `.` 硬切会把一句话
   > 拆成三段，分析出来的语法结构全是残句——而且不报错，只是讲得不知所云。 */

import type { SentenceSelection } from './readerStore'

/* 后面跟空格 + 大写才算句末；小数点、句点后跟小写靠前瞻挡掉。
   **收尾引号写在后顾断言里而不是分隔符里**——写在分隔符里会被当成
   分隔内容吃掉，`She said "hello." Then…` 切完第一句尾巴上的引号就没了。 */
const SENT_SPLIT = /(?<=[.!?]["'”’)\]]{0,2})\s+(?=["'“‘(\[]*[A-Z0-9])/

/* 常见缩写：切完之后若某段以它们结尾，说明切错了，粘回去。
   只列真会出现在学习语料里的，不做全量词典——列不全的代价是偶尔多切一刀，
   而列错会把真正的句末粘掉，后者更糟。 */
const ABBREV = /\b(Mr|Mrs|Ms|Dr|Prof|St|Jr|Sr|vs|etc|e\.g|i\.e|U\.S|a\.m|p\.m)\.$/i

export function splitSentences(text: string): string[] {
  const raw = text.trim()
  if (raw === '') return []
  const parts = raw.split(SENT_SPLIT)
  const out: string[] = []
  for (const part of parts) {
    const piece = part.trim()
    if (piece === '') continue
    const prev = out[out.length - 1]
    // 上一段以缩写结尾 = 上一刀切错了，粘回去
    if (prev !== undefined && ABBREV.test(prev)) out[out.length - 1] = `${prev} ${piece}`
    else out.push(piece)
  }
  return out
}

/** 文本哈希：`SentencePanel` 的会话缓存按它去重。

    这些句子没有服务端句 id（讲义、场景短文都是即时文本），用内容本身的
    短哈希即可——同文本命中同一份缓存，正是想要的。 */
export function sentenceSel(text: string): SentenceSelection {
  let h = 0
  for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) | 0
  return { sentenceId: -1, paragraphId: -1, hash: `txt-${h}`, text }
}
