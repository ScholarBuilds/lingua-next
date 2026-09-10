import { createHash, createPrivateKey, createPublicKey, sign } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const releaseRoot = path.join(desktopRoot, 'release')
const packageJson = JSON.parse(readFileSync(path.join(desktopRoot, 'package.json'), 'utf8'))

function required(name) {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`缺少发布环境变量 ${name}`)
  return value
}

function run(command, args, env = process.env) {
  const result = spawnSync(command, args, { cwd: desktopRoot, env, stdio: 'inherit' })
  if (result.status !== 0) process.exit(result.status ?? 1)
}

const updateUrl = new URL(required('NEXUS_UPDATE_URL'))
if (updateUrl.protocol !== 'https:') throw new Error('NEXUS_UPDATE_URL 必须使用 HTTPS')

const configuredIdentity = required('CSC_NAME')
const identityOutput = execFileSync('/usr/bin/security', ['find-identity', '-v', '-p', 'codesigning'], {
  encoding: 'utf8',
})
const identities = [...identityOutput.matchAll(/\)\s+([0-9A-F]{40})\s+"([^"]+)"/g)].map((match) => ({
  hash: match[1],
  name: match[2],
}))
const identity = identities.find(
  (item) => item.name === configuredIdentity || item.hash === configuredIdentity.toUpperCase(),
)
if (!identity) throw new Error(`本机 Keychain 没有签名身份：${configuredIdentity}`)
if (!identity.name.startsWith('Developer ID Application:')) {
  throw new Error('CSC_NAME 必须是 Developer ID Application 身份')
}

const apiKey = required('APPLE_API_KEY')
if (!existsSync(apiKey)) throw new Error(`APPLE_API_KEY 文件不存在：${apiKey}`)
required('APPLE_API_KEY_ID')
required('APPLE_API_ISSUER')

const signingKeyPath = required('NEXUS_UPDATE_SIGNING_KEY')
const signingKey = createPrivateKey(readFileSync(signingKeyPath))
if (signingKey.asymmetricKeyType !== 'ed25519') {
  throw new Error('NEXUS_UPDATE_SIGNING_KEY 必须是 Ed25519 PEM 私钥')
}
const publicKey = createPublicKey(signingKey).export({ type: 'spki', format: 'der' }).toString('base64')
const releaseEnv = { ...process.env, CSC_NAME: identity.hash, NEXUS_UPDATE_PUBLIC_KEY: publicKey }

rmSync(releaseRoot, { recursive: true, force: true })
run('pnpm', ['runtime:prepare'], releaseEnv)
run('pnpm', ['build'], releaseEnv)
run('pnpm', ['exec', 'electron-builder', '--mac', '--arm64', '--publish', 'never'], releaseEnv)

const appPath = path.join(releaseRoot, 'mac-arm64', 'NEXUS.app')
if (!existsSync(appPath)) throw new Error(`发布产物缺少应用：${appPath}`)
run('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', appPath], releaseEnv)
run('/usr/sbin/spctl', ['--assess', '--type', 'execute', '--verbose=2', appPath], releaseEnv)

const dmgs = readdirSync(releaseRoot).filter((name) => name.endsWith('.dmg')).sort()
if (dmgs.length === 0) throw new Error('发布产物缺少 DMG')
for (const name of dmgs) {
  const dmg = path.join(releaseRoot, name)
  run(
    '/usr/bin/xcrun',
    [
      'notarytool',
      'submit',
      dmg,
      '--key',
      apiKey,
      '--key-id',
      process.env.APPLE_API_KEY_ID,
      '--issuer',
      process.env.APPLE_API_ISSUER,
      '--wait',
    ],
    releaseEnv,
  )
  run('/usr/bin/xcrun', ['stapler', 'staple', '--verbose', dmg], releaseEnv)
  run('/usr/bin/xcrun', ['stapler', 'validate', '--verbose', dmg], releaseEnv)
}

const artifacts = readdirSync(releaseRoot)
  .filter((name) => /\.(dmg|zip|yml|blockmap)$/.test(name))
  .sort()
  .map((name) => {
    const file = path.join(releaseRoot, name)
    return {
      name,
      bytes: statSync(file).size,
      sha512: createHash('sha512').update(readFileSync(file)).digest('base64'),
    }
  })
if (!artifacts.some((artifact) => artifact.name === 'latest-mac.yml')) {
  throw new Error('发布产物缺少 latest-mac.yml')
}
const manifest = Buffer.from(`${JSON.stringify({
  schema: 1,
  version: packageJson.version,
  minimumSystemVersion: '14.0.0',
  generatedAt: new Date().toISOString(),
  updateUrl: updateUrl.toString(),
  artifacts,
}, null, 2)}\n`)
writeFileSync(path.join(releaseRoot, 'nexus-update-manifest.json'), manifest)
writeFileSync(
  path.join(releaseRoot, 'nexus-update-manifest.sig'),
  `${sign(null, manifest, signingKey).toString('base64')}\n`,
)
