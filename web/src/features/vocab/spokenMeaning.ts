/* 释义文本 → 适合念出来的一句话（FR-487 / FR-504）。

   ECDICT 的 translation 是给眼睛看的：`n. 苹果, 苹果树 [计] 苹果公司\nvt. 说, 讲`。
   照原样送 TTS 会把「n 点」「计」都念出来，义项一多还念不完。

   两档：`first` 去掉词性与标签、切义项取前几条（≈ 只念第一个词性）；
   `all` 按词性分组，每组「中文词性名，义 1、义 2、义 3」，组间「；」——
   听读时想把 think 的动词和名词义都过一遍用这档。纯函数，不碰网络。 */

export type MeaningScope = 'first' | 'all'

/** ECDICT 用 `a.` / `ad.` 而不是 `adj.` / `adv.`，两套都收；按长度降序避免 `a.` 先吃掉 `art.` */
const POS_ABBR = [
  'interj', 'abbr', 'conj', 'prep', 'pron', 'aux', 'adj', 'adv', 'art', 'num', 'int',
  'vt', 'vi', 'pl', 'ad', 'n', 'v', 'a',
]
const POS_NAMES: Record<string, string> = {
  n: '名词',
  v: '动词',
  vt: '及物动词',
  vi: '不及物动词',
  a: '形容词',
  adj: '形容词',
  ad: '副词',
  adv: '副词',
  prep: '介词',
  conj: '连词',
  pron: '代词',
  art: '冠词',
  aux: '助动词',
  num: '数词',
  int: '感叹词',
  interj: '感叹词',
  abbr: '缩写',
  pl: '复数',
}
const POS_RE = new RegExp(`(^|[\\s,，;；(（])(${POS_ABBR.join('|')})\\.\\s*`, 'g')
/** `[计]` `【化】` `<口>` 这类领域 / 语域标签 */
const TAG_RE = /[\[【<〈][^\]】>〉]{1,8}[\]】>〉]\s*/g
const SPLIT_RE = /[,，;；\n]+/

export const MAX_SENSES = 3
export const MAX_SPOKEN_LEN = 24
export const MAX_SPOKEN_LEN_ALL = 80

function senseList(text: string, limit: number, budget: number): string[] {
  const senses: string[] = []
  for (const raw of text.split(SPLIT_RE)) {
    const sense = raw.trim().replace(/^[.．。:：、\s]+|[.．。:：、\s]+$/g, '')
    if (sense === '' || senses.includes(sense)) continue
    const next = [...senses, sense].join('，')
    if (senses.length > 0 && next.length > budget) break
    senses.push(sense)
    if (senses.length >= limit) break
  }
  return senses
}

function firstScope(translation: string): string {
  // 词性与标签都是义项的分界：`苹果树 [计] 苹果公司` 是两条义项不是一条
  const cleaned = translation.replace(TAG_RE, ',').replace(POS_RE, '$1,')
  const out = senseList(cleaned, MAX_SENSES, MAX_SPOKEN_LEN).join('，')
  return out.length > MAX_SPOKEN_LEN ? out.slice(0, MAX_SPOKEN_LEN) : out
}

function allScope(translation: string): string {
  const cleaned = translation.replace(TAG_RE, ',')
  const groups: Array<{ pos: string; text: string }> = []
  let cursor = 0
  let pos = ''
  for (const m of cleaned.matchAll(POS_RE)) {
    const at = m.index ?? 0
    groups.push({ pos, text: cleaned.slice(cursor, at) })
    pos = m[2]
    cursor = at + m[0].length
  }
  groups.push({ pos, text: cleaned.slice(cursor) })
  const parts: string[] = []
  for (const group of groups) {
    const senses = senseList(group.text, MAX_SENSES, MAX_SPOKEN_LEN_ALL)
    if (senses.length === 0) continue
    const name = POS_NAMES[group.pos]
    parts.push(name === undefined ? senses.join('、') : `${name}，${senses.join('、')}`)
  }
  const out = parts.join('；')
  return out.length > MAX_SPOKEN_LEN_ALL ? out.slice(0, MAX_SPOKEN_LEN_ALL) : out
}

export function spokenMeaning(
  translation: string | null | undefined,
  opts: { scope?: MeaningScope } = {},
): string {
  if (!translation) return ''
  return opts.scope === 'all' ? allScope(translation) : firstScope(translation)
}
