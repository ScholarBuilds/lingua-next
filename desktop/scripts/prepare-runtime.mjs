import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { homedir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { writeRuntimeManifest } from './write-runtime-manifest.mjs'

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = path.resolve(desktopRoot, '..')
const serverRoot = path.join(repoRoot, 'server')
const webRoot = path.join(repoRoot, 'web')
const runtimeRoot = path.join(desktopRoot, 'runtime')
const pyinstallerWork = path.join(desktopRoot, '.build', 'pyinstaller')

function normalizedUpdateUrl() {
  const value = process.env.NEXUS_UPDATE_URL?.trim()
  if (!value) return null
  const url = new URL(value)
  if (url.protocol !== 'https:') throw new Error('NEXUS_UPDATE_URL 必须使用 HTTPS')
  return url.toString()
}

function updatePublicKey() {
  const value = process.env.NEXUS_UPDATE_PUBLIC_KEY?.trim()
  if (!value) return null
  const decoded = Buffer.from(value, 'base64')
  if (decoded.length < 32) throw new Error('NEXUS_UPDATE_PUBLIC_KEY 不是有效的 DER 公钥')
  return value
}

function run(command, args, cwd) {
  execFileSync(command, args, { cwd, stdio: 'inherit' })
}

rmSync(runtimeRoot, { recursive: true, force: true })
rmSync(pyinstallerWork, { recursive: true, force: true })
mkdirSync(runtimeRoot, { recursive: true })
mkdirSync(pyinstallerWork, { recursive: true })

run('pnpm', ['build'], webRoot)
cpSync(path.join(webRoot, 'dist'), path.join(runtimeRoot, 'web'), { recursive: true })

const heads = execFileSync('uv', ['run', 'alembic', 'heads'], { cwd: serverRoot, encoding: 'utf8' })
  .trim()
  .split(/\s+/)
  .filter((part) => /^[0-9a-f]+$/i.test(part))
if (heads.length !== 1) throw new Error(`桌面基线要求单一 Alembic head，实际为：${heads.join(', ')}`)
/* 内容基线：词典 / 查词索引 / 音标 / 语法 / 内置书 / 场景分组从开发用的桌面库拷进基线，
   装到别人机器上打开就有内容。NEXUS_CONTENT_DB=none 才出空库（只在验证表结构时用） */
const contentDb =
  process.env.NEXUS_CONTENT_DB === 'none'
    ? null
    : path.resolve(process.env.NEXUS_CONTENT_DB ?? path.join(repoRoot, 'data', 'desktop', 'nexus.sqlite3'))
if (contentDb !== null && !existsSync(contentDb)) {
  throw new Error(`内容库不存在：${contentDb}（NEXUS_CONTENT_DB 指一个迁到 head 的桌面库，或设为 none）`)
}
run(
  'uv',
  [
    'run', 'python', '-m', 'scripts.build_desktop_baseline',
    path.join(runtimeRoot, 'desktop-baseline.sqlite3'),
    '--revision', heads[0],
    ...(contentDb === null
      ? []
      : ['--content-from', contentDb, '--seed-media', path.join(path.dirname(contentDb), 'media'), path.join(runtimeRoot, 'media-seed')]),
  ],
  serverRoot,
)

// 公开发行始终使用用户自己的凭据，不把密文与解密密钥一起装进安装包。
if (process.env.NEXUS_BUNDLE_CONFIG === '1') {
  throw new Error('公开发行包禁止携带服务凭据；请由使用者在设置中配置自己的密钥。')
}

// 讲义库正文是文件不是表：grammar_concept 的 source_path 指向它，缺了概念专栏点开是空白
const grammarDocs = process.env.NEXUS_GRAMMAR_DOCS ?? path.join(repoRoot, 'data', 'desktop', 'grammar')
if (contentDb !== null && existsSync(grammarDocs)) {
  cpSync(grammarDocs, path.join(runtimeRoot, 'grammar-seed'), { recursive: true })
}

/* whisper 模型随包（scholar 决策）：large-v3 是默认转写模型、离线可用；small 是内存不够时的回落。
   HF 缓存里 snapshots 是指向 blobs 的绝对路径软链，cp -RL 真解链，再删掉重复的 blobs */
const hubCache =
  process.env.HUGGINGFACE_HUB_CACHE ??
  path.join(process.env.HF_HOME ?? path.join(homedir(), '.cache', 'huggingface'), 'hub')
const whisperModels = (process.env.NEXUS_WHISPER_MODELS ?? 'large-v3,small').split(',').map((m) => m.trim()).filter(Boolean)
const modelsHub = path.join(runtimeRoot, 'models-seed', 'huggingface', 'hub')
mkdirSync(modelsHub, { recursive: true })
for (const model of whisperModels) {
  const repo = `models--Systran--faster-whisper-${model}`
  const source = path.join(hubCache, repo)
  if (!existsSync(path.join(source, 'refs', 'main'))) {
    throw new Error(
      `本机没有 faster-whisper ${model} 模型缓存：${source}\n` +
        `先 cd server && uv run python -c "from faster_whisper import WhisperModel; WhisperModel('${model}')" 拉一次，或用 NEXUS_WHISPER_MODELS 指定随包的模型`,
    )
  }
  execFileSync('/bin/cp', ['-RL', source, path.join(modelsHub, repo)])
  rmSync(path.join(modelsHub, repo, 'blobs'), { recursive: true, force: true })
}

/* 随包二进制：sidecar 用 shutil.which 找 ffmpeg / deno（yt-dlp 解 YouTube 签名要 JS 运行时），
   别人机器上没有 Homebrew。ffmpeg 取 imageio-ffmpeg 轮子里的静态 arm64 构建（GitHub 直连在本机超时，
   PyPI 通），deno 是单文件静态二进制，直接拷本机的 */
const binRoot = path.join(runtimeRoot, 'bin')
mkdirSync(binRoot, { recursive: true })
const ffmpegSource = execFileSync(
  'uv',
  ['run', '--with', 'imageio-ffmpeg', 'python', '-c', 'import imageio_ffmpeg,sys; sys.stdout.write(imageio_ffmpeg.get_ffmpeg_exe())'],
  { cwd: serverRoot, encoding: 'utf8' },
).trim()
copyFileSync(ffmpegSource, path.join(binRoot, 'ffmpeg'))
chmodSync(path.join(binRoot, 'ffmpeg'), 0o755)
const ffmpegVersion = execFileSync(path.join(binRoot, 'ffmpeg'), ['-version'], { encoding: 'utf8' }).split('\n')[0].split(' ')[2]
const denoSource = process.env.NEXUS_DENO ?? execFileSync('/bin/zsh', ['-lc', 'command -v deno'], { encoding: 'utf8' }).trim()
if (!denoSource || !existsSync(denoSource)) throw new Error('本机找不到 deno（brew install deno），yt-dlp 解 YouTube 签名需要它随包')
copyFileSync(denoSource, path.join(binRoot, 'deno'))
chmodSync(path.join(binRoot, 'deno'), 0o755)
const denoVersion = execFileSync(path.join(binRoot, 'deno'), ['--version'], { encoding: 'utf8' }).split('\n')[0].split(' ')[1]
const bundledBinaries = [
  ['ffmpeg', ffmpegVersion, 'GPL-2.0-or-later'],
  ['deno', denoVersion, 'MIT'],
  ...whisperModels.map((m) => [`faster-whisper-${m}`, `Systran/faster-whisper-${m}`, 'MIT']),
]
writeFileSync(path.join(binRoot, 'manifest.json'), `${JSON.stringify(bundledBinaries, null, 2)}\n`)

run(
  'uv',
  ['run', 'pyinstaller', '--noconfirm', '--clean', '--distpath', runtimeRoot, '--workpath', pyinstallerWork, 'desktop_sidecar.spec'],
  serverRoot,
)

cpSync(path.join(repoRoot, 'data', 'scenarios'), path.join(runtimeRoot, 'scenarios'), { recursive: true })
cpSync(path.join(repoRoot, 'data', 'scenario_deck_seeds.yaml'), path.join(runtimeRoot, 'scenario-deck-seeds.yaml'))
run(
  'uv',
  [
    'run',
    'python',
    '-m',
    'scripts.generate_desktop_compliance',
    path.join(runtimeRoot, 'compliance'),
    '--server-root',
    serverRoot,
    '--desktop-root',
    desktopRoot,
    '--web-root',
    webRoot,
    ...bundledBinaries.flatMap((entry) => ['--component', ...entry]),
  ],
  serverRoot,
)
writeFileSync(
  path.join(runtimeRoot, 'release-config.json'),
  `${JSON.stringify({ schema: 1, updateUrl: normalizedUpdateUrl(), updatePublicKey: updatePublicKey() }, null, 2)}\n`,
)

writeRuntimeManifest(runtimeRoot)
