import { BrowserWindow, WebContentsView, ipcMain, session } from 'electron'
import type { Session } from 'electron'
import { youtubeNavigation, youtubeResource } from './youtube-policy.js'

export const YOUTUBE_PARTITION = 'persist:nexus-youtube'
let view: WebContentsView | null = null
let owner: BrowserWindow | null = null
let idle: ReturnType<typeof setTimeout> | undefined
let lastUrl = 'https://www.youtube.com/'
let error: string | null = null
let securedPartition = false
const attachedWindows = new WeakSet<BrowserWindow>()

function release() {
  clearTimeout(idle)
  if (view) {
    if (owner && !owner.isDestroyed()) owner.contentView.removeChildView(view)
    if (!view.webContents.isDestroyed()) view.webContents.close()
  }
  view = null
  owner = null
}

function pause() {
  if (!view) return
  view.webContents.setAudioMuted(true)
  void view.webContents.executeJavaScript('document.querySelectorAll("video,audio").forEach(media => media.pause())')
    .catch(() => { error = '页面正在切换，声音已静音' })
}

export function hideYoutube() {
  if (!view) return
  pause()
  view.setVisible(false)
  clearTimeout(idle)
  idle = setTimeout(release, 5 * 60_000)
}

export function youtubeSession(): Session {
  return session.fromPartition(YOUTUBE_PARTITION)
}

function ensure(window: BrowserWindow) {
  if (view) return view
  const partition = youtubeSession()
  if (!securedPartition) {
    partition.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
    partition.setPermissionCheckHandler(() => false)
    partition.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !youtubeResource(details.url) }))
    partition.on('will-download', event => event.preventDefault())
    securedPartition = true
  }
  view = new WebContentsView({ webPreferences: {
    partition: YOUTUBE_PARTITION, sandbox: true, contextIsolation: true, nodeIntegration: false,
    webSecurity: true, allowRunningInsecureContent: false,
  } })
  owner = window
  view.setVisible(false)
  const contents = view.webContents
  contents.setAudioMuted(true)
  contents.setWindowOpenHandler(() => ({ action: 'deny' }))
  contents.on('will-navigate', (event, url) => { if (!youtubeNavigation(url)) event.preventDefault() })
  contents.on('will-redirect', (event, url) => { if (!youtubeNavigation(url)) event.preventDefault() })
  contents.on('did-navigate', (_event, url) => { if (youtubeNavigation(url)) lastUrl = url })
  contents.on('did-navigate-in-page', (_event, url) => { if (youtubeNavigation(url)) lastUrl = url })
  contents.on('did-fail-load', (_event, code, description, _url, mainFrame) => {
    if (mainFrame && code !== -3) error = `页面加载失败：${description}`
  })
  window.contentView.addChildView(view)
  if (!attachedWindows.has(window)) {
    attachedWindows.add(window)
    window.once('closed', release)
    window.on('hide', hideYoutube)
    window.webContents.on('did-start-navigation', (_event, _url, _inPlace, mainFrame) => { if (mainFrame) hideYoutube() })
  }
  return view
}

export function installYoutubeIpc(getWindow: () => BrowserWindow | null, appOrigin: () => string) {
  ipcMain.handle('youtube:command', async (event, command: unknown) => {
    const window = getWindow()
    if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame
      || new URL(event.senderFrame.url).origin !== appOrigin()) throw new Error('无效的浏览命令来源')
    if (!command || typeof command !== 'object' || !('action' in command)) throw new Error('无效浏览命令')
    const data = command as Record<string, unknown>
    if (data.action === 'hide') { hideYoutube(); return { url: lastUrl } }
    if (data.action === 'state') return {
      url: view?.webContents.getURL() || lastUrl,
      title: view?.webContents.getTitle() ?? '',
      canGoBack: view?.webContents.navigationHistory.canGoBack() ?? false,
      canGoForward: view?.webContents.navigationHistory.canGoForward() ?? false,
      loading: view?.webContents.isLoading() ?? false, error,
    }
    if (!['show', 'navigate', 'back', 'forward', 'reload'].includes(String(data.action))) throw new Error('未知浏览命令')
    if (data.action === 'navigate' && (typeof data.url !== 'string' || !youtubeNavigation(data.url))) throw new Error('仅允许 HTTPS YouTube 地址')
    const current = ensure(window)
    if (data.action === 'show') {
      const bounds = data.bounds as Record<string, unknown> | undefined
      if (!bounds || !['x', 'y', 'width', 'height'].every(k => typeof bounds[k] === 'number' && Number.isFinite(bounds[k]))) throw new Error('无效视图尺寸')
      const zoom = window.webContents.getZoomFactor()
      const [width, height] = window.getContentSize()
      const x = Math.max(0, Math.min(width, Math.round(Number(bounds.x) * zoom)))
      const y = Math.max(0, Math.min(height, Math.round(Number(bounds.y) * zoom)))
      current.setBounds({ x, y, width: Math.max(0, Math.min(width - x, Math.round(Number(bounds.width) * zoom))), height: Math.max(0, Math.min(height - y, Math.round(Number(bounds.height) * zoom))) })
      clearTimeout(idle)
      current.setVisible(true)
      current.webContents.setAudioMuted(false)
      if (!current.webContents.getURL()) void current.webContents.loadURL(lastUrl).catch(() => { error = '无法加载 YouTube，请检查网络与代理' })
    } else if (data.action === 'navigate') {
      lastUrl = youtubeNavigation(String(data.url))!
      error = null
      await current.webContents.loadURL(lastUrl)
    } else if (data.action === 'back' && current.webContents.navigationHistory.canGoBack()) current.webContents.navigationHistory.goBack()
    else if (data.action === 'forward' && current.webContents.navigationHistory.canGoForward()) current.webContents.navigationHistory.goForward()
    else if (data.action === 'reload') { error = null; current.webContents.reload() }
    return { url: lastUrl }
  })
}
