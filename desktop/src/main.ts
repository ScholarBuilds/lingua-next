import { spawn, type ChildProcess } from 'node:child_process'
import { createPublicKey, randomBytes } from 'node:crypto'
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  net,
  Notification,
  session,
  shell,
  systemPreferences,
  Tray,
} from 'electron'
import { autoUpdater } from 'electron-updater'
import { GenericProvider } from 'electron-updater/out/providers/GenericProvider'
import { parseUpdateInfo } from 'electron-updater/out/providers/Provider'
import type { ProviderRuntimeOptions } from 'electron-updater/out/providers/Provider'
import type { AppUpdater } from 'electron-updater/out/AppUpdater'

import { clientProxyConfig, resolveApiBase } from './api'
import { verifyUpdateManifest } from './update-manifest'
import { augmentedPath, mergePath, resolveExecutable } from './paths'
import { externalUrl, trustedFrame, restartAttempt, restartDelay } from './runtime-policy'

const PROBE = process.env.LINGUA_PROBE === '1'
const CLOSE_HIDES = !PROBE || process.env.LINGUA_PROBE_CLOSE_HIDE === '1'
if (process.env.LINGUA_USER_DATA) {
  app.setPath('userData', process.env.LINGUA_USER_DATA)
} else if (app.isPackaged) {
  app.setPath('userData', path.join(app.getPath('appData'), 'NEXUS'))
}
app.setName('NEXUS')

interface LaunchMemory {
  appUrl?: string
  apiUrl?: string
  repoRoot?: string
}

interface ProbeState {
  external: string[]
  downloads: string[]
  tray: boolean
  ipc: Record<string, number>
  mainWindowId: number | null
  apiBase: string | null
  resolvedPath: string
}

interface SidecarReady {
  type: 'ready'
  host: string
  port: number
}

const launchMemory = readLaunchMemory()
let appUrl = process.env.LINGUA_URL ?? launchMemory.appUrl ?? 'http://127.0.0.1:8080'
let appOrigin = new URL(appUrl).origin
const API_URL_HINT = process.env.LINGUA_API_URL ?? launchMemory.apiUrl
const REPO_ROOT = process.env.LINGUA_REPO_ROOT ?? launchMemory.repoRoot ?? path.resolve(__dirname, '..', '..')
const AUTOSTART = (process.env.LINGUA_AUTOSTART ?? (app.isPackaged ? '1' : '0')) === '1'
const PRELOAD = path.join(__dirname, 'preload.js')
const SERVICE_HEALTHCHECK_MS = 5000
const CRASH_RELOAD_COOLDOWN_MS = 10_000
const singleInstanceLock = PROBE || app.requestSingleInstanceLock()

if (!singleInstanceLock) app.quit()

const probe: ProbeState = {
  external: [],
  downloads: [],
  tray: false,
  ipc: {},
  mainWindowId: null,
  apiBase: null,
  resolvedPath: process.env.PATH ?? '',
}
;(globalThis as { __probe?: ProbeState }).__probe = probe

let win: BrowserWindow | null = null
let tray: Tray | null = null
let quitting = false
let appStarted = false
let lastCrashReload = 0
let startupToken = ''
let apiBase = apiCandidates()[0]
let apiBaseVerified = false
let serviceHealthTimer: NodeJS.Timeout | null = null
let sidecarRestartTimer: NodeJS.Timeout | null = null
let sidecarRestartAttempts = 0
let updateTimer: NodeJS.Timeout | null = null
const children: ChildProcess[] = []
const serviceChildren = new Map<string, ChildProcess>()

function launchMemoryPath(): string {
  return path.join(app.getPath('userData'), 'launch.json')
}

function readLaunchMemory(): LaunchMemory {
  const file = launchMemoryPath()
  if (!existsSync(file)) return {}
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
    const pick = (key: string): string | undefined => typeof raw[key] === 'string' ? raw[key] : undefined
    return { appUrl: pick('appUrl'), apiUrl: pick('apiUrl'), repoRoot: pick('repoRoot') }
  } catch (error) {
    console.warn(`[WARN] ${file} 读不了，忽略：${String(error)}`)
    return {}
  }
}

function rememberLaunch(): void {
  if (!process.env.LINGUA_URL && !process.env.LINGUA_API_URL && !process.env.LINGUA_REPO_ROOT) return
  try {
    mkdirSync(app.getPath('userData'), { recursive: true })
    writeFileSync(
      launchMemoryPath(),
      JSON.stringify({ appUrl, apiUrl: API_URL_HINT, repoRoot: REPO_ROOT } satisfies LaunchMemory, null, 2),
    )
  } catch (error) {
    console.warn(`[WARN] 写不了启动配置：${String(error)}`)
  }
}

function apiCandidates(): string[] {
  const candidates = [API_URL_HINT, `${appUrl}/api`, 'http://127.0.0.1:8100']
  return [...new Set(candidates.filter((candidate): candidate is string => typeof candidate === 'string'))]
}

function runtimeFetch(input: string, init: RequestInit = {}): Promise<Response> {
  if (!startupToken) return fetch(input, init)
  const headers = new Headers(init.headers)
  headers.set('X-NEXUS-Startup-Token', startupToken)
  return fetch(input, { ...init, headers })
}

async function refreshApiBase(): Promise<boolean> {
  try {
    apiBase = await resolveApiBase(apiCandidates(), runtimeFetch)
    apiBaseVerified = true
    probe.apiBase = apiBase
    return true
  } catch {
    apiBaseVerified = false
    probe.apiBase = null
    return false
  }
}

function openExternal(target: string): void {
  const url = externalUrl(target)
  if (url === null) throw new Error('不支持此外链协议')
  probe.external.push(url)
  if (!PROBE) void shell.openExternal(url)
}

function focusWindow(): BrowserWindow {
  if (win === null || win.isDestroyed()) createMainWindow(false)
  const current = win as BrowserWindow
  if (current.isMinimized()) current.restore()
  current.show()
  current.focus()
  return current
}

interface UpdateFeedConfig {
  url: string
  publicKey: string
}

function configuredUpdateFeed(): UpdateFeedConfig | undefined {
  if (!app.isPackaged) return undefined
  const configPath = path.join(process.resourcesPath, 'runtime', 'release-config.json')
  try {
    const payload = JSON.parse(readFileSync(configPath, 'utf8')) as {
      updateUrl?: unknown
      updatePublicKey?: unknown
    }
    if (typeof payload.updateUrl !== 'string' || typeof payload.updatePublicKey !== 'string') return undefined
    const url = new URL(payload.updateUrl)
    if (url.protocol !== 'https:') return undefined
    createPublicKey({ key: Buffer.from(payload.updatePublicKey, 'base64'), format: 'der', type: 'spki' })
    return { url: url.toString(), publicKey: payload.updatePublicKey }
  } catch (error) {
    console.warn(`[WARN] 更新配置不可用：${String(error)}`)
    return undefined
  }
}


function configureUpdates(): void {
  const feed = configuredUpdateFeed()
  if (feed === undefined) return
  const feedUrl = feed.url
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.allowDowngrade = false
  autoUpdater.on('error', (error) => console.warn(`[WARN] 更新检查失败：${String(error)}`))
  autoUpdater.on('update-downloaded', (info) => {
    if (!Notification.isSupported()) return
    new Notification({ title: `NEXUS ${info.version} 已下载`, body: '更新会在退出应用后安装' }).show()
  })
  const check = (): void => {
    void verifyUpdateManifest(feed, net.fetch.bind(net)).then((metadata) => {
      class VerifiedProvider extends GenericProvider {
        constructor(_options: unknown, updater: AppUpdater, runtime: ProviderRuntimeOptions) {
          super({ provider: 'generic', url: feedUrl }, updater, runtime)
        }
        async getLatestVersion() {
          return parseUpdateInfo(metadata, 'latest-mac.yml', new URL('latest-mac.yml', feedUrl))
        }
      }
      autoUpdater.setFeedURL({ provider: 'custom', updateProvider: VerifiedProvider, url: feed.url })
      return autoUpdater.checkForUpdates()
    }).catch((error) => {
      console.warn(`[WARN] 更新检查失败：${String(error)}`)
    })
  }
  setTimeout(check, 10_000)
  updateTimer = setInterval(check, 6 * 60 * 60 * 1000)
}

function createTray(): void {
  const iconPath = path.join(__dirname, '..', 'assets', 'trayTemplate.png')
  const icon = existsSync(iconPath) ? nativeImage.createFromPath(iconPath) : nativeImage.createEmpty()
  icon.setTemplateImage(true)
  tray = new Tray(icon)
  tray.setToolTip('NEXUS')
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '打开工作台', click: () => void focusWindow() },
    { type: 'separator' },
    { label: '退出 NEXUS', click: () => app.quit() },
  ]))
  tray.on('click', () => void focusWindow())
  probe.tray = true
}

function desktopRuntimePaths(): {
  root: string
  database: string
  media: string
  logs: string
  backups: string
  models: string
  cache: string
} {
  const root = app.getPath('userData')
  return {
    root,
    database: path.join(root, 'nexus.sqlite3'),
    media: path.join(root, 'media'),
    logs: path.join(root, 'logs'),
    backups: path.join(root, 'backups'),
    models: path.join(root, 'models'),
    cache: path.join(homedir(), 'Library', 'Caches', 'NEXUS'),
  }
}

function waitForSidecar(child: ChildProcess): Promise<SidecarReady> {
  return new Promise((resolve, reject) => {
    let pending = ''
    const timer = setTimeout(() => finish(new Error('本地运行时启动超时')), 180_000)
    const finish = (error?: Error, ready?: SidecarReady): void => {
      clearTimeout(timer)
      child.stdout?.removeAllListeners('data')
      child.removeListener('error', onError)
      child.removeListener('exit', onExit)
      if (error !== undefined) {
        child.kill()
        const forceStop = setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
        }, 3_000)
        forceStop.unref()
        child.once('exit', () => clearTimeout(forceStop))
        reject(error)
      }
      else if (ready !== undefined) resolve(ready)
    }
    const onError = (error: Error): void => finish(error)
    const onExit = (code: number | null): void => finish(new Error(`本地运行时提前退出：${code ?? 'signal'}`))
    child.once('error', onError)
    child.once('exit', onExit)
    child.stdout?.on('data', (chunk: Buffer) => {
      pending += chunk.toString('utf8')
      let newline = pending.indexOf('\n')
      while (newline >= 0) {
        const line = pending.slice(0, newline).trim()
        pending = pending.slice(newline + 1)
        newline = pending.indexOf('\n')
        if (!line) continue
        try {
          const value = JSON.parse(line) as Partial<SidecarReady> & { message?: string }
          if (String(value.type) === 'content-warning' && typeof value.message === 'string') {
            void dialog.showMessageBox({ type: 'warning', title: '部分内置内容待合并', message: value.message })
            continue
          }
          if (value.type !== 'ready') continue
          if (value.host !== '127.0.0.1' || !Number.isInteger(value.port)) {
            finish(new Error('本地运行时返回了无效的启动握手'))
            return
          }
          finish(undefined, value as SidecarReady)
          return
        } catch {
          continue
        }
      }
      if (pending.length > 64 * 1024) pending = pending.slice(-64 * 1024)
    })
  })
}

/** 包内内容戳（基线库 + 种子目录的哈希，prepare-runtime 产出）；老包没有就退回版本号 */
function bundledContentStamp(resourceRoot: string): string {
  try {
    const raw = JSON.parse(readFileSync(path.join(resourceRoot, 'content-stamp.json'), 'utf8')) as { stamp?: unknown }
    if (typeof raw.stamp === 'string' && raw.stamp !== '') return raw.stamp
  } catch {
    /* 老包没有这个文件 */
  }
  return app.getVersion()
}

/* 安装包带的内容种子：内置书 / 封面 / 音位示范音 / 视频（media-seed）、讲义正文（grammar-seed）、
   whisper 模型（models-seed）。按内容戳铺，同一个版本号换了内容再装也会补齐；已有的文件不覆盖——
   用户自己的 media 里同名文件不能被装包覆掉 */
function seedRuntimeData(resourceRoot: string, runtime: ReturnType<typeof desktopRuntimePaths>, stamp: string): void {
  const marker = path.join(runtime.root, `.seeded-${stamp}`)
  if (existsSync(marker)) return
  const pairs: Array<[string, string]> = [
    [path.join(resourceRoot, 'media-seed'), runtime.media],
    [path.join(resourceRoot, 'grammar-seed'), path.join(runtime.root, 'grammar')],
    [path.join(resourceRoot, 'models-seed'), runtime.models],
  ]
  for (const [from, to] of pairs) {
    if (!existsSync(from)) continue
    cpSync(from, to, { recursive: true, force: false, errorOnExist: false })
  }
  writeFileSync(marker, `${new Date().toISOString()}\n`)
}

let sidecarStarting: Promise<void> | null = null
let sidecarReadyAt = 0

function startBundledRuntime(): Promise<void> {
  if (sidecarStarting) return sidecarStarting
  sidecarStarting = launchBundledRuntime().finally(() => { sidecarStarting = null })
  return sidecarStarting
}

async function launchBundledRuntime(): Promise<void> {
  const current = serviceChildren.get('sidecar')
  if (current !== undefined && current.exitCode === null) return
  const runtime = desktopRuntimePaths()
  for (const dir of [runtime.root, runtime.media, runtime.logs, runtime.backups, runtime.models, runtime.cache]) {
    mkdirSync(dir, { recursive: true })
  }
  const resourceRoot = path.join(process.resourcesPath, 'runtime')
  const sidecar = path.join(resourceRoot, 'sidecar', 'nexus-sidecar')
  const baseline = path.join(resourceRoot, 'desktop-baseline.sqlite3')
  const stamp = bundledContentStamp(resourceRoot)
  // 随包的配置（模型 / 语音 / 生图凭据、部署、绑定、音色、设置）：两个文件都在才交给 sidecar 合并，
  // 不带配置的包什么都不传
  const bundleConfig = path.join(resourceRoot, 'bundle-config.sqlite3')
  const bundleVaultKey = path.join(resourceRoot, 'bundle-vault.key')
  const bundledConfigEnv =
    existsSync(bundleConfig) && existsSync(bundleVaultKey)
      ? { LINGUA_DESKTOP_BUNDLE_CONFIG: bundleConfig, LINGUA_DESKTOP_BUNDLE_VAULT_KEY: bundleVaultKey }
      : {}
  if (!existsSync(runtime.database)) {
    if (!existsSync(baseline)) throw new Error(`安装包缺少 SQLite 基线：${baseline}`)
    copyFileSync(baseline, runtime.database)
    // 整份拷过来的库就是包里的内容：戳直接写上，sidecar 不用再合并一遍
    writeFileSync(
      path.join(runtime.root, 'content-stamp.json'),
      `${JSON.stringify({ schema: 1, stamp, at: new Date().toISOString() }, null, 2)}\n`,
    )
  }
  seedRuntimeData(resourceRoot, runtime, stamp)
  if (!existsSync(sidecar)) throw new Error(`安装包缺少本地运行时：${sidecar}`)
  startupToken = randomBytes(32).toString('base64url')
  const logFile = openSync(path.join(runtime.logs, 'sidecar.log'), 'a')
  const child = spawn(sidecar, [], {
    stdio: ['ignore', 'pipe', logFile],
    env: {
      ...process.env,
      // 随包的 ffmpeg / deno 排在最前：sidecar 用 shutil.which 找，别人机器上没有 Homebrew
      PATH: mergePath(path.join(resourceRoot, 'bin'), process.env.PATH),
      // 首次转写要从 HuggingFace 拉模型，直连在国内多半不通；用户自己配了端点就照他的
      HF_ENDPOINT: process.env.HF_ENDPOINT ?? 'https://hf-mirror.com',
      LINGUA_RUNTIME_PROFILE: 'desktop',
      LINGUA_DATABASE_URL: `sqlite+aiosqlite:///${runtime.database}`,
      // 库已存在而包换了内容时，sidecar 启动把基线里缺的内容表合并进来
      LINGUA_DESKTOP_BASELINE: baseline,
      LINGUA_DESKTOP_CONTENT_STAMP: stamp,
      ...bundledConfigEnv,
      LINGUA_DESKTOP_QUEUE_PATH: path.join(runtime.root, 'queue.sqlite3'),
      LINGUA_MEDIA_ROOT: runtime.media,
      LINGUA_LOCAL_MODELS_ROOT: runtime.models,
      HF_HOME: path.join(runtime.models, 'huggingface'),
      HUGGINGFACE_HUB_CACHE: path.join(runtime.models, 'huggingface', 'hub'),
      LINGUA_GRAMMAR_DOCS_ROOT: path.join(runtime.root, 'grammar'),
      LINGUA_GRAMMAR_DOCS_BACKUP_DIR: path.join(runtime.backups, 'grammar'),
      LINGUA_DESKTOP_STARTUP_TOKEN: startupToken,
      LINGUA_DESKTOP_WEB_ROOT: path.join(resourceRoot, 'web'),
      LINGUA_SCENARIOS_DIR: path.join(resourceRoot, 'scenarios'),
      LINGUA_SCENARIO_SEEDS_PATH: path.join(resourceRoot, 'scenario-deck-seeds.yaml'),
      LINGUA_VAULT_KEY_BACKEND: 'file',
    },
  })
  children.push(child)
  serviceChildren.set('sidecar', child)
  let ready: SidecarReady
  try { ready = await waitForSidecar(child) }
  catch (error) {
    if (serviceChildren.get('sidecar') === child) serviceChildren.delete('sidecar')
    throw error
  }
  appUrl = `http://${ready.host}:${ready.port}`
  appOrigin = appUrl
  apiBase = `${appUrl}/api`
  apiBaseVerified = false
  session.defaultSession.webRequest.onBeforeSendHeaders(
    { urls: [`${appUrl}/*`] },
    (details, callback) => callback({
      requestHeaders: { ...details.requestHeaders, 'X-Nexus-Startup-Token': startupToken },
    }),
  )
  sidecarReadyAt = Date.now()
  child.on('exit', (code) => {
    if (serviceChildren.get('sidecar') === child) serviceChildren.delete('sidecar')
    if (!quitting) {
      console.error(`[ERROR] 本地运行时退出，code=${code ?? 'signal'}`)
      scheduleSidecarRestart()
    }
  })
}

function scheduleSidecarRestart(): void {
  if (sidecarRestartTimer !== null || quitting) return
  sidecarRestartAttempts = restartAttempt(sidecarRestartAttempts, sidecarReadyAt, Date.now())
  sidecarReadyAt = 0
  const delay = restartDelay(sidecarRestartAttempts)
  if (delay === null) {
    void dialog.showMessageBox({ type: 'error', title: '本地服务连续启动失败',
      message: '自动重启已停止，学习数据仍保留。', buttons: ['重新尝试', '打开日志目录', '退出'],
    }).then(({ response }) => {
      if (response === 0) { sidecarRestartAttempts = 0; scheduleSidecarRestart() }
      else if (response === 1) void shell.openPath(desktopRuntimePaths().logs)
      else app.quit()
    })
    return
  }
  sidecarRestartTimer = setTimeout(() => {
    sidecarRestartTimer = null
    void startBundledRuntime()
      .then(() => {
        if (win === null || win.isDestroyed()) return
        const currentUrl = win.webContents.getURL()
        const route = URL.canParse(currentUrl)
          ? `${new URL(currentUrl).pathname}${new URL(currentUrl).search}`
          : '/'
        void win.loadURL(new URL(route, appUrl).toString())
      })
      .catch((error) => {
        console.error(`[ERROR] 本地运行时重启失败：${String(error)}`)
        scheduleSidecarRestart()
      })
  }, delay)
}

function startManagedService(name: string, args: string[], serverDir: string, env: NodeJS.ProcessEnv): void {
  const current = serviceChildren.get(name)
  if (current !== undefined && current.exitCode === null) return
  const uv = resolveExecutable('uv', process.env.PATH ?? '')
  if (uv === undefined) {
    console.warn(`[WARN] PATH 里没有 uv，拉不起 ${name}`)
    return
  }
  const logDir = path.join(REPO_ROOT, 'data', 'logs')
  mkdirSync(logDir, { recursive: true })
  const out = openSync(path.join(logDir, `${name}.log`), 'a')
  const child = spawn(uv, ['run', ...args], { cwd: serverDir, stdio: ['ignore', out, out], env })
  children.push(child)
  serviceChildren.set(name, child)
  const runDir = path.join(REPO_ROOT, 'data', 'run')
  mkdirSync(runDir, { recursive: true })
  if (child.pid !== undefined) writeFileSync(path.join(runDir, `${name}.pid`), String(child.pid))
  child.on('exit', () => {
    if (serviceChildren.get(name) === child) serviceChildren.delete(name)
  })
}

function pidFileIsLive(name: string): boolean {
  try {
    const pid = Number.parseInt(readFileSync(path.join(REPO_ROOT, 'data', 'run', `${name}.pid`), 'utf8'), 10)
    if (!Number.isInteger(pid) || pid <= 0) return false
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function autostartServices(): Promise<void> {
  if (!AUTOSTART || app.isPackaged) return
  const serverDir = path.join(REPO_ROOT, 'server')
  if (!existsSync(serverDir)) {
    console.warn(`[WARN] 找不到 ${serverDir}，无法启动本地 API`)
    return
  }
  const env = { ...process.env, LINGUA_API_BASE_URL: 'http://127.0.0.1:8100' }
  if (!(await refreshApiBase())) {
    startManagedService('api', ['uvicorn', 'app.main:app', '--port', '8100'], serverDir, env)
  }
  if (!pidFileIsLive('worker')) {
    startManagedService('worker', ['arq', 'worker.main.WorkerSettings'], serverDir, env)
  }
  serviceHealthTimer = setInterval(() => {
    void refreshApiBase().then((healthy) => {
      if (!healthy) startManagedService('api', ['uvicorn', 'app.main:app', '--port', '8100'], serverDir, env)
    })
  }, SERVICE_HEALTHCHECK_MS)
}

function createMainWindow(startHidden: boolean, initialUrl = appUrl): void {
  const current = new BrowserWindow({
    width: 1440,
    height: 900,
    title: 'NEXUS',
    show: false,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    icon: path.join(__dirname, '..', 'assets', 'icon.png'),
    webPreferences: { preload: PRELOAD, contextIsolation: true, sandbox: true },
  })
  current.webContents.setWindowOpenHandler(({ url }) => {
    if (externalUrl(url)) openExternal(url)
    return { action: 'deny' }
  })
  current.webContents.on('will-navigate', (event, url) => {
    if (isAppOrigin(url)) return
    event.preventDefault()
    if (externalUrl(url)) openExternal(url)
  })
  current.webContents.on('will-redirect', (event, url) => {
    if (!isAppOrigin(url)) event.preventDefault()
  })
  current.once('ready-to-show', () => {
    if (!startHidden) current.show()
  })
  current.on('close', (event) => {
    if (process.platform === 'darwin' && !quitting && CLOSE_HIDES) {
      event.preventDefault()
      current.hide()
    }
  })
  current.on('closed', () => {
    if (win === current) win = null
  })
  current.webContents.on('render-process-gone', (_event, details) => {
    if (details.reason === 'clean-exit') return
    const now = Date.now()
    if (now - lastCrashReload < CRASH_RELOAD_COOLDOWN_MS) return
    lastCrashReload = now
    current.webContents.reload()
  })
  win = current
  probe.mainWindowId = current.id
  void current.loadURL(initialUrl)
}

/** 主窗口在本地服务起来之前先显示的加载页：不弹独立小窗，起来后原地 loadURL 换成应用 */
function startingPageUrl(): string {
  const html = readFileSync(path.join(__dirname, '..', 'assets', 'starting.html'), 'utf8')
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`
}

function isAppOrigin(url: string): boolean {
  return URL.canParse(url) && new URL(url).origin === appOrigin
}

function installSessionHandlers(): void {
  const current = session.defaultSession
  current.setPermissionRequestHandler((_contents, permission, callback, details) => {
    callback(
      isAppOrigin(details.requestingUrl)
      && (permission === 'media' || permission === 'fullscreen' || permission === 'notifications'),
    )
  })
  current.on('will-download', (_event, item) => {
    const dir = process.env.LINGUA_DOWNLOAD_DIR
    if (dir) item.setSavePath(path.join(dir, item.getFilename()))
    item.once('done', (_doneEvent, state) => {
      probe.downloads.push(`${state}:${item.getSavePath()}`)
    })
  })
}

function handle<Args extends unknown[]>(channel: string, listener: (...args: Args) => unknown): void {
  ipcMain.handle(channel, (event, ...args) => {
    if (event.sender !== win?.webContents || !trustedFrame(event.senderFrame?.url ?? '', appOrigin, event.senderFrame === event.sender.mainFrame)) {
      throw new Error('IPC 来源不受信任')
    }
    probe.ipc[channel] = (probe.ipc[channel] ?? 0) + 1
    return listener(...(args as Args))
  })
}

function installIpc(): void {
  handle('shell:open-external', (target: string) => openExternal(target))
  handle('shell:select-directory', async () => {
    const result = await dialog.showOpenDialog(focusWindow(), {
      title: '选择讲义目录',
      properties: ['openDirectory'],
    })
    return result.canceled ? null : (result.filePaths[0] ?? null)
  })
  handle('probe:state', () => ({
    ...probe,
    apiBase: apiBaseVerified ? apiBase : null,
    microphone: process.platform === 'darwin'
      ? systemPreferences.getMediaAccessStatus('microphone')
      : 'n/a',
  }))
}

app.on('second-instance', () => {
  if (app.isReady()) focusWindow()
})

let proxyTimer: ReturnType<typeof setInterval> | null = null
let appliedProxy: string | null = null
let syncingProxy = false

async function syncClientProxy(): Promise<void> {
  if (syncingProxy) return
  syncingProxy = true
  try {
    const response = await runtimeFetch(`${apiBase}/config/network`)
    if (!response.ok) return
    const policy = await response.json() as { enabled: boolean; scope: string; address: string }
    const address = policy.enabled && policy.scope === 'all' ? policy.address : ''
    if (address === appliedProxy) return
    await session.defaultSession.setProxy(clientProxyConfig(policy))
    appliedProxy = address
  } catch (error) {
    console.warn('客户端代理同步失败', error instanceof Error ? error.name : 'network')
  } finally {
    syncingProxy = false
  }
}

app.whenReady().then(async () => {
  if (!singleInstanceLock) return
  installSessionHandlers()
  installIpc()
  rememberLaunch()
  process.env.PATH = await augmentedPath()
  probe.resolvedPath = process.env.PATH
  const startHidden = process.argv.includes('--hidden')
    || (process.platform === 'darwin' && app.getLoginItemSettings().wasOpenedAtLogin)
  if (app.isPackaged && AUTOSTART) {
    /* 主窗口先显示内置加载页，服务起来后原地换成应用；不再弹独立的启动小窗（旧文案还在说
       「引擎」「钥匙串」）。appStarted 要在这里就置位：窗口一旦被关又没主窗口，window-all-closed
       会把壳退掉 */
    if (!startHidden) {
      createMainWindow(false, startingPageUrl())
      appStarted = true
    }
    try {
      await startBundledRuntime()
    } catch (error) {
      const { response } = await dialog.showMessageBox({ type: 'error', title: 'NEXUS 启动恢复',
        message: '本地服务未启动，原有数据已保留', detail: String(error),
        buttons: ['重新启动', '打开备份目录', '退出'],
      })
      if (response === 1) await shell.openPath(desktopRuntimePaths().backups)
      if (response === 0) app.relaunch()
      app.quit()
      return
    }
  }
  await refreshApiBase()
  await autostartServices()
  await session.defaultSession.setProxy({ mode: 'direct' })
  await syncClientProxy()
  proxyTimer = setInterval(() => void syncClientProxy(), 3000)
  const dockIcon = path.join(__dirname, '..', 'assets', 'icon.png')
  if (process.platform === 'darwin' && existsSync(dockIcon)) app.dock?.setIcon(nativeImage.createFromPath(dockIcon))
  if (win !== null && !win.isDestroyed()) void win.loadURL(appUrl)
  else createMainWindow(startHidden)
  createTray()
  appStarted = true
  if (!PROBE) configureUpdates()
  app.on('activate', () => {
    if (win === null || win.isDestroyed() || !win.isVisible()) focusWindow()
  })
})

app.on('before-quit', () => {
  quitting = true
})

app.on('will-quit', () => {
  if (proxyTimer !== null) clearInterval(proxyTimer)
  if (serviceHealthTimer !== null) clearInterval(serviceHealthTimer)
  if (sidecarRestartTimer !== null) clearTimeout(sidecarRestartTimer)
  if (updateTimer !== null) clearInterval(updateTimer)
  for (const child of children) {
    if (child.exitCode === null) child.kill()
  }
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin' || PROBE || !appStarted) app.quit()
})
