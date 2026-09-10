import { strict as assert } from 'node:assert'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { test } from 'node:test'
import { verifyUpdateManifest } from './update-manifest'

const keys = generateKeyPairSync('ed25519')
const config = { url: 'https://updates.example.com/mac/', publicKey: keys.publicKey.export({ format: 'der', type: 'spki' }).toString('base64') }

function source(fileUrl = 'NEXUS-0.2.1.zip', signedArtifact = true) {
  const latest = `version: 0.2.1\nfiles:\n  - url: ${fileUrl}\n    sha512: package-digest\n`
  const manifest = JSON.stringify({ schema: 1, artifacts: [
    { name: 'latest-mac.yml', sha512: createHash('sha512').update(latest).digest('base64') },
    ...(signedArtifact ? [{ name: 'NEXUS-0.2.1.zip', sha512: 'package-digest' }] : []),
  ] })
  const files = new Map([
    ['nexus-update-manifest.json', manifest],
    ['nexus-update-manifest.sig', sign(null, Buffer.from(manifest), keys.privateKey).toString('base64')],
    ['latest-mac.yml', latest],
  ])
  const calls: string[] = []
  const fetchMetadata: typeof fetch = async (input, options) => {
    assert.equal(options?.redirect, 'error')
    const name = new URL(String(input)).pathname.split('/').at(-1)!
    calls.push(name)
    return new Response(files.get(name), { status: files.has(name) ? 200 : 404 })
  }
  return { files, calls, fetchMetadata, latest }
}

test('returns the same verified metadata with one read of latest', async () => {
  const feed = source()
  const metadata = await verifyUpdateManifest(config, feed.fetchMetadata)
  feed.files.set('latest-mac.yml', 'changed after verification')
  assert.equal(metadata, feed.latest)
  assert.equal(feed.calls.filter(name => name === 'latest-mac.yml').length, 1)
})

test('rejects tampered signature and changed metadata bytes', async () => {
  const signature = source()
  signature.files.set('nexus-update-manifest.json', '{}')
  await assert.rejects(verifyUpdateManifest(config, signature.fetchMetadata), /签名无效/)
  const metadata = source()
  metadata.files.set('latest-mac.yml', 'changed before verification')
  await assert.rejects(verifyUpdateManifest(config, metadata.fetchMetadata), /摘要不匹配/)
})

test('rejects unsigned packages, foreign origins and version mismatches', async () => {
  for (const feed of [source('NEXUS-0.2.1.zip', false), source('https://foreign.example.com/NEXUS-0.2.1.zip'), source('NEXUS-0.2.0.zip')]) {
    await assert.rejects(verifyUpdateManifest(config, feed.fetchMetadata), /签名摘要/)
  }
})
