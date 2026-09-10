import { createHash } from 'node:crypto'
import { closeSync, openSync, readdirSync, readSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const CHUNK = 64 * 1024 * 1024

/* 分块读：readFileSync 对超过 2 GiB 的文件直接抛 ERR_FS_FILE_TOO_LARGE，
   whisper large-v3 的 model.bin 有 3 GB */
function digest(file) {
  const hash = createHash('sha256')
  const fd = openSync(file, 'r')
  const buffer = Buffer.allocUnsafe(CHUNK)
  try {
    let read = readSync(fd, buffer, 0, CHUNK, null)
    while (read > 0) {
      hash.update(buffer.subarray(0, read))
      read = readSync(fd, buffer, 0, CHUNK, null)
    }
  } finally {
    closeSync(fd)
  }
  return hash.digest('hex')
}

function walk(root, current = root) {
  return readdirSync(current, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(current, entry.name)
    return entry.isDirectory() ? walk(root, file) : [path.relative(root, file)]
  })
}

/* 内容戳：基线库 + 三个种子目录的文件哈希再哈希一次。壳按它决定要不要重铺种子，sidecar 按它决定
   要不要把基线里缺的内容表合并进已有的库——同一个版本号换了内容再装，靠版本号是判不出来的 */
const CONTENT_PREFIXES = ['desktop-baseline.sqlite3', 'media-seed/', 'models-seed/', 'grammar-seed/']

export function contentStamp(files) {
  const hash = createHash('sha256')
  for (const entry of files) {
    if (CONTENT_PREFIXES.some((prefix) => entry.path === prefix || entry.path.startsWith(prefix))) {
      hash.update(`${entry.path}\n${entry.sha256}\n`)
    }
  }
  return hash.digest('hex')
}

export function writeRuntimeManifest(runtimeRoot) {
  const files = walk(runtimeRoot)
    .filter((relative) => relative !== 'runtime-manifest.json' && relative !== 'content-stamp.json')
    .sort()
    .map((relative) => {
      const file = path.join(runtimeRoot, relative)
      return { path: relative, bytes: statSync(file).size, sha256: digest(file) }
    })
  writeFileSync(
    path.join(runtimeRoot, 'runtime-manifest.json'),
    `${JSON.stringify({ schema: 1, architecture: 'arm64', files }, null, 2)}\n`,
  )
  writeFileSync(
    path.join(runtimeRoot, 'content-stamp.json'),
    `${JSON.stringify({ schema: 1, stamp: contentStamp(files), builtAt: new Date().toISOString() }, null, 2)}\n`,
  )
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : ''
if (invokedPath === fileURLToPath(import.meta.url)) {
  const runtimeRoot = path.resolve(process.argv[2] ?? 'runtime')
  writeRuntimeManifest(runtimeRoot)
}
