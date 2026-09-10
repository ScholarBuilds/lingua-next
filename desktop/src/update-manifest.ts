import { createHash, createPublicKey, verify } from 'node:crypto'
import { parseUpdateInfo } from 'electron-updater/out/providers/Provider'

export async function verifyUpdateManifest(config: { url: string; publicKey: string }, fetchMetadata: (url: string, init: RequestInit) => Promise<Response>): Promise<string> {
  const manifestUrl = new URL('nexus-update-manifest.json', config.url)
  const signatureUrl = new URL('nexus-update-manifest.sig', config.url)
  const [manifestResponse, signatureResponse] = await Promise.all([
    fetchMetadata(manifestUrl.href, { redirect: 'error' }),
    fetchMetadata(signatureUrl.href, { redirect: 'error' }),
  ])
  if (!manifestResponse.ok || !signatureResponse.ok) throw new Error('更新源缺少签名清单')
  const manifest = Buffer.from(await manifestResponse.arrayBuffer())
  const signature = Buffer.from((await signatureResponse.text()).trim(), 'base64')
  const publicKey = createPublicKey({ key: Buffer.from(config.publicKey, 'base64'), format: 'der', type: 'spki' })
  if (!verify(null, manifest, publicKey, signature)) throw new Error('更新清单签名无效')
  const payload = JSON.parse(manifest.toString('utf8')) as {
    schema?: unknown
    artifacts?: Array<{ name?: unknown; sha512?: unknown }>
  }
  const metadata = payload.schema === 1
    ? payload.artifacts?.find((artifact) => artifact.name === 'latest-mac.yml')
    : undefined
  if (typeof metadata?.sha512 !== 'string') throw new Error('更新清单缺少 latest-mac.yml 摘要')
  const latestResponse = await fetchMetadata(new URL('latest-mac.yml', config.url).href, { redirect: 'error' })
  if (!latestResponse.ok) throw new Error('更新源缺少 latest-mac.yml')
  const latest = Buffer.from(await latestResponse.arrayBuffer())
  if (createHash('sha512').update(latest).digest('base64') !== metadata.sha512) {
    throw new Error('更新元数据摘要不匹配')
  }
  const info = parseUpdateInfo(latest.toString('utf8'), 'latest-mac.yml', new URL('latest-mac.yml', config.url))
  for (const file of info.files) {
    const url = new URL(file.url, config.url)
    const name = decodeURIComponent(url.pathname.split('/').at(-1) ?? '')
    if (url.origin !== new URL(config.url).origin || !name.includes(info.version) ||
      !payload.artifacts?.some(artifact => artifact.name === name && artifact.sha512 === file.sha512)) {
      throw new Error('更新包缺少对应版本的签名摘要')
    }
  }
  return latest.toString('utf8')
}
