/* JSX 文本里的字面 markdown 守卫。

   JSX 不解析 markdown：注释里写惯的 `**强调**` 抄进文本节点，界面上就真的显示
   两对星号。这已经是第三次漏出去了（SetPlanDialog 两处、CanvasEditor 一处），
   而且每次都要等到有人截图才发现——它不报错、类型也过。

   只查 JSX 文本节点：注释、字符串字面量、markdown 渲染器的入参都不算。
   判据取最保守的一种：一行里出现 `**…**` 且这一行不是注释、不含引号包裹。 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SRC = join(ROOT, 'src')
/** 有自己的 markdown 渲染器，`**` 在这里是数据不是文案 */
const ALLOW = ['markdownLite.tsx', 'OnboardingCard.tsx']

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (full.endsWith('.tsx')) out.push(full)
  }
  return out
}

const offenders = []
for (const file of walk(SRC)) {
  if (ALLOW.some((n) => file.endsWith(n))) continue
  const lines = readFileSync(file, 'utf8').split('\n')
  let inBlockComment = false
  lines.forEach((line, i) => {
    const trimmed = line.trim()
    if (trimmed.startsWith('/*')) inBlockComment = !trimmed.includes('*/')
    if (inBlockComment) {
      if (trimmed.includes('*/')) inBlockComment = false
      return
    }
    if (trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('{/*')) return
    if (trimmed.includes('*/')) return
    // 带引号的多半是字符串（title、传给 markdown 渲染器的数据），不判
    if (/['"`]/.test(line)) return
    if (/\*\*[^*]+\*\*/.test(line)) offenders.push(`${relative(ROOT, file)}:${i + 1}  ${trimmed.slice(0, 70)}`)
  })
}

if (offenders.length > 0) {
  console.error('JSX 文本里有字面 markdown（界面上会显示成星号），要加粗请用 <b>：')
  for (const at of offenders) console.error(`  ${at}`)
  process.exit(1)
}
console.log('JSX markdown 检查通过：没有会漏成星号的文案。')
