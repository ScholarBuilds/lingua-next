/* 基础修图（FR-440）。编辑器本体是 react-filerobot-image-editor，这里只包三件事：
   全屏浮层外壳、中文词条与主题对接、把它导出的画布转成 Blob 交给上层存盘。

   > [!warning] 这个包是 beta 生态，依赖 styled-components 与 @scaleflex/ui
   >
   > 动态 import 失败、渲染期抛错都会白屏。所以走「动态导入 + 错误边界」双保险，
   > 任何一环挂了都落到可读的中文错误面板，而不是一片空白。 */

import { Component, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ErrorInfo, ReactNode } from 'react'
import { toast } from 'sonner'
import type { FilerobotImageEditorConfig } from 'react-filerobot-image-editor'
import { useEscapeClose } from '@/components/Overlay'
import './RetouchStudio.css'

/** 编辑器 onSave 回调给的数据。它的 .d.ts 没导出这个类型，按实际产出字段声明。
    `useTransformedImgData` 里 imageCanvas 与 imageBase64 是一起给的，quality 只在
    jpeg/webp 时出现（0~1）。 */
interface FieSavedImage {
  name?: string
  extension?: string
  mimeType?: string
  fullName?: string
  width?: number
  height?: number
  imageBase64?: string
  imageCanvas?: HTMLCanvasElement
  quality?: number
}

type FieModule = typeof import('react-filerobot-image-editor')

/* ---------- 中文词条 ---------- */

/* key 全部来自包内 context/defaultTranslations.js，一个没编。译不准的宁可贴近原文，
   也不自己发明 key——发明的 key 只会被忽略，白改一遍。 */
const ZH: Record<string, string> = {
  name: '名称',
  save: '保存',
  saveAs: '另存为',
  back: '返回',
  loading: '加载中…',
  resetOperations: '重置全部操作',
  changesLoseWarningHint: '点「重置」会丢掉当前所有改动，确定继续？',
  discardChangesWarningHint: '关掉窗口，最近这次改动不会保存。',
  cancel: '取消',
  apply: '应用',
  warning: '提醒',
  confirm: '确定',
  discardChanges: '放弃改动',
  undoTitle: '撤销上一步',
  redoTitle: '重做上一步',
  showImageTitle: '查看原图',
  zoomInTitle: '放大',
  zoomOutTitle: '缩小',
  toggleZoomMenuTitle: '缩放菜单',
  adjustTab: '调整',
  finetuneTab: '微调',
  filtersTab: '滤镜',
  watermarkTab: '水印',
  annotateTabLabel: '标注',
  resize: '改尺寸',
  resizeTab: '改尺寸',
  imageName: '图片名称',
  invalidImageError: '图片无效。',
  uploadImageError: '上传图片出错。',
  areNotImages: '不是图片',
  isNotImage: '不是图片',
  toBeUploaded: '待上传',
  cropTool: '裁剪',
  original: '原始比例',
  custom: '自定义',
  square: '正方形',
  landscape: '横向',
  portrait: '竖向',
  ellipse: '椭圆',
  classicTv: '传统电视 4:3',
  cinemascope: '宽银幕',
  arrowTool: '箭头',
  blurTool: '模糊',
  brightnessTool: '亮度',
  contrastTool: '对比度',
  ellipseTool: '椭圆',
  unFlipX: '取消水平翻转',
  flipX: '水平翻转',
  unFlipY: '取消垂直翻转',
  flipY: '垂直翻转',
  hsvTool: '色相饱和度',
  hue: '色相',
  brightness: '亮度',
  saturation: '饱和度',
  value: '明度',
  imageTool: '贴图',
  importing: '导入中…',
  addImage: '+ 加一张图',
  uploadImage: '上传图片',
  fromGallery: '从图库选',
  lineTool: '直线',
  penTool: '画笔',
  polygonTool: '多边形',
  sides: '边数',
  rectangleTool: '矩形',
  cornerRadius: '圆角',
  resizeWidthTitle: '宽度（像素）',
  resizeHeightTitle: '高度（像素）',
  toggleRatioLockTitle: '锁定宽高比',
  resetSize: '恢复原始尺寸',
  rotateTool: '旋转',
  textTool: '文字',
  textSpacings: '文字间距',
  textAlignment: '对齐方式',
  fontFamily: '字体',
  size: '字号',
  letterSpacing: '字间距',
  lineHeight: '行高',
  warmthTool: '色温',
  addWatermark: '+ 加水印',
  addTextWatermark: '+ 加文字水印',
  addWatermarkTitle: '选择水印类型',
  uploadWatermark: '上传水印图',
  addWatermarkAsText: '用文字做水印',
  padding: '内边距',
  paddings: '内边距',
  shadow: '阴影',
  horizontal: '水平',
  vertical: '垂直',
  blur: '模糊',
  opacity: '不透明度',
  transparency: '透明度',
  position: '位置',
  stroke: '描边',
  saveAsModalTitle: '另存为',
  extension: '扩展名',
  format: '格式',
  nameIsRequired: '得先填名称。',
  quality: '画质',
  imageDimensionsHoverTitle: '导出尺寸（宽 × 高）',
  cropSizeLowerThanResizedWarning: '裁剪区域比设定的输出尺寸还小，放大后画质会掉',
  actualSize: '实际大小（100%）',
  fitSize: '适应窗口',
  addImageTitle: '选一张要贴上去的图…',
  mutualizedFailedToLoadImg: '图片加载失败。',
  tabsMenu: '菜单',
  download: '下载',
  width: '宽',
  height: '高',
  cropItemNoEffect: '这个比例没有预览',
}

/** 文字与水印可选字体。带中文字形的排在前面，免得输入中文变方块 */
const FONTS = [
  { label: '苹方（macOS）', value: 'PingFang SC' },
  { label: '微软雅黑（Windows）', value: 'Microsoft YaHei' },
  { label: '黑体', value: 'Heiti SC' },
  { label: '宋体', value: 'Songti SC' },
  { label: 'Arial', value: 'Arial' },
  { label: 'Georgia', value: 'Georgia' },
  { label: 'Impact', value: 'Impact' },
  { label: 'Courier New', value: 'Courier New' },
]

/* ---------- 主题：把本仓令牌喂给编辑器 ---------- */

interface FieSkin {
  palette: Record<string, string>
  typography: { fontFamily: string }
}

/* 令牌取不到就不写这个键，让编辑器用它自己的默认色——凭空造一个色值只会撞色 */
function readSkin(): FieSkin {
  const style = getComputedStyle(document.documentElement)
  const token = (name: string): string => style.getPropertyValue(name).trim()

  const accent = token('--accent')
  const accentHover = token('--accent-hover')
  const accentSoft = token('--accent-soft')
  const onAccent = token('--on-accent')
  const surface = token('--bg-surface')
  const sunken = token('--bg-sunken')
  const hover = token('--bg-hover')
  const ink = token('--ink')
  const inkSecondary = token('--ink-secondary')
  const inkMuted = token('--ink-muted')
  const inkFaint = token('--ink-faint')
  const border = token('--border')
  const borderStrong = token('--border-strong')

  const palette: Record<string, string> = {}
  const put = (key: string, value: string): void => {
    if (value !== '') palette[key] = value
  }

  put('accent-primary', accent)
  put('accent-primary-hover', accentHover)
  put('accent-primary-active', accentHover)
  put('accent-stateless', accent)
  put('accent-primary-disabled', inkFaint)
  put('link-primary', accent)
  put('link-stateless', accent)
  put('link-hover', accentHover)

  put('bg-primary', surface)
  put('bg-primary-light', surface)
  put('bg-primary-hover', hover)
  put('bg-primary-active', accentSoft)
  put('bg-primary-stateless', surface)
  put('bg-secondary', sunken)
  put('bg-stateless', surface)
  put('bg-active', accentSoft)
  put('bg-hover', hover)
  put('bg-grey', sunken)
  put('bg-base-light', sunken)
  put('bg-base-medium', sunken)
  put('bg-tooltip', ink)

  put('txt-primary', ink)
  put('txt-secondary', inkSecondary)
  put('txt-secondary-invert', onAccent)
  put('txt-placeholder', inkFaint)
  put('txt-error', token('--err'))
  put('txt-warning', token('--warn'))

  put('icon-primary', inkSecondary)
  put('icons-secondary', inkMuted)
  put('icons-placeholder', inkFaint)
  put('icons-muted', inkFaint)
  put('icons-invert', onAccent)
  put('icons-primary-hover', ink)
  put('icons-secondary-hover', ink)

  put('borders-primary', border)
  put('borders-primary-hover', borderStrong)
  put('borders-secondary', border)
  put('borders-strong', borderStrong)
  put('borders-invert', onAccent)
  put('borders-button', borderStrong)
  put('borders-item', border)
  put('borders-disabled', border)

  put('btn-primary-text', onAccent)
  put('btn-secondary-text', inkSecondary)
  put('btn-disabled-text', inkFaint)

  put('error', token('--err'))
  put('error-hover', token('--err'))
  put('success', token('--ok'))
  put('warning', token('--warn'))
  put('warning-hover', token('--warn'))
  put('info', accent)

  const font = token('--font-ui')
  return { palette, typography: { fontFamily: font === '' ? 'sans-serif' : font } }
}

/* ---------- 画布转 Blob ---------- */

function normalizeMime(mime: string | undefined): string {
  if (mime === undefined || mime === '') return 'image/png'
  const lower = mime.toLowerCase()
  return lower === 'image/jpg' ? 'image/jpeg' : lower
}

function canvasToBlob(canvas: HTMLCanvasElement, mime: string, quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob === null) reject(new Error('浏览器没能把画布导出成图片'))
        else resolve(blob)
      },
      mime,
      quality,
    )
  })
}

function dataUrlToBlob(dataUrl: string): Blob {
  const comma = dataUrl.indexOf(',')
  if (!dataUrl.startsWith('data:') || comma < 0) {
    throw new Error('编辑器返回的不是合法的 data URL')
  }
  const meta = dataUrl.slice(5, comma)
  const base64 = meta.endsWith(';base64')
  const mime = (base64 ? meta.slice(0, -7) : meta).split(';')[0]
  const body = dataUrl.slice(comma + 1)
  if (!base64) return new Blob([decodeURIComponent(body)], { type: mime || 'image/png' })

  const binary = atob(body)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
  return new Blob([bytes], { type: mime || 'image/png' })
}

interface ExportedImage {
  blob: Blob
  width: number
  height: number
}

/* 尺寸以真实像素为准：canvas.width/height 才是 Blob 里的像素数，
   data.width/height 是编辑器算的裁剪框尺寸，两者不一定相等 */
async function exportImage(data: FieSavedImage): Promise<ExportedImage> {
  const mime = normalizeMime(data.mimeType)
  if (data.imageCanvas) {
    const blob = await canvasToBlob(data.imageCanvas, mime, data.quality)
    return { blob, width: data.imageCanvas.width, height: data.imageCanvas.height }
  }
  if (data.imageBase64 !== undefined && data.imageBase64 !== '') {
    const blob = dataUrlToBlob(data.imageBase64)
    const bitmap = await createImageBitmap(blob)
    const size = { width: bitmap.width, height: bitmap.height }
    bitmap.close()
    return { blob, ...size }
  }
  throw new Error('编辑器没有返回图片数据')
}

/* ---------- 杂项 ---------- */

function reasonOf(err: unknown): string {
  if (err instanceof Error && err.message !== '') return err.message
  if (typeof err === 'string' && err !== '') return err
  return '未知错误'
}

/** 焦点在有内容的输入框上就先失焦，返回 true 表示这次 Esc 已经用掉了 */
function blurEditable(el: Element | null): boolean {
  if (!(el instanceof HTMLElement)) return false
  let hasText: boolean
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) hasText = el.value !== ''
  else if (el.isContentEditable) hasText = (el.textContent ?? '') !== ''
  else return false
  if (!hasText) return false
  el.blur()
  return true
}

/* @scaleflex/ui 的 Modal 打开时会往 body 上挂 Modal-open，并在 document 上监听 Escape。

   > [!danger] 这个状态必须在**捕获阶段**就记下来，不能等到处理时再查
   >
   > 实测过一次：只在 Esc 处理里查 `body.Modal-open` 是查不到的。事件顺序是
   > document 冒泡（FIE 关掉自己的弹窗，顺手摘掉 body 上的类）→ window 冒泡
   > （浮层栈的监听），等我们查的时候类已经没了，于是一次 Esc 把另存为弹窗和整个
   > 修图窗一起关掉，用户的裁剪标注全丢。window 捕获阶段早于 document 冒泡，
   > 在那里取一次快照才拿得到真实状态。 */
function editorModalOpen(): boolean {
  return document.body.classList.contains('Modal-open')
}

/** 探一下 ResizeObserver 会不会回调。

    编辑器**全靠 ResizeObserver 定画布尺寸**：它不回调，`canvasWidth` 就永远是
    undefined，设计层整层 return null，`designLayer` 注册不进 store，一点保存就崩在
    库里的 `getTransformedImgData` 读 `undefined.attrs`——而界面上图还好端端显示着，
    只是永远转圈，看不出发生了什么。

    什么时候会不回调：页面不在渲染。标签页隐藏、被自动化面板托管（`visibilityState`
    恒为 hidden）都算。这与本仓记过的 rAF 冻结、几何量全 0 是同一族问题。

    所以宁可提前说清楚，也不要让用户对着一个转圈的编辑器等。 */
function probeResizeObserver(): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = document.createElement('div')
    probe.style.cssText = 'position:fixed;left:-9999px;top:0;width:80px;height:80px'
    document.body.appendChild(probe)
    let settled = false
    const finish = (ok: boolean): void => {
      if (settled) return
      settled = true
      observer.disconnect()
      probe.remove()
      resolve(ok)
    }
    const observer = new ResizeObserver(() => finish(true))
    observer.observe(probe)
    window.setTimeout(() => finish(false), 1500)
  })
}

/* ---------- 错误边界 ---------- */

interface BoundaryProps {
  onFail: (reason: string) => void
  children: ReactNode
}

class EditorBoundary extends Component<BoundaryProps, { crashed: boolean }> {
  constructor(props: BoundaryProps) {
    super(props)
    this.state = { crashed: false }
  }

  static getDerivedStateFromError(): { crashed: boolean } {
    return { crashed: true }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[RetouchStudio] 编辑器渲染崩溃', error, info.componentStack)
    this.props.onFail(reasonOf(error))
  }

  render(): ReactNode {
    return this.state.crashed ? null : this.props.children
  }
}

/* ---------- 放弃改动确认 ---------- */

function DiscardConfirm({
  onCancel,
  onDiscard,
}: {
  onCancel: () => void
  onDiscard: () => void
}): JSX.Element {
  // 自己入浮层栈，Esc 只关这一层，不会连修图窗一起关
  useEscapeClose(onCancel)
  return (
    <div className="rts-confirm" onClick={onCancel}>
      <div
        className="rts-confirm-card"
        role="dialog"
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="rts-confirm-title">还有没保存的改动</div>
        <p className="rts-confirm-text">关掉编辑器，这次的裁剪、标注、滤镜都会丢掉。</p>
        <div className="rts-confirm-foot">
          <button className="btn btn-outline" onClick={onCancel}>
            继续编辑
          </button>
          <button className="btn btn-danger" onClick={onDiscard}>
            放弃并关闭
          </button>
        </div>
      </div>
    </div>
  )
}

/* ---------- 主体 ---------- */

export function RetouchStudio({
  src,
  filename,
  onSave,
  onClose,
}: {
  /** 图片 URL */
  src: string
  /** 保存时的默认文件名 */
  filename: string
  onSave: (blob: Blob, meta: { width: number; height: number }) => Promise<void> | void
  onClose: () => void
}): JSX.Element {
  // 上层每次渲染都给新函数，用 ref 持有，配置对象才能保持同一个引用
  const handlers = useRef({ onSave, onClose })
  handlers.current = { onSave, onClose }

  const [mod, setMod] = useState<FieModule | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const [confirming, setConfirming] = useState(false)
  const dirty = useRef(false)

  useEffect(() => {
    let alive = true
    void (async () => {
      // 先探环境再加载模块：探不通就不必把两百多 KB 的编辑器拉下来了
      const observable = await probeResizeObserver()
      if (!alive) return
      if (!observable) {
        setFailure(
          'ResizeObserver 在当前页面不回调，编辑器量不到画布尺寸，保存一定会失败。' +
            '页面处于不渲染状态时会这样——标签页在后台、或者由自动化面板托管。' +
            '切到前台的普通窗口再打开。',
        )
        return
      }
      try {
        const loaded = await import('react-filerobot-image-editor')
        if (alive) setMod(loaded)
      } catch (err) {
        console.error('[RetouchStudio] 编辑器模块加载失败', err)
        if (alive) setFailure(reasonOf(err))
      }
    })()
    return () => {
      alive = false
    }
  }, [])

  const requestClose = useCallback(() => {
    if (dirty.current) setConfirming(true)
    else handlers.current.onClose()
  }, [])

  // 按下 Esc 那一瞬间编辑器自己的弹窗是不是开着。见 editorModalOpen 上方的说明
  const modalWasOpen = useRef(false)
  useEffect(() => {
    const snapshot = (e: KeyboardEvent) => {
      if (e.key === 'Escape') modalWasOpen.current = editorModalOpen()
    }
    window.addEventListener('keydown', snapshot, true)
    return () => window.removeEventListener('keydown', snapshot, true)
  }, [])

  const handleEscape = useCallback(() => {
    if (blurEditable(document.activeElement)) return
    if (modalWasOpen.current) {
      // 这一下是给编辑器自己的弹窗的，它已经处理过了
      modalWasOpen.current = false
      return
    }
    requestClose()
  }, [requestClose])

  useEscapeClose(handleEscape)

  const markDirty = useCallback(() => {
    dirty.current = true
  }, [])

  const handleSave = useCallback(async (data: FieSavedImage): Promise<void> => {
    // 这里必须自己吞掉异常：编辑器拿到的是 Promise，reject 会变成未处理的拒绝
    try {
      const { blob, width, height } = await exportImage(data)
      await handlers.current.onSave(blob, { width, height })
      dirty.current = false
      handlers.current.onClose()
    } catch (err) {
      toast.error(`保存失败：${reasonOf(err)}`)
    }
  }, [])

  // 编辑器自带的关闭按钮已经问过「要不要放弃改动」，这里直接关
  const handleEditorClose = useCallback(() => {
    handlers.current.onClose()
  }, [])

  const skin = useMemo(() => readSkin(), [])
  const baseName = useMemo(() => filename.replace(/\.[^./\\]+$/, '') || 'image', [filename])

  const config = useMemo<FilerobotImageEditorConfig | null>(() => {
    if (mod === null) return null
    const { TABS, TOOLS } = mod
    return {
      source: src,
      theme: skin,
      tabsIds: [TABS.ADJUST, TABS.FINETUNE, TABS.FILTERS, TABS.WATERMARK, TABS.ANNOTATE, TABS.RESIZE],
      defaultTabId: TABS.ADJUST,
      defaultToolId: TOOLS.CROP,
      language: 'zh',
      // 关掉后不会去 i18n-fastly.ultrafast.io 拉词条，也不会把缺失 key POST 出去
      useBackendTranslations: false,
      translations: ZH,
      defaultSavedImageName: baseName,
      defaultSavedImageType: 'png',
      closeAfterSave: false,
      observePluginContainerSize: true,
      // 导出画布本来就按原图分辨率建，这里给 1 保证存回去的图不被放大
      savingPixelRatio: 1,
      previewPixelRatio: window.devicePixelRatio || 1,
      onSave: handleSave,
      onClose: handleEditorClose,
      onModify: markDirty,
      Text: { text: '双击改文字', fontFamily: 'PingFang SC', fontSize: 28, fonts: FONTS },
    }
  }, [mod, src, skin, baseName, handleSave, handleEditorClose, markDirty])

  let stage: ReactNode
  if (failure !== null) {
    stage = (
      <div className="rts-hint">
        <div className="rts-hint-title">图片编辑器没能启动</div>
        <p className="rts-hint-text">
          {failure.startsWith('ResizeObserver')
            ? '这不是坏了，是当前页面不满足它的运行前提。'
            : '它依赖 styled-components 与 @scaleflex/ui，多半是依赖没装全或被浏览器拦了。刷新一次还是这样就看控制台里的完整堆栈。'}
        </p>
        <pre className="rts-hint-detail">{failure}</pre>
        <button className="btn btn-outline" onClick={() => handlers.current.onClose()}>
          关闭
        </button>
      </div>
    )
  } else if (config === null || mod === null) {
    stage = (
      <div className="rts-hint">
        <div className="rts-spinner" />
        <p className="rts-hint-text">正在加载图片编辑器…</p>
      </div>
    )
  } else {
    const Editor = mod.default
    stage = (
      <EditorBoundary onFail={setFailure}>
        <Editor {...config} />
      </EditorBoundary>
    )
  }

  return (
    <div className="rts-root" role="dialog" aria-modal="true" aria-label="基础修图">
      <header className="rts-bar">
        <span className="rts-title">基础修图</span>
        <span className="rts-file" title={filename}>
          {filename}
        </span>
        <button className="btn btn-ghost-sm" onClick={requestClose}>
          关闭
        </button>
      </header>
      <div className="rts-stage">{stage}</div>
      {confirming && (
        <DiscardConfirm
          onCancel={() => setConfirming(false)}
          onDiscard={() => {
            setConfirming(false)
            handlers.current.onClose()
          }}
        />
      )}
    </div>
  )
}
