/* 原生 `<select>` 回潮守卫（规范 STD-UI-009）。

   全项目的下拉统一走 `components/ui/picker`。原生 `<select>` 与它并存的代价是
   **两套外观、两套交互**同时在界面上：macOS 会画自己的系统下拉，Windows 画另一种，
   而 Radix 那套是我们自己的。用户能一眼看出哪几个控件"不是一伙的"。

   这条守卫只挡新增。`components/ui/` 自己那层是允许的——`picker.tsx` 内部
   就是拿 Radix 的 Select 实现的。 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SRC = join(ROOT, 'src')
/** 组件层自己可以用原生元素——它就是把原生能力包起来的那一层 */
const ALLOW = [join(SRC, 'components', 'ui')]

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
  if (ALLOW.some((dir) => file.startsWith(dir))) continue
  const text = readFileSync(file, 'utf8')
  const lines = text.split('\n')
  lines.forEach((line, i) => {
    // 只认 JSX 里真的开了一个 <select>，注释与字符串里提到的不算
    if (/<select[\s>]/.test(line) && !/^\s*(\*|\/\/)/.test(line)) {
      offenders.push(`${relative(ROOT, file)}:${i + 1}`)
    }
  })
}

if (offenders.length > 0) {
  console.error('发现原生 <select>，请改用 components/ui/picker（规范 STD-UI-009）：')
  for (const at of offenders) console.error(`  ${at}`)
  process.exit(1)
}
console.log(`原生 select 检查通过：${walk(SRC).length} 个 tsx，没有漏网的。`)
