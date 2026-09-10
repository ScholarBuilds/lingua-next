const { signAsync } = require('@electron/osx-sign')
const { closeSync, openSync, readSync } = require('node:fs')
const path = require('node:path')

const MACH_O_MAGICS = new Set([
  0xfeedface,
  0xcefaedfe,
  0xfeedfacf,
  0xcffaedfe,
  0xcafebabe,
  0xbebafeca,
  0xcafebabf,
  0xbfbafeca,
])

function isSignableCode(file) {
  if (['.app', '.framework'].includes(path.extname(file))) return true
  const header = Buffer.allocUnsafe(4)
  const descriptor = openSync(file, 'r')
  try {
    if (readSync(descriptor, header, 0, header.length, 0) !== header.length) return false
    return MACH_O_MAGICS.has(header.readUInt32BE(0))
  } finally {
    closeSync(descriptor)
  }
}

module.exports = async function signMac(options) {
  const identity = process.env.CSC_NAME?.trim()
  const adhoc = identity === '-' && process.env.NEXUS_ADHOC_BUILD === '1'
  if (!adhoc && (!identity || !/^[0-9A-F]{40}$/i.test(identity))) {
    throw new Error('CSC_NAME 必须是已验证的 40 位签名 identity hash；熟人内测仅允许显式 ad-hoc 档')
  }
  const inheritedIgnore = []
  if (options.ignore !== undefined) {
    inheritedIgnore.push(...(Array.isArray(options.ignore) ? options.ignore : [options.ignore]))
  }
  const shouldIgnore = (file) => {
    const inherited = inheritedIgnore.some((matcher) =>
      typeof matcher === 'function' ? matcher(file) : Boolean(file.match(matcher)),
    )
    return inherited || !isSignableCode(file)
  }
  const signOptions = { ...options, identity, ignore: shouldIgnore }
  if (adhoc) {
    signOptions.identityValidation = false
    signOptions.preAutoEntitlements = false
    signOptions.preEmbedProvisioningProfile = false
  }
  const inheritedOptionsForFile = options.optionsForFile
  signOptions.optionsForFile = (file) => {
    const fileOptions = (inheritedOptionsForFile ? inheritedOptionsForFile(file) : null) ?? {}
    if (adhoc) {
      fileOptions.entitlements = path.join(__dirname, '..', 'build', 'entitlements.mac.adhoc.plist')
    }
    if (process.env.NEXUS_LOCAL_BUILD === '1') fileOptions.timestamp = 'none'
    return fileOptions
  }
  await signAsync(signOptions)
}
