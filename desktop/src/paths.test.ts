import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import { after, before, describe, test } from 'node:test'

import { augmentedPath, extractShellPath, FALLBACK_DIRS, loginShellPath, mergePath, resolveExecutable } from './paths'

describe('mergePath', () => {
  test('按顺序合并、去重、丢空段', () => {
    assert.equal(mergePath('/a:/b', '/b:/c', null, undefined, '', ':/a:'), '/a:/b:/c')
  })

  test('展开 ~', () => {
    assert.equal(mergePath('~/.local/bin', path.join(homedir(), '.local/bin')), path.join(homedir(), '.local/bin'))
  })
})

describe('extractShellPath', () => {
  test('只取哨兵之间那段，rc 吐出来的转义序列不算目录', () => {
    const noise = '\u001b]6;1;bg;red;brightness;107\u0007\n'
    assert.equal(extractShellPath(`${noise}__LINGUA_PATH__/a:/b__LINGUA_PATH__`), '/a:/b')
  })

  test('没有哨兵或中间是空的都当没问到', () => {
    assert.equal(extractShellPath('/a:/b'), null)
    assert.equal(extractShellPath('__LINGUA_PATH__'), null)
    assert.equal(extractShellPath('__LINGUA_PATH__  __LINGUA_PATH__'), null)
  })
})

describe('resolveExecutable', () => {
  let dir = ''
  before(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'lingua-paths-'))
    writeFileSync(path.join(dir, 'uv'), '#!/bin/sh\n')
    chmodSync(path.join(dir, 'uv'), 0o755)
    writeFileSync(path.join(dir, 'notes.txt'), 'x')
  })
  after(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  test('命中：可执行文件在 PATH 里', () => {
    assert.equal(resolveExecutable('uv', `/nonexistent:${dir}`), path.join(dir, 'uv'))
  })

  test('未命中：不存在或不可执行都返回 undefined', () => {
    assert.equal(resolveExecutable('missing-tool', `/nonexistent:${dir}`), undefined)
    assert.equal(resolveExecutable('notes.txt', dir), undefined)
    assert.equal(resolveExecutable('uv', ''), undefined)
  })
})

describe('augmentedPath', () => {
  const originalShell = process.env.SHELL
  after(() => {
    if (originalShell === undefined) delete process.env.SHELL
    else process.env.SHELL = originalShell
  })

  test('登录 shell 起不来就跳过，兜底目录与进程 PATH 照样合进去', async () => {
    process.env.SHELL = '/nonexistent/zsh'
    assert.equal(await loginShellPath(), null)
    const merged = (await augmentedPath()).split(path.delimiter)
    for (const dir of FALLBACK_DIRS) {
      assert.ok(merged.includes(dir.startsWith('~/') ? path.join(homedir(), dir.slice(2)) : dir), dir)
    }
    for (const dir of (process.env.PATH ?? '').split(path.delimiter).filter(Boolean)) {
      assert.ok(merged.includes(dir), dir)
    }
    assert.equal(new Set(merged).size, merged.length)
  })
})
