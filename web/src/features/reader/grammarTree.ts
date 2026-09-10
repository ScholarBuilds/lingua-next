/* AI 语法分析的 `components` 是一棵树被拍平成的列表，这里把它还原回树。

   模型返回的是**先序**序列：一个成分，紧跟它内部的下级成分，然后是下一个平级成分。
   实测线上缓存 17 条里 11 条（64.7%）是两层甚至三层的，例如

     并列分句1  "I'm from Hangzhou"      ← 第 1 层
     主语+系动词 "I'm"                    ← 第 2 层，在上一条里面
     表语       "from Hangzhou"          ← 第 2 层，在上一条里面
     并列连词   "and"
     并列分句2  "I live in Shanghai now" ← 第 1 层

   > [!danger] 按列表平铺会让整句出现两遍
   >
   > 渲染器原先直接 `components.map(...)` 串成一行，于是「I'm from Hangzhou」
   > 先作为分句出现一次，再被拆成「I'm」「from Hangzhou」出现第二次。

   > [!danger] 不能靠字符串包含关系猜父子
   >
   > 第一版用「a 的文字是不是 b 的文字的子串」判嵌套，被真实数据打穿两处：
   > ① `in possession of a good fortune` 在父串里紧跟一个逗号（`fortune, must be`），
   >    按词边界比对要求两侧是空格，判不出来 → 掉回根层 → 重复；
   > ② `at last`、`Lady Lucas` 是模型**乱序追加**的回指片段（下标 14/15，父在 11/13），
   >    单调栈那时已经把父弹掉了。
   > 还有第三类：`and` 这种短词在句中出现多次，纯文本包含根本分不清是哪一个。
   >
   > 所以改成**按位置**：先把每个成分定位到原句的字符区间，再用区间包含关系建树。
   > 区间没有歧义，标点、乱序、重复短词三类问题一次消掉。

   渲染侧的不变量因此变成结构性的：**渲染的就是原句本身，只是给区间上色**，
   重复和丢字在构造上不可能发生。 */

import type { GrammarComponent } from '../../lib/api'

export interface GramNode {
  text: string
  role: string
  /** 模型给的补充说明，原样带到渲染层做悬停提示 */
  note?: string
  /** 在原句中的字符区间 [start, end) */
  start: number
  end: number
  children: GramNode[]
}

/* 只统一弯直引号，**逐字符等长替换**，所以偏移量与原串一一对应，
   定位到的下标可以直接拿回原句切片。折叠空白会打乱下标，故不做。 */
function normQuotes(s: string): string {
  return s.replace(/[‘’]/g, "'").replace(/[“”]/g, '"')
}

/** 把成分列表按在原句中的位置还原成树。

    分两趟走，别混在一起——第一版混着做就错了：栈在定位的同时建树，
    模型乱序追加的 `at last`（下标 14，父在 11）来的时候父早被弹掉了，
    于是它以正确的位置挂在了错误的层级上。

    1. 定位：每个成分找到自己在原句里的字符区间。同一段文字在句中出现多次时
       （`and` 在这句里有两个）靠三级回退区分：
       先从上一个成分的**终点**往后找（平级成分总在前一个之后），
       再从上一个成分的**起点**往后找（子成分总在父的起点之后、终点之前），
       最后全句兜一次（模型偶尔把成分顺序整个写反）。
       次序不能反：先起点会让分句层的 `and` 命中前一个列表里那个。
    2. 建树：只看区间包含关系。区间没有歧义，标点、乱序、重复短词三类问题一次消掉。

    定位不到的成分直接丢弃——宁可少展示一个成分，也不能凭空造出原句里没有的文字。 */
export function layoutComponents(
  sentence: string,
  components: readonly GrammarComponent[] | undefined,
): GramNode[] {
  const hay = normQuotes(sentence)

  // ---- 第 1 趟：定位 ----
  const placed: GramNode[] = []
  let prevStart = 0
  let prevEnd = 0
  for (const c of components ?? []) {
    const needle = normQuotes(c?.text ?? '').trim()
    if (needle === '') continue
    let at = hay.indexOf(needle, prevEnd)
    if (at < 0) at = hay.indexOf(needle, prevStart)
    if (at < 0) at = hay.indexOf(needle)
    if (at < 0) continue
    placed.push({
      text: sentence.slice(at, at + needle.length),
      role: c.role ?? '',
      note: c.note,
      start: at,
      end: at + needle.length,
      children: [],
    })
    prevStart = at
    prevEnd = at + needle.length
  }

  // ---- 第 2 趟：按区间包含建树 ----
  // 起点升序、同起点长的在前，父必然排在自己的孩子前面
  placed.sort((a, b) => a.start - b.start || b.end - a.end)
  const roots: GramNode[] = []
  const stack: GramNode[] = []
  for (const node of placed) {
    while (stack.length > 0 && stack[stack.length - 1].end <= node.start) stack.pop()
    const top = stack[stack.length - 1]
    if (top === undefined) {
      roots.push(node)
    } else if (node.end <= top.end) {
      top.children.push(node)
    } else {
      continue // 与已有成分交叉重叠（模型给了跨界片段），无法安放，丢弃
    }
    stack.push(node)
  }
  return roots
}

export interface GramPart {
  text: string
  /** 非空 = 这段属于某个成分，按它的角色着色；空 = 没被任何成分覆盖的原文 */
  node: GramNode | null
}

/** 按区间把 [from, to) 这段原文切成片段：命中的下级各自成片，缝隙原样保留。

    切片全部来自 `sentence.slice`，所以拼回去必然等于原文——这就是「不重复、不丢字」
    这条不变量的结构性保证。 */
export function sliceRange(
  sentence: string,
  from: number,
  to: number,
  children: readonly GramNode[],
): GramPart[] {
  const parts: GramPart[] = []
  let cursor = from
  // 兜底排序：正常路径下孩子天然有序（只在父区间的 cursor 之后接受），
  // 但整句兜底那一支可能塞进一个位置靠前的，排一下省得后面全被跳过
  for (const child of [...children].sort((a, b) => a.start - b.start)) {
    if (child.start < cursor) continue // 区间重叠（模型给了交叉成分）时后来者让路
    if (child.start > cursor) parts.push({ text: sentence.slice(cursor, child.start), node: null })
    parts.push({ text: sentence.slice(child.start, child.end), node: child })
    cursor = child.end
  }
  if (cursor < to) parts.push({ text: sentence.slice(cursor, to), node: null })
  return parts
}

/** 顶层切片：整句按根成分切开，根之间的标点空白照常显示。 */
export function topParts(sentence: string, roots: readonly GramNode[]): GramPart[] {
  return sliceRange(sentence, 0, sentence.length, roots)
}

/** 图例用：按渲染顺序把树里的成分摊平。 */
export function walkRoles(nodes: readonly GramNode[]): GramNode[] {
  const out: GramNode[] = []
  const visit = (n: GramNode): void => {
    out.push(n)
    n.children.forEach(visit)
  }
  nodes.forEach(visit)
  return out
}
