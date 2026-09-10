import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const releaseRoot = path.join(desktopRoot, 'release')
const friendsBuild = process.env.NEXUS_LOCAL_SIGNING === 'adhoc'
const outputRoot = friendsBuild ? path.join(releaseRoot, 'friends') : releaseRoot

function signingIdentity() {
  if (friendsBuild) return '-'
  const configured = process.env.NEXUS_LOCAL_CSC_NAME?.trim()
  const output = execFileSync('/usr/bin/security', ['find-identity', '-v', '-p', 'codesigning'], {
    encoding: 'utf8',
  })
  const records = [...output.matchAll(/\)\s+([0-9A-F]{40})\s+"([^"]+)"/g)].map((match) => ({
    hash: match[1],
    name: match[2],
  }))
  if (configured) {
    const match = records.find(
      (record) => record.hash === configured.toUpperCase() || record.name === configured,
    )
    if (!match || !match.name.startsWith('Apple Development:')) {
      throw new Error('NEXUS_LOCAL_CSC_NAME 不是可用的 Apple Development 身份')
    }
    return match.hash
  }
  const identities = [...new Set(records.filter((record) => record.name.startsWith('Apple Development:')).map((record) => record.hash))]
  if (identities.length === 0) throw new Error('本地包需要 Apple Development 身份')
  return identities[0]
}

function writeFriendsGuide() {
  const guide = `NEXUS 熟人内测安装说明

本构建采用 ad-hoc 签名，未经 Apple 公证，只给可信的熟人内测用。

要求
- Apple Silicon（M1 及以后）的 Mac，macOS 14 或更新。确认方法：左上角  → 关于本机，「芯片」一行是 Apple M 开头。
- 磁盘留 20 GB 以上：安装包约 7 GB（含 23 条学习视频与离线转写模型），首次启动会把词典、内置书、视频、语音模型铺到用户目录，再占约 7 GB。

安装
1. 打开 DMG，把 NEXUS 拖进「应用程序」。
2. 首次打开若提示「无法验证开发者」或「已损坏」：先关掉提示，打开「系统设置 → 隐私与安全性」，页面底部点「仍要打开」。
   还是不行就在终端跑一句：xattr -dr com.apple.quarantine /Applications/NEXUS.app
3. 第一次启动要等一会（铺数据一到两分钟），按提示允许麦克风。
4. 升级新版本后，macOS 可能要求重新确认应用或重新授予权限。

装好就能用的
- 词典与查词（⌘K 直接输中文或英文）、八个考纲词书与背单词、音标训练、语法库与讲义、40 本内置公版书精读、23 条带中文字幕的学习视频。
- 视频转写离线可用：包里带 whisper large-v3 与 small，导入自己的视频不用联网下模型。
- AI 语境释义、拆开记、语法分析、写作纠错、逐句翻译、AI 对话、生图、朗读音色：包里已带发送者配好的模型服务与凭据，
  打开就能用，不用再填任何密钥。这些凭据是发送者个人的，只给你用，别再转发这个安装包。
- 想换成自己的密钥：「设置 → 模型服务」里改凭据，再在「能力绑定」里把各项绑到你的模型。

联网才能用的
- 以上 AI 功能与火山 / Azure 朗读要能上网；离线时词典、词书、音标、语法、内置书、已带字幕的视频照常可用。
- 导入 YouTube 视频需要能访问 YouTube。

只从发送者提供的原始文件下载。收到文件后可核对同目录 SHA256SUMS。
`
  writeFileSync(path.join(outputRoot, '熟人内测安装说明.txt'), guide)
  const artifacts = readdirSync(outputRoot)
    .filter((name) => name.endsWith('.dmg') || name.endsWith('.zip'))
    .sort()
  const checksums = artifacts.map((name) => {
    const output = execFileSync('/usr/bin/shasum', ['-a', '256', path.join(outputRoot, name)], {
      encoding: 'utf8',
    })
    return `${output.split(/\s+/)[0]}  ${name}`
  })
  writeFileSync(path.join(outputRoot, 'SHA256SUMS'), `${checksums.join('\n')}\n`)
}

function run(args, env = process.env) {
  const result = spawnSync('pnpm', args, { cwd: desktopRoot, env, stdio: 'inherit' })
  if (result.status !== 0) process.exit(result.status ?? 1)
}

const runtimeEnv = { ...process.env }
delete runtimeEnv.NEXUS_UPDATE_URL
delete runtimeEnv.NEXUS_UPDATE_PUBLIC_KEY
rmSync(outputRoot, { recursive: true, force: true })
mkdirSync(outputRoot, { recursive: true })
if (process.env.NEXUS_SKIP_RUNTIME_PREPARE !== '1') run(['runtime:prepare'], runtimeEnv)
run(['build'], runtimeEnv)
const outputConfig = friendsBuild
  ? ['--config.directories.output=release/friends', '--config.mac.identity=-']
  : []
run(
  [
    'exec',
    'electron-builder',
    '--mac',
    '--arm64',
    '--publish',
    'never',
    '--config.mac.notarize=false',
    ...outputConfig,
  ],
  {
    ...runtimeEnv,
    CSC_NAME: signingIdentity(),
    NEXUS_ADHOC_BUILD: friendsBuild ? '1' : '0',
    NEXUS_LOCAL_BUILD: '1',
    NEXUS_UPDATE_URL: 'https://updates.invalid/',
  },
)
if (friendsBuild) writeFriendsGuide()
