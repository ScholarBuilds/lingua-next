/* 登录项拉起的 GUI 进程只有 launchd 给的那点 PATH（/usr/bin:/bin:/usr/sbin:/sbin），
   uv 和 brew 安装的工具一个都找不到。所以启动时问一次登录 shell，再补几个固定目录兜底。
   不用 fix-path：它 ESM-only，与这里的 CommonJS 输出不合。 */

import { execFile } from 'node:child_process'
import { accessSync, constants, statSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

const LOGIN_SHELL_TIMEOUT_MS = 5000

export const FALLBACK_DIRS: readonly string[] = [
  '~/.local/bin',
  '/opt/homebrew/bin',
  '/usr/local/bin',
  '~/.cargo/bin',
]

function expandHome(dir: string): string {
  return dir === '~' || dir.startsWith('~/') ? path.join(homedir(), dir.slice(1)) : dir
}

// 交互式 rc 会往 stdout 吐东西（本机实测 iTerm 集成的 OSC 转义序列排在 PATH 前面），只认哨兵之间那一段
const PATH_SENTINEL = '__LINGUA_PATH__'

export function extractShellPath(stdout: string): string | null {
  const start = stdout.indexOf(PATH_SENTINEL)
  const end = stdout.lastIndexOf(PATH_SENTINEL)
  if (start === -1 || end <= start) return null
  const value = stdout.slice(start + PATH_SENTINEL.length, end).trim()
  return value === '' ? null : value
}

/** 问登录 shell 要 PATH；shell 没有、rc 卡住、超时，一律当没问到 */
export function loginShellPath(timeoutMs = LOGIN_SHELL_TIMEOUT_MS): Promise<string | null> {
  const shell = process.env.SHELL ?? '/bin/zsh'
  return new Promise((resolve) => {
    execFile(
      shell,
      ['-ilc', `printf '%s%s%s' '${PATH_SENTINEL}' "$PATH" '${PATH_SENTINEL}'`],
      { encoding: 'utf8', timeout: timeoutMs },
      (error, stdout) => {
        resolve(error !== null ? null : extractShellPath(stdout))
      },
    )
  })
}

/** 按给定顺序合并几段 PATH，去重、展开 `~`、丢空段 */
export function mergePath(...segments: Array<string | null | undefined>): string {
  const seen = new Set<string>()
  const dirs: string[] = []
  for (const segment of segments) {
    if (!segment) continue
    for (const dir of segment.split(path.delimiter)) {
      const expanded = expandHome(dir.trim())
      if (expanded === '' || seen.has(expanded)) continue
      seen.add(expanded)
      dirs.push(expanded)
    }
  }
  return dirs.join(path.delimiter)
}

/* 登录 shell 的 PATH 排最前（那是用户自己配的顺序），兜底目录压在进程 PATH 之前：
   从登录项起来时进程 PATH 只有系统那四个目录，brew 的工具要能盖过系统自带的。 */
export async function augmentedPath(): Promise<string> {
  const fromShell = await loginShellPath()
  return mergePath(fromShell, FALLBACK_DIRS.join(path.delimiter), process.env.PATH)
}

export function resolveExecutable(name: string, pathString: string): string | undefined {
  for (const dir of pathString.split(path.delimiter)) {
    if (dir === '') continue
    const candidate = path.join(dir, name)
    try {
      if (!statSync(candidate).isFile()) continue
      accessSync(candidate, constants.X_OK)
      return candidate
    } catch {
      continue
    }
  }
  return undefined
}
