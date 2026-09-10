/* 全景预览（模块 17 · FR-481 / AC-154）。类名前缀 ssm-，样式在 studio-small.css。

   这是全仓第一处真用 three.js 的地方。角度控制页当初判定「CSS 3D 就够用」，前提是
   要渲染的只有一个平面——平面绕相机转与相机绕平面转数学上等价，CSS 的 perspective
   给得出同样的投影。等距柱状投影不是这回事：整张图要裹到球的内壁上，每个像素的位置
   由球面参数方程决定，CSS 变换里没有这个能力。需求 §4.5 的备注早写了「M4 的 360
   全景是真的需要球面渲染，到时再引 three.js」，就是这一天。

   WebGL 生命周期按本仓那笔旧账处理（pixi 销毁丢 context、同一 canvas 不能二次建）：
   canvas 由 renderer 自己造、挂进容器、卸载时几何/材质/纹理/renderer 逐个 dispose
   再把 canvas 整个摘掉；换一张图靠 key 强制重建组件，绝不在同一个 canvas 上二次建。

   拿不到 WebGL 上下文时退回平面原图并把原因写在页面上，不留白屏（BR-110）。 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { Camera, Compass, Download, Globe, ImagePlus, RotateCcw, TriangleAlert } from '@/components/NexusIcon'
import * as THREE from 'three'

import { apiImage } from '../../lib/api-image'
import type { ImageAsset } from '../../lib/api-image'
import { AssetPicker } from './AssetPicker'
import { ToolHeader, downloadAsset } from './StudioToolShell'
import { useInitialImageAsset } from './useInitialImageAsset'
// AssetPicker 的样式（scv-picker 那一组）住在 canvas.css，用它就得带上它
import './canvas.css'
// 页壳与两栏骨架（stl-page/stl-blank/stl-body/stl-side…）与增强、角度两页同源
import './studio-tools.css'
import './studio-small.css'

/** 球半径。相机在球心，near/far 把这个数夹在中间就行，绝对值本身不影响观感 */
const RADIUS = 500
const FOV_MIN = 30
const FOV_MAX = 100
const FOV_DEFAULT = 75
/** 俯仰夹到 ±85°，到不了正天顶——那里经度失去意义，画面会绕着极点打转 */
const LAT_LIMIT = 85
/** 等距柱状投影的标准宽高比，±5% 容差内都认 */
const PANO_RATIO = 2
const RATIO_TOLERANCE = 0.05

/** 提示词/备注里出现这些词就当全景处理。资产表不存原始文件名（ingest 只留提示词与
    备注），所以「文件名含 panorama」这条在本仓能落到的位置就是这两处文本 */
const PANO_WORDS = ['panorama', 'panoramic', 'equirect', 'equirectangular', '360', '全景', '环视']

const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n))

interface PanoVerdict {
  /** 判定为全景图 */
  pano: boolean
  ratio: number
  /** 是按 2:1 认出来的 */
  byRatio: boolean
  /** 是按哪个关键词认出来的，没有则 null */
  word: string | null
}

/** 资产上所有可能写着「这是全景图」的文本。tags 与 caption 是 M2 的 AI 打标产物 */
function assetText(asset: ImageAsset): string {
  const note = asset.brief === null ? '' : String((asset.brief as { local_note?: unknown }).local_note ?? '')
  return [asset.prompt, asset.caption ?? '', note, ...asset.tags].join(' ').toLowerCase()
}

function judgePanorama(asset: ImageAsset): PanoVerdict {
  const ratio = asset.height > 0 ? asset.width / asset.height : 0
  const byRatio = Math.abs(ratio - PANO_RATIO) <= PANO_RATIO * RATIO_TOLERANCE
  const text = assetText(asset)
  const word = PANO_WORDS.find((w) => text.includes(w)) ?? null
  return { pano: byRatio || word !== null, ratio, byRatio, word }
}

/* ==================== 球面视图 ==================== */

interface PanoShot {
  blob: Blob
  lon: number
  lat: number
  fov: number
}

interface PanoHandle {
  capture: () => Promise<PanoShot>
  reset: () => void
}

/** 把图读成 HTMLImageElement。crossOrigin 必须在 src 之前设，晚一步浏览器已按无凭证
    模式发出请求，图能显示但画布被判定为污染，直到 toBlob 才炸 */
function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const el = new window.Image()
    el.crossOrigin = 'anonymous'
    el.onload = () => resolve(el)
    el.onerror = () => reject(new Error('图片加载失败：地址取不到，或对方站点没放行跨域读取'))
    el.src = src
  })
}

/** 超过 GPU 的最大纹理边长就先缩一版再上传。8192 宽的全景图在 maxTextureSize=4096
    的机器上直接传是黑球，且不报错——这类静默失败要在传之前挡掉 */
function fitTexture(img: HTMLImageElement, limit: number): TexImageSource {
  const long = Math.max(img.naturalWidth, img.naturalHeight)
  if (long <= limit) return img
  const k = limit / long
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(img.naturalWidth * k))
  canvas.height = Math.max(1, Math.round(img.naturalHeight * k))
  const ctx = canvas.getContext('2d')
  if (ctx === null) throw new Error('浏览器没有给出 2D 画布上下文，无法缩放全景图')
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
  return canvas
}

function PanoStage({
  src,
  fov,
  onFov,
  onError,
  handleRef,
}: {
  src: string
  fov: number
  onFov: (v: number) => void
  onError: (detail: string) => void
  handleRef: { current: PanoHandle | null }
}): JSX.Element {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const hudRef = useRef<HTMLSpanElement | null>(null)
  // 相机与滚轮回调都在 effect 里长期存活，拿最新的一份靠 ref，不靠依赖数组重建整个场景
  const fovRef = useRef(fov)
  fovRef.current = fov
  const onFovRef = useRef(onFov)
  onFovRef.current = onFov
  const onErrorRef = useRef(onError)
  onErrorRef.current = onError
  const applyFovRef = useRef<((v: number) => void) | null>(null)

  useEffect(() => {
    applyFovRef.current?.(fov)
  }, [fov])

  useEffect(() => {
    const host = hostRef.current
    if (host === null) return
    let alive = true
    let raf = 0

    let renderer: THREE.WebGLRenderer
    try {
      // alpha:true 是为了纹理到位之前让舞台自己的底色透出来（否则是一块黑，暗色主题下
      // 尤其像坏了）；preserveDrawingBuffer 是为了「截取当前视角」——不留缓冲区的话
      // 合成完就被清掉，toBlob 拿到的是空白
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true })
    } catch (e) {
      // 拿不到上下文就把原话交出去，页面退回平面原图，不留白屏
      onErrorRef.current(
        `浏览器没有给出 WebGL 上下文，球面预览用不了：${e instanceof Error ? e.message : '未知原因'}`,
      )
      return
    }

    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    const canvas = renderer.domElement
    canvas.className = 'ssm-gl'
    canvas.tabIndex = 0
    host.appendChild(canvas)

    const scene = new THREE.Scene()
    const camera = new THREE.PerspectiveCamera(fovRef.current, 1, 1, RADIUS * 2 + 100)
    const geometry = new THREE.SphereGeometry(RADIUS, 60, 40)
    // 负的 x 缩放把球翻成内表面。**必须缩几何体不能缩 mesh**：r185 实测
    // `mesh.scale.x = -1` 出来是全黑的（三种写法在真浏览器里逐个量过：
    // 不动 → 黑、mesh.scale.x=-1 → 黑、geometry.scale(-1,1,1) → 正常出图），
    // 顶点位置被真的镜像掉，三角形绕序在屏幕空间跟着反过来，内壁才成了正面。
    // material.side=BackSide 也能出图，但那是从背面看同一张贴图，左右是镜像的。
    geometry.scale(-1, 1, 1)
    // 贴图没到位之前不画：白球一闪比空着更像出错
    const material = new THREE.MeshBasicMaterial({ visible: false })
    const mesh = new THREE.Mesh(geometry, material)
    scene.add(mesh)

    let texture: THREE.Texture | null = null
    let lon = 0
    let lat = 0
    const target = new THREE.Vector3()

    const draw = (): void => {
      const phi = THREE.MathUtils.degToRad(90 - lat)
      const theta = THREE.MathUtils.degToRad(lon)
      target.setFromSphericalCoords(RADIUS, phi, theta)
      camera.lookAt(target)
      renderer.render(scene, camera)
      if (hudRef.current !== null) {
        hudRef.current.textContent = `水平 ${Math.round(lon)}° · 俯仰 ${Math.round(lat)}° · 视场角 ${Math.round(camera.fov)}°`
      }
    }

    /** 连续拖动时每帧只画一次，多余的 pointermove 事件合并掉 */
    const schedule = (): void => {
      if (raf !== 0) return
      raf = window.requestAnimationFrame(() => {
        raf = 0
        if (alive) draw()
      })
    }

    const resize = (): void => {
      // 容器量不到尺寸（隐藏页签里几何量恒为 0）时退到一个正常比例，别建 0×0 的画布
      const w = Math.max(1, host.clientWidth || 960)
      const h = Math.max(1, host.clientHeight || 540)
      camera.aspect = w / h
      camera.updateProjectionMatrix()
      renderer.setSize(w, h)
      draw()
    }

    const applyFov = (v: number): void => {
      camera.fov = clamp(v, FOV_MIN, FOV_MAX)
      camera.updateProjectionMatrix()
      schedule()
    }
    applyFovRef.current = applyFov

    /* ---- 交互：拖动转视角，滚轮调视场角 ---- */

    let dragging = false
    let lastX = 0
    let lastY = 0

    const onDown = (e: PointerEvent): void => {
      dragging = true
      lastX = e.clientX
      lastY = e.clientY
      try {
        // 指针在处理器跑起来之前就抬了（或事件是脚本合成的）时这里会抛 NotFoundError。
        // 捕获不到只是少了「拖出画布仍跟手」这一条，拖动本身照常，不该往控制台喷错
        canvas.setPointerCapture(e.pointerId)
      } catch {
        /* 没拿到指针捕获，按普通 move 事件走 */
      }
      canvas.focus()
    }
    const onMove = (e: PointerEvent): void => {
      if (!dragging) return
      // 视场角越小画面放得越大，同样的位移该转得越少，否则窄视角下拖一下就飞出去
      const k = (camera.fov / FOV_DEFAULT) * 0.12
      // 「抓住画面拖」的手感：画面跟着光标走。这里的正负号跟 three 官方全景例子相反，
      // 因为那份用的是 (cosθ, sinθ) 而 setFromSphericalCoords 是 (sinθ, cosθ)，
      // 两者旋向正好相反——真浏览器里量过：写成 lon-=dx 时右拖画面反而往左跑
      lon = (lon + (e.clientX - lastX) * k) % 360
      lat = clamp(lat + (e.clientY - lastY) * k, -LAT_LIMIT, LAT_LIMIT)
      lastX = e.clientX
      lastY = e.clientY
      schedule()
    }
    const onUp = (e: PointerEvent): void => {
      dragging = false
      if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId)
    }
    const onWheel = (e: WheelEvent): void => {
      // 不 preventDefault 的话滚轮会连页面一起滚走；被动监听器里 preventDefault 无效，
      // 所以这个监听器必须显式 passive:false
      e.preventDefault()
      const next = clamp(camera.fov + e.deltaY * 0.05, FOV_MIN, FOV_MAX)
      // 先落到相机上再通知 React：只等 state 回来的话，同一帧里连滚的十几个事件读到的
      // 都是同一个旧 fov，最后一个覆盖前面所有——实测快滚一下只走一格（55→35 而不是到底 30）
      applyFov(next)
      onFovRef.current(next)
    }
    const onKey = (e: KeyboardEvent): void => {
      const step = e.shiftKey ? 15 : 5
      // 方向键是「转头」不是「拖画面」：按右键要看向右边，画面因此往左移，
      // 与向左拖等效，所以符号与拖动那支相反
      if (e.key === 'ArrowLeft') lon += step
      else if (e.key === 'ArrowRight') lon -= step
      else if (e.key === 'ArrowUp') lat = clamp(lat + step, -LAT_LIMIT, LAT_LIMIT)
      else if (e.key === 'ArrowDown') lat = clamp(lat - step, -LAT_LIMIT, LAT_LIMIT)
      else return
      e.preventDefault()
      schedule()
    }

    canvas.addEventListener('pointerdown', onDown)
    canvas.addEventListener('pointermove', onMove)
    canvas.addEventListener('pointerup', onUp)
    canvas.addEventListener('pointercancel', onUp)
    canvas.addEventListener('wheel', onWheel, { passive: false })
    canvas.addEventListener('keydown', onKey)

    const onLost = (e: Event): void => {
      e.preventDefault()
      onErrorRef.current('浏览器回收了这个页面的 WebGL 上下文（通常是显存吃紧或后台太久）。重新选一次图可以重建。')
    }
    canvas.addEventListener('webglcontextlost', onLost)

    const observer = new ResizeObserver(() => resize())
    observer.observe(host)
    window.addEventListener('resize', resize)

    handleRef.current = {
      capture: async () => {
        // 先补一帧再取像素：没有 preserveDrawingBuffer 时缓冲区已被合成清掉，
        // 这里两条保险都上，拿到的一定是当前视角
        draw()
        const blob = await new Promise<Blob>((resolve, reject) => {
          canvas.toBlob((b) => {
            if (b === null) reject(new Error('浏览器没能把画布编码成 PNG'))
            else resolve(b)
          }, 'image/png')
        })
        return { blob, lon, lat, fov: camera.fov }
      },
      reset: () => {
        lon = 0
        lat = 0
        onFovRef.current(FOV_DEFAULT)
        schedule()
      },
    }

    void (async () => {
      try {
        const img = await loadImage(src)
        if (!alive) return
        const source = fitTexture(img, renderer.capabilities.maxTextureSize)
        texture = new THREE.Texture(source)
        texture.colorSpace = THREE.SRGBColorSpace
        texture.needsUpdate = true
        material.map = texture
        material.visible = true
        material.needsUpdate = true
        resize()
      } catch (e) {
        if (alive) onErrorRef.current(e instanceof Error ? e.message : '全景图载入失败')
      }
    })()

    resize()

    return () => {
      alive = false
      if (raf !== 0) window.cancelAnimationFrame(raf)
      observer.disconnect()
      window.removeEventListener('resize', resize)
      canvas.removeEventListener('pointerdown', onDown)
      canvas.removeEventListener('pointermove', onMove)
      canvas.removeEventListener('pointerup', onUp)
      canvas.removeEventListener('pointercancel', onUp)
      canvas.removeEventListener('wheel', onWheel)
      canvas.removeEventListener('keydown', onKey)
      canvas.removeEventListener('webglcontextlost', onLost)
      handleRef.current = null
      applyFovRef.current = null
      // 显存不归 GC 管，逐个还回去；顺序是先几何/材质/纹理再 renderer，
      // forceContextLoss 放最后，通知驱动这块上下文可以回收了
      geometry.dispose()
      material.dispose()
      texture?.dispose()
      renderer.dispose()
      renderer.forceContextLoss()
      canvas.remove()
    }
    // src 变了才重建整个场景：fov 走 applyFovRef，回调走 ref，都不该拆场景
  }, [src, handleRef])

  return (
    <div className="ssm-stage">
      <div className="ssm-gl-host" ref={hostRef} />
      <span className="ssm-hud" ref={hudRef}>
        水平 0° · 俯仰 0° · 视场角 {FOV_DEFAULT}°
      </span>
    </div>
  )
}

/* ==================== 页面 ==================== */

export default function PanoramaPage(): JSX.Element {
  const [asset, setAsset] = useState<ImageAsset | null>(null)
  const [picking, setPicking] = useState(false)
  const [forced, setForced] = useState(false)
  const [fov, setFov] = useState(FOV_DEFAULT)
  const [glError, setGlError] = useState<string | null>(null)
  const [shots, setShots] = useState<ImageAsset[]>([])
  const [saving, setSaving] = useState(false)
  const handleRef = useRef<PanoHandle | null>(null)
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  const verdict = useMemo(() => (asset === null ? null : judgePanorama(asset)), [asset])

  const pick = useCallback((next: ImageAsset) => {
    setAsset(next)
    // 换图等于换一件事：判定、视角、截图结果全部作废，别把上一张的状态带过来
    setForced(false)
    setGlError(null)
    setFov(FOV_DEFAULT)
    setShots([])
  }, [])
  useInitialImageAsset(pick)

  const onError = useCallback((detail: string) => setGlError(detail), [])

  const shoot = async (): Promise<void> => {
    const handle = handleRef.current
    if (handle === null || asset === null || saving) return
    setSaving(true)
    try {
      const view = await handle.capture()
      const form = new FormData()
      form.set('image', view.blob, 'pano_shot.png')
      form.set('op', 'pano_shot')
      form.set('parent_id', String(asset.id))
      form.set(
        'note',
        `全景截图：水平 ${Math.round(view.lon)}°、俯仰 ${Math.round(view.lat)}°、视场角 ${Math.round(view.fov)}°`,
      )
      const row = await apiImage.saveLocal(form)
      if (!alive.current) return
      setShots((prev) => [row, ...prev])
      toast.success(`已存进资产库（asset ${row.id}）`)
    } catch (e) {
      if (alive.current) toast.error(e instanceof Error ? e.message : '截图失败')
    } finally {
      if (alive.current) setSaving(false)
    }
  }

  const spherical = asset !== null && verdict !== null && (verdict.pano || forced) && glError === null

  return (
    <main className="page stl-page">
      <ToolHeader
        icon={<Globe />}
        title="全景预览"
        sub="把等距柱状投影的全景图贴到球的内壁上，站在球心里看。拖动转视角、滚轮调视场角，看到哪儿都能截一张存进资产库。"
        hasImage={asset !== null}
        onPickImage={() => setPicking(true)}
      />

      {asset === null || verdict === null ? (
        <div className="stl-blank">
          <span className="stl-blank-icon">
            <Globe />
          </span>
          <span className="stl-blank-title">先选一张全景图</span>
          <p className="stl-blank-hint">
            等距柱状投影（equirectangular）的全景图宽高比是 2:1。选中后自动识别，是全景就直接进球面模式。
          </p>
          <button className="btn btn-primary btn-lg" onClick={() => setPicking(true)}>
            <ImagePlus />
            选一张图
          </button>
        </div>
      ) : (
        <div className="stl-body">
          <section className="stl-main">
            {!verdict.pano && !forced ? (
              <div className="ssm-warn stl-wide">
                <span className="ssm-warn-icon">
                  <TriangleAlert />
                </span>
                <div className="ssm-warn-body">
                  <b>这张图不像全景图（等距柱状投影通常是 2:1）</b>
                  <p>
                    它是 {asset.width}×{asset.height}，宽高比 {verdict.ratio.toFixed(2)}:1，也没在提示词或备注里
                    见到 panorama / 全景 / equirect / 360 这类词。
                  </p>
                  <p>
                    仍可强制预览，但会变形：贴到球内壁后竖直方向被拉伸、地平线弯成弧、左右两边接不上缝，
                    截出来的图也带着这些形变。
                  </p>
                  <div className="stl-acts">
                    <button className="btn btn-outline" onClick={() => setForced(true)}>
                      仍要预览
                    </button>
                    <button className="btn btn-primary" onClick={() => setPicking(true)}>
                      <ImagePlus />
                      换一张
                    </button>
                  </div>
                </div>
              </div>
            ) : null}

            {glError !== null ? (
              <div className="ssm-warn ssm-warn-bad stl-wide">
                <span className="ssm-warn-icon">
                  <TriangleAlert />
                </span>
                <div className="ssm-warn-body">
                  <b>球面预览用不了，下面是这张图的平面原图</b>
                  <p>{glError}</p>
                  <p>
                    球面渲染要 WebGL，没有上下文就没有替代做法——CSS 3D 只能转平面，给不出球面投影。
                    可以试试换个浏览器，或关掉其它占显存的页面后重新选一次图。
                  </p>
                </div>
              </div>
            ) : null}

            {spherical ? (
              <div className="stl-wide">
                {/* key 换图即重建：本仓有过在同一个 canvas 上二次建渲染器丢 context 的账 */}
                <PanoStage
                  key={asset.id}
                  src={asset.full_url}
                  fov={fov}
                  onFov={setFov}
                  onError={onError}
                  handleRef={handleRef}
                />
                <p className="stl-hint ssm-tip">
                  按住拖动转视角，滚轮调视场角（{FOV_MIN}~{FOV_MAX}°）；点一下画面后方向键也能转，按住 Shift 转得更快。
                </p>
              </div>
            ) : null}

            {/* 进不了球面模式时照样把图摆出来：用户至少要看得见自己选的是哪一张 */}
            {!spherical ? (
              <div className="ssm-flat stl-wide">
                <img src={asset.url} alt="" />
                <span className="ssm-flat-tag">平面原图</span>
              </div>
            ) : null}
          </section>

          <aside className="stl-side">
            <div className="stl-block">
              <span className="stl-label">这张图</span>
              <p className="ssm-nums">
                asset {asset.id}
                <br />
                {asset.width}×{asset.height}（{verdict.ratio.toFixed(2)}:1）
              </p>
              <p className="stl-hint">
                {verdict.byRatio
                  ? '宽高比落在 2:1 的 ±5% 内，判定为全景图。'
                  : verdict.word !== null
                    ? `提示词或备注里出现「${verdict.word}」，判定为全景图。`
                    : forced
                      ? '不符合全景图特征，当前是强制预览，画面带形变。'
                      : '不符合全景图特征。'}
              </p>
            </div>

            {spherical ? (
              <>
                <div className="stl-block">
                  <span className="stl-label">视场角</span>
                  <input
                    className="ssm-range"
                    type="range"
                    min={FOV_MIN}
                    max={FOV_MAX}
                    step={1}
                    value={Math.round(fov)}
                    onChange={(e) => setFov(Number(e.target.value))}
                  />
                  <p className="ssm-nums">{Math.round(fov)}°</p>
                  <p className="stl-hint">数值越小看得越远越窄（长焦），越大视野越宽、边缘形变越明显（广角）。</p>
                  <button className="btn btn-outline btn-sm" onClick={() => handleRef.current?.reset()}>
                    <RotateCcw />
                    回到初始视角
                  </button>
                </div>

                <div className="stl-block">
                  <span className="stl-label">截取当前视角</span>
                  <p className="ssm-cost">
                    取的是浏览器画布上当前这一帧的像素，所见即所得。
                  </p>
                  <button className="btn btn-primary" disabled={saving} onClick={() => void shoot()}>
                    <Camera />
                    {saving ? '入库中…' : '截取当前视角'}
                  </button>
                  <p className="stl-hint">
                    产物按 op=pano_shot 入资产库，血缘指向这张全景图（parent {asset.id}）。
                    尺寸就是上面画面的实际像素，随窗口大小变。
                  </p>
                </div>
              </>
            ) : null}

            {shots.length > 0 ? (
              <div className="stl-block">
                <span className="stl-label">已截 {shots.length} 张</span>
                <div className="ssm-shots">
                  {shots.map((s) => (
                    <figure className="ssm-shot" key={s.id}>
                      <img src={s.thumb_url} alt="" loading="lazy" />
                      <figcaption>
                        <span className="ssm-shot-id">
                          <Compass />
                          {s.id} · {s.width}×{s.height}
                        </span>
                        <button
                          className="btn-ghost-sm"
                          aria-label={`下载 asset ${s.id}`}
                          onClick={() => {
                            void downloadAsset(s).catch((e: unknown) =>
                              toast.error(e instanceof Error ? e.message : '下载失败'),
                            )
                          }}
                        >
                          <Download />
                        </button>
                      </figcaption>
                    </figure>
                  ))}
                </div>
              </div>
            ) : null}
          </aside>
        </div>
      )}

      {picking ? <AssetPicker onClose={() => setPicking(false)} onPick={pick} /> : null}
    </main>
  )
}
