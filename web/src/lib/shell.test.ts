/* SHELL_MEMBERS 与 LinguaShell 接口必须是同一份名单：探针拿数组对账 Object.keys(window.linguaShell)，
   接口上多了成员没登记、数组里多了接口没有的名字，探针都会看着一切正常。
   `satisfies` 已经钉住「数组里的每个名字都在接口上」，这里补另一个方向：从源码里把接口成员抠出来比对。 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { SHELL_MEMBERS } from './shell'

function requiredInterfaceMembers(): string[] {
  const source = readFileSync(fileURLToPath(new URL('./shell.ts', import.meta.url)), 'utf8')
  const match = /export interface LinguaShell \{([\s\S]*?)\n\}/.exec(source)
  if (match === null) throw new Error('shell.ts 里找不到 interface LinguaShell')
  const names: string[] = []
  for (const line of match[1].split('\n')) {
    const member = /^\s{2}([A-Za-z]\w*)\(/.exec(line)
    if (member !== null) names.push(member[1])
  }
  return names
}

describe('SHELL_MEMBERS', () => {
  it('与 LinguaShell 的成员一一对应', () => {
    expect([...SHELL_MEMBERS].sort()).toEqual(requiredInterfaceMembers().sort())
  })

  it('没有重复', () => {
    expect(new Set(SHELL_MEMBERS).size).toBe(SHELL_MEMBERS.length)
  })
})
