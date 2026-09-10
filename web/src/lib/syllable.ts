/* 音节切分（FR-322）：离线、即时、零成本。

   算法是 Knuth–Liang 断词（TeX 那套），patterns 取自 CTAN，用 `hyphen` 包跑，不自己实现。
   注意它本来是给**排版断行**用的，偏保守（refac·tor 而不是 re·fac·tor），
   所以只当"AI 结果到位之前的即时档"，权威切分以 AI 层为准（BR-68）。 */

import createHyphenator from 'hyphen'
import patterns from 'hyphen/patterns/en-us'

const SEP = '­' // soft hyphen：hyphen 包的默认插入字符
const hyphenate = createHyphenator(patterns, { hyphenChar: SEP })

/** 切成音节数组；切不动（单音节、含非字母）时原样返回单元素数组 */
export function syllablesOf(word: string): string[] {
  const w = word.trim()
  if (w === '' || !/^[A-Za-z][A-Za-z'’-]*$/.test(w)) return [w]
  const marked = hyphenate(w)
  const parts = String(marked).split(SEP).filter((p) => p !== '')
  return parts.length > 0 ? parts : [w]
}
