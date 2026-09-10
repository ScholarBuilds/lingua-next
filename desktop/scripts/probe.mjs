import { existsSync, mkdtempSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { _electron as electron } from 'playwright'

const require = createRequire(import.meta.url)
const { SHELL_MEMBERS } = require('../dist/shell-contract.js')
const appUrl = process.env.LINGUA_URL ?? 'http://127.0.0.1:5173'
const downloadDir = mkdtempSync(join(tmpdir(), 'nexus-probe-download-'))
const userDataDir = mkdtempSync(join(tmpdir(), 'nexus-probe-userdata-'))

const app = await electron.launch({
  args: ['dist/main.js'],
  env: {
    ...process.env,
    LINGUA_URL: appUrl,
    LINGUA_PROBE: '1',
    LINGUA_DOWNLOAD_DIR: downloadDir,
    LINGUA_USER_DATA: userDataDir,
  },
})
const page = await app.firstWindow()
const results = []
const check = (name, ok, note = '') => {
  results.push({ name, ok, note })
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${note ? `  (${note})` : ''}`)
}
const info = (name, note) => console.log(`info ${name}  (${note})`)
const readProbe = () => app.evaluate(() => globalThis.__probe)

await page.waitForSelector('.rail', { timeout: 30_000 })
check('页面加载：标题与侧栏', (await page.title()) === 'NEXUS' && (await page.locator('.rail-item').count()) > 0)
check('已移除退场入口', (await page.getByText('贾维斯', { exact: true }).count()) === 0)
check('只创建工作台主窗口', (await app.windows()).length === 1, `${(await app.windows()).length} 个窗口`)

const exposed = await page.evaluate(() => Object.keys(window.linguaShell ?? {}))
check('preload 只暴露工作台合同', exposed.length === SHELL_MEMBERS.length && SHELL_MEMBERS.every((member) => exposed.includes(member)), exposed.join(', '))

await page.evaluate(() => window.open('https://example.com/probe-window-open', '_blank', 'noopener'))
await page.evaluate(() => window.linguaShell.openExternal('https://example.com/probe-shell'))
await page.waitForTimeout(500)
let state = await readProbe()
check(
  '外链交给系统浏览器',
  state.external.includes('https://example.com/probe-window-open')
    && state.external.includes('https://example.com/probe-shell')
    && (await app.windows()).length === 1,
)

await page.evaluate(() => {
  const anchor = document.createElement('a')
  anchor.href = '/api/export/vocab.csv'
  anchor.download = 'vocab.csv'
  document.body.append(anchor)
  anchor.click()
  anchor.remove()
})
for (let attempt = 0; attempt < 20; attempt += 1) {
  state = await readProbe()
  if (state.downloads.length > 0) break
  await page.waitForTimeout(250)
}
const saved = readdirSync(downloadDir)
check(
  '下载落盘',
  state.downloads.some((entry) => entry.startsWith('completed:'))
    && saved.length === 1
    && existsSync(join(downloadDir, saved[0])),
  saved.join(', ') || '目录为空',
)

await page.goto(`${appUrl}/read`)
await page.waitForSelector('.import-card', { timeout: 30_000 })
let uploadSeen = false
await page.route('**/api/books/upload', async (route) => {
  uploadSeen = true
  await route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ detail: 'probe' }) })
})
const transfer = await page.evaluateHandle(() => {
  const data = new DataTransfer()
  data.items.add(new File(['probe'], 'probe.txt', { type: 'text/plain' }))
  return data
})
await page.dispatchEvent('.import-card', 'drop', { dataTransfer: transfer })
await page.waitForTimeout(1000)
check('文件拖放到导入卡', uploadSeen)

const browserCapabilities = await page.evaluate(() => ({
  microphone: typeof navigator.mediaDevices?.getUserMedia === 'function',
  fullscreen: document.fullscreenEnabled,
  webm: typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported('audio/webm;codecs=opus'),
}))
check('麦克风 API 可用', browserCapabilities.microphone)
check('全屏 API 可用', browserCapabilities.fullscreen)
check('MediaRecorder 支持 webm/opus', browserCapabilities.webm)
const microphone = await app.evaluate(({ systemPreferences }) =>
  process.platform === 'darwin' ? systemPreferences.getMediaAccessStatus('microphone') : 'n/a',
)
info('麦克风系统权限状态', microphone)

await page.goto(`${appUrl}/jarvis`)
await page.waitForURL(`${appUrl}/`)
check('退场路由不再可访问', new URL(page.url()).pathname === '/')

await page.goto(`${appUrl}/studio/canvas`)
await page.waitForSelector('#main', { timeout: 30_000 })
await page.waitForTimeout(1000)
check('工坊画布列表页渲染', (await page.locator('#main *').count()) > 20)
state = await readProbe()
check('托盘已创建', state.tray === true)

await app.close()
const failures = results.filter((result) => result.ok === false)
console.log(`\n${results.length - failures.length} 项通过，${failures.length} 项失败`)
process.exit(failures.length === 0 ? 0 : 1)
