/* CSS 类名撞车守卫。

   起因是两次真实事故，现象都是「界面坏了但没有任何报错」：
   - `.sst-edit` 在同一个文件里既是卡片上的铅笔按钮（opacity:0）又是新建画风弹窗，
     点「新建画风」弹窗照常挂载，就是一个像素都看不见。
   - `.sc-card` / `.sp-note` / `.ph-example` 分属两个 feature，谁赢只看打包器先发射谁，
     而 dev 与 build 的顺序还不一样——开发时正常，上线才塌。

   CSS 规则是**合并**不是替换：A 文件声明了 B 从不重声明的属性，那条属性就无条件生效，
   永远不会报错。所以这件事只能靠扫描发现。

   判据只认「独立的单类顶层规则」（`.foo { … }`）：
   `.a, .b {}` 这种基类 + 细化、`:hover`、后代选择器、@media 里的重复都是正常层叠，不算。 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SRC = join(ROOT, 'src')

/** 同一个类在一个文件里出现多次是有意为之的地方。写进来要给出理由。 */
const ALLOW_SAME_FILE = new Set([
  // 以下都是「同一个元素的后续改版覆盖前一版」，各自只有一个消费方组件，
  // 逐个核过。真正要拦的是**两个不同组件抢同一个名字**，脚本分不出来，所以在这里点名放行。
  'pg-say', // 整段可点朗读改版（deck.css，PassagePane）
  'pg-para',
  'dag-node', // 加 position:relative 让角标定位（pipeline.css，PipelinePage）
  'vm-sc-edited', // 改成药丸样式（video-m5.css，SubtitlePanel）
  'wc-word', // 加 flex 容纳喇叭图标（app.css，WordCard）
  'vp-list', // 列表改成分组（app.css，VoicePicker）
  'vp-item',
  // v10.1 全屏画布那一节给同一个壳补 overflow/display（pipeline.css，PipelinePage）。
  // 两条规则互补不打架，上一节的注释里写明了「下面 .pl-full 那一段把它设成
  // overflow:hidden」。消费方只有 PipelinePage 一处。修好注释解析后才暴露出来。
  'pl-content',
])

/** 跨文件同名但互不冲突、且短期不打算改的。写进来要给出理由。 */
const ALLOW_CROSS_FILE = new Set([])

function cssFiles(dir) {
  const out = []
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) out.push(...cssFiles(full))
    else if (name.endsWith('.css')) out.push(full)
  }
  return out
}

/** 把注释换成等量换行后再解析。

    规则头是从上一个 `}` 一路攒到 `{` 的，注释也在这段里，于是
    `/* 说明 *​/\n.foo { … }` 攒出来的头是「注释 + .foo」，
    过不了 soleClass 的 `^\.name$`，那条规则就被静默跳过了。
    仓里 608 条单类规则都写了说明注释，等于守卫大半时间在空转
    （`.scv-more` 撞车就是这么漏过去的）。
    换成等量换行而不是直接删，是为了让报错里的行号还指得准。 */
function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, (block) => '\n'.repeat((block.match(/\n/g) ?? []).length))
}

/** 逐字符走一遍，只收集**顶层**（括号深度 0）的规则头。
    @media / @supports 里的重复是正常覆盖，跳过整块。 */
function topLevelSelectors(rawText) {
  const text = stripComments(rawText)
  const found = []
  let depth = 0
  let head = ''
  let line = 1
  let headLine = 1
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]
    if (ch === '\n') line += 1
    if (ch === '{') {
      if (depth === 0) {
        found.push({ head: head.trim(), line: headLine })
      }
      depth += 1
      head = ''
      headLine = line
      continue
    }
    if (ch === '}') {
      depth = Math.max(0, depth - 1)
      head = ''
      headLine = line
      continue
    }
    if (depth === 0) {
      if (head === '' && ch.trim() !== '') headLine = line
      head += ch
    }
  }
  return found
}

/** 只认「就是一个类，别的什么都没有」的选择器 */
function soleClass(head) {
  if (head.startsWith('@')) return null
  // 逗号分组是基类 + 细化的正常写法，不算独占
  if (head.includes(',')) return null
  const m = /^\.([a-zA-Z_][\w-]*)$/.exec(head.trim())
  return m ? m[1] : null
}

const owners = new Map() // class -> [{file, line}]
let sameFileHits = 0

for (const file of cssFiles(SRC)) {
  const rel = relative(ROOT, file)
  const text = readFileSync(file, 'utf8')
  const seen = new Map()
  for (const { head, line } of topLevelSelectors(text)) {
    const cls = soleClass(head)
    if (cls === null) continue
    if (seen.has(cls)) {
      if (!ALLOW_SAME_FILE.has(cls)) {
        console.error(
          `✗ 同文件重复定义  .${cls}\n    ${rel}:${seen.get(cls)} 与 ${rel}:${line}\n` +
            '    两处都是独立的单类规则。CSS 是合并不是替换：前一条声明、后一条没重声明的属性会照常生效。',
        )
        sameFileHits += 1
      }
      continue
    }
    seen.set(cls, line)
    if (!owners.has(cls)) owners.set(cls, [])
    owners.get(cls).push({ file: rel, line })
  }
}

let crossFileHits = 0
for (const [cls, places] of owners) {
  if (places.length < 2 || ALLOW_CROSS_FILE.has(cls)) continue
  console.error(
    `✗ 跨文件撞车  .${cls}\n` +
      places.map((p) => `    ${p.file}:${p.line}`).join('\n') +
      '\n    特异性相同，谁赢只看打包器先发射谁，dev 与 build 还可能不一致。请改成各自独占的前缀。',
  )
  crossFileHits += 1
}

const total = sameFileHits + crossFileHits
if (total > 0) {
  console.error(`\n共 ${total} 处类名撞车（同文件 ${sameFileHits} · 跨文件 ${crossFileHits}）。`)
  process.exit(1)
}
console.log(`css 类名检查通过：扫了 ${cssFiles(SRC).length} 个文件，没有撞车。`)
