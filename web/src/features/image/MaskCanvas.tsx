/* 蒙版画布（模块 16 FR-431）：编辑类应用的公共输入部件。

   局部重绘 / 消除 / 替换 / 换背景要的是同一样东西——一张蒙版，差别只在蒙版怎么
   来。扩图连画笔都不需要：把原图贴进放大后的透明画布，空出来的那一圈自动就是
   蒙版，所以扩图没有给服务端加任何新能力，走的还是同一条 `/v1/images/edits`。

   > [!warning] 蒙版语义：透明 = 要模型重画
   >
   > OpenAI `images/edits` 读的是 mask 的 **alpha 通道**——alpha 为 0 的像素交给
   > 模型重画，不透明的像素原样保留。所以导出的 PNG 必须带 alpha：底色铺满不透明
   > 黑（= 全部保留），笔刷用 `destination-out` 打洞（= 打掉的才重画），橡皮再用
   > `source-over` 把洞补回不透明。写反了会得到「只改没涂的地方」这种正好相反的
   > 结果，而且上游不报错，只能靠出图后肉眼发现。

   > [!warning] 导出尺寸必须是原图像素，不是显示尺寸
   >
   > 画布只按容器缩放**显示**，笔迹一律以原图坐标记录（落笔时除以显示缩放比），
   > 导出时按 naturalWidth/naturalHeight 开画布。拿显示尺寸导出会让蒙版整体错位，
   > 这是这个组件最容易出错的地方。 */

import type { KonvaEventObject } from 'konva/lib/Node'
import type { Stage as StageNode } from 'konva/lib/Stage'
import { useEffect, useRef, useState } from 'react'
import { Circle, Image as KonvaImage, Layer, Line, Rect, Stage } from 'react-konva'

import './MaskCanvas.css'

export interface MaskResult {
  /** 蒙版 PNG：要改的区域透明、要保留的区域不透明。null=还没涂 */
  mask: Blob | null
  /** 送给上游的底图 PNG。paint 模式下就是原图；outpaint 模式下是「原图贴在放大画布上」的合成图 */
  composite: Blob | null
  width: number
  height: number
}

export interface MaskCanvasProps {
  /** 图片 URL 或 objectURL */
  src: string
  mode: 'paint' | 'outpaint'
  /** 涂完/拖完后回调，外部拿去提交。防抖 300ms，别每一笔都回调 */
  onChange: (result: MaskResult) => void
}

interface Pad {
  top: number
  right: number
  bottom: number
  left: number
}

type Edge = keyof Pad

interface Stroke {
  /** 原图像素坐标，扁平存 [x0,y0,x1,y1,…] */
  points: number[]
  /** 笔宽，同样是原图像素 */
  size: number
  erase: boolean
}

const NO_PAD: Pad = { top: 0, right: 0, bottom: 0, left: 0 }

/** 画布四周留白，给拖拽手柄让位（屏幕像素） */
const FRAME = 26
/** 手柄在屏幕上的粗细（屏幕像素） */
const GRIP = 12
/** 单边最多外扩到原图对应边长的多少倍——挡住手滑拖出一张几万像素的画布 */
const MAX_PAD_RATIO = 2
/** 回调防抖 */
const EMIT_DELAY = 300

const RATIOS: { key: string; label: string; w: number; h: number }[] = [
  { key: '1:1', label: '1:1', w: 1, h: 1 },
  { key: '4:3', label: '4:3', w: 4, h: 3 },
  { key: '3:4', label: '3:4', w: 3, h: 4 },
  { key: '16:9', label: '16:9', w: 16, h: 9 },
  { key: '9:16', label: '9:16', w: 9, h: 16 },
  { key: '3:2', label: '3:2', w: 3, h: 2 },
  { key: '2:3', label: '2:3', w: 2, h: 3 },
]

function clamp(value: number, lo: number, hi: number): number {
  if (value < lo) return lo
  return value > hi ? hi : value
}

/** 只外扩不裁切：短的那一边补到目标比例，原图居中 */
function padForRatio(w: number, h: number, rw: number, rh: number): Pad {
  const target = rw / rh
  if (w / h > target) {
    const extra = Math.max(0, Math.round(w / target) - h)
    const top = Math.floor(extra / 2)
    return { top, bottom: extra - top, left: 0, right: 0 }
  }
  const extra = Math.max(0, Math.round(h * target) - w)
  const left = Math.floor(extra / 2)
  return { top: 0, bottom: 0, left, right: extra - left }
}

function toPng(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    // 画布被污染时 toBlob 是同步抛 SecurityError，在 executor 里抛出即转成 reject
    canvas.toBlob((blob) => {
      if (blob === null) {
        reject(new Error('浏览器没能把画布编码成 PNG'))
        return
      }
      resolve(blob)
    }, 'image/png')
  })
}

function newCanvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  if (ctx === null) throw new Error('浏览器没有给出 2D 画布上下文，无法生成蒙版')
  return [canvas, ctx]
}

/** 笔迹 → 蒙版位图。底色不透明=保留，笔刷打洞=重画（见文件头的语义说明） */
function rasterizeStrokes(strokes: Stroke[], w: number, h: number): HTMLCanvasElement {
  const [canvas, ctx] = newCanvas(w, h)
  ctx.fillStyle = '#000000'
  ctx.fillRect(0, 0, w, h)
  ctx.strokeStyle = '#000000'
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  for (const stroke of strokes) {
    // 橡皮是把洞补回不透明，所以用 source-over 画回实心黑
    ctx.globalCompositeOperation = stroke.erase ? 'source-over' : 'destination-out'
    ctx.lineWidth = stroke.size
    ctx.beginPath()
    ctx.moveTo(stroke.points[0], stroke.points[1])
    for (let i = 2; i < stroke.points.length; i += 2) {
      ctx.lineTo(stroke.points[i], stroke.points[i + 1])
    }
    ctx.stroke()
  }
  return canvas
}

/** 外扩蒙版：原图那一块不透明保留，扩出来的一圈透明交给模型补 */
function rasterizeOutpaint(w: number, h: number, pad: Pad, natW: number, natH: number): HTMLCanvasElement {
  const [canvas, ctx] = newCanvas(w, h)
  ctx.fillStyle = '#000000'
  ctx.fillRect(pad.left, pad.top, natW, natH)
  return canvas
}

function drawImageOn(img: HTMLImageElement, w: number, h: number, dx: number, dy: number): HTMLCanvasElement {
  const [canvas, ctx] = newCanvas(w, h)
  ctx.drawImage(img, dx, dy, img.naturalWidth, img.naturalHeight)
  return canvas
}

function readError(err: unknown): string {
  if (err instanceof DOMException && err.name === 'SecurityError') {
    return '这张图来自其他站点且没放行跨域读取（CORS），浏览器禁止从画布里取像素。先把它存进资产库，再从资产库打开编辑。'
  }
  return err instanceof Error ? err.message : '蒙版导出失败'
}

function useSourceImage(src: string): { img: HTMLImageElement | null; error: string | null } {
  const [img, setImg] = useState<HTMLImageElement | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setImg(null)
    setError(null)
    const el = new window.Image()
    // crossOrigin 必须在 src 之前设：晚一步浏览器已经按无凭证模式发出请求，
    // 图能显示但画布会被判定为污染，导出时才炸
    el.crossOrigin = 'anonymous'
    let alive = true
    el.onload = () => {
      if (alive) setImg(el)
    }
    el.onerror = () => {
      if (alive) setError('图片加载失败：地址取不到，或对方站点没放行跨域读取')
    }
    el.src = src
    return () => {
      alive = false
      el.onload = null
      el.onerror = null
    }
  }, [src])

  return { img, error }
}

function readColors(): { accent: string; grid: string; ink: string } {
  const cs = getComputedStyle(document.documentElement)
  const pick = (name: string, fallback: string): string => cs.getPropertyValue(name).trim() || fallback
  return {
    accent: pick('--accent', '#4F46E5'),
    grid: pick('--border-strong', '#CFC9BC'),
    ink: pick('--ink-muted', '#8A8378'),
  }
}

/** canvas 不解析 CSS 变量，令牌只能当场读成具体色值；换主题会改 data-theme，要重读 */
function useThemeColors(): { accent: string; grid: string; ink: string } {
  const [colors, setColors] = useState(readColors)
  useEffect(() => {
    const observer = new MutationObserver(() => setColors(readColors()))
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    return () => observer.disconnect()
  }, [])
  return colors
}

export function MaskCanvas({ src, mode, onChange }: MaskCanvasProps) {
  const { img, error: loadError } = useSourceImage(src)
  const colors = useThemeColors()

  const [strokes, setStrokes] = useState<Stroke[]>([])
  const [pad, setPad] = useState<Pad>(NO_PAD)
  const [brush, setBrush] = useState(44)
  const [erasing, setErasing] = useState(false)
  const [cursor, setCursor] = useState<{ x: number; y: number } | null>(null)
  const [ratioKey, setRatioKey] = useState<string | null>(null)
  const [exportError, setExportError] = useState<string | null>(null)

  // 面板隐藏时整棵 DOM 的几何量都是 0，量到 0 就保留上一次的尺寸，别把画布压没
  const [box, setBox] = useState<HTMLDivElement | null>(null)
  const [view, setView] = useState({ w: 640, h: 420 })
  useEffect(() => {
    if (box === null) return
    const observer = new ResizeObserver(() => {
      if (box.clientWidth > 0 && box.clientHeight > 0) {
        setView({ w: box.clientWidth, h: box.clientHeight })
      }
    })
    observer.observe(box)
    return () => observer.disconnect()
  }, [box])

  // 换图或换模式一律从头来，别把上一张的笔迹带过来
  useEffect(() => {
    setStrokes([])
    setPad(NO_PAD)
    setRatioKey(null)
    setExportError(null)
  }, [src, mode])

  const natW = img?.naturalWidth ?? 0
  const natH = img?.naturalHeight ?? 0
  const outW = mode === 'outpaint' ? natW + pad.left + pad.right : natW
  const outH = mode === 'outpaint' ? natH + pad.top + pad.bottom : natH

  // Stage 恒等于容器尺寸，画面靠 Layer 的 scale/offset 摆进去：
  // 让 DOM 尺寸固定，拖边框时不会因为画布变大触发容器回流（.imgc-view 是 overflow:auto，
  // 一旦长出滚动条，容器尺寸又反过来改缩放比，会来回抖）
  const fit = outW > 0 && outH > 0
    ? Math.min((view.w - FRAME * 2) / outW, (view.h - FRAME * 2) / outH, 1)
    : 1
  const scale = clamp(fit, 0.02, 1)
  const offX = Math.round((view.w - outW * scale) / 2)
  const offY = Math.round((view.h - outH * scale) / 2)

  function toCanvasPoint(stage: StageNode | null): { x: number; y: number } | null {
    if (stage === null) return null
    const p = stage.getPointerPosition()
    if (p === null) return null
    return { x: (p.x - offX) / scale, y: (p.y - offY) / scale }
  }

  /* ---- 涂画 ---- */

  const painting = useRef(false)

  function onStagePointerDown(e: KonvaEventObject<PointerEvent>): void {
    if (mode !== 'paint') return
    const point = toCanvasPoint(e.target.getStage())
    if (point === null) return
    painting.current = true
    // 头尾各一个点、且错开一丁点，圆头笔帽才画得出「点一下」的那个圆点
    setStrokes((prev) => [
      ...prev,
      { points: [point.x, point.y, point.x + 0.01, point.y], size: brush / scale, erase: erasing },
    ])
  }

  function onStagePointerMove(e: KonvaEventObject<PointerEvent>): void {
    if (mode !== 'paint') return
    const point = toCanvasPoint(e.target.getStage())
    if (point === null) return
    setCursor(point)
    if (!painting.current) return
    setStrokes((prev) => {
      const last = prev[prev.length - 1]
      if (last === undefined) return prev
      const dx = point.x - last.points[last.points.length - 2]
      const dy = point.y - last.points[last.points.length - 1]
      // 屏幕上挪不到 1.2px 的抖动不记点，长笔迹的点数才不会失控
      if (Math.hypot(dx, dy) * scale < 1.2) return prev
      const next = prev.slice(0, -1)
      next.push({ ...last, points: [...last.points, point.x, point.y] })
      return next
    })
  }

  function endStroke(): void {
    painting.current = false
  }

  /* ---- 外扩框拖拽 ---- */

  const drag = useRef<{ edge: Edge; x: number; y: number; pad: Pad; scale: number } | null>(null)
  const limits = useRef({ w: 0, h: 0 })
  limits.current = { w: natW, h: natH }

  useEffect(() => {
    function move(ev: PointerEvent): void {
      const d = drag.current
      if (d === null) return
      // 缩放比取按下那一刻的：画布变大后视图会重新贴合，取实时值会让同样的手势位移越拖越快
      const dx = (ev.clientX - d.x) / d.scale
      const dy = (ev.clientY - d.y) / d.scale
      const maxW = limits.current.w * MAX_PAD_RATIO
      const maxH = limits.current.h * MAX_PAD_RATIO
      const next = { ...d.pad }
      if (d.edge === 'left') next.left = Math.round(clamp(d.pad.left - dx, 0, maxW))
      if (d.edge === 'right') next.right = Math.round(clamp(d.pad.right + dx, 0, maxW))
      if (d.edge === 'top') next.top = Math.round(clamp(d.pad.top - dy, 0, maxH))
      if (d.edge === 'bottom') next.bottom = Math.round(clamp(d.pad.bottom + dy, 0, maxH))
      setPad(next)
    }
    function up(): void {
      drag.current = null
      // 松手发生在窗口外时 Stage 收不到 pointerup，靠这里收笔
      painting.current = false
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
    return () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', up)
    }
  }, [])

  function startEdge(edge: Edge, e: KonvaEventObject<PointerEvent>): void {
    e.cancelBubble = true
    e.evt.preventDefault()
    drag.current = { edge, x: e.evt.clientX, y: e.evt.clientY, pad, scale }
    setRatioKey(null)
  }

  function setEdgeCursor(e: KonvaEventObject<PointerEvent>, shape: string): void {
    const container = e.target.getStage()?.container()
    if (container !== undefined) container.style.cursor = shape
  }

  /* ---- 导出（防抖 300ms） ---- */

  const emit = useRef(onChange)
  emit.current = onChange

  useEffect(() => {
    if (img === null) return
    let alive = true
    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          const width = mode === 'outpaint' ? natW + pad.left + pad.right : natW
          const height = mode === 'outpaint' ? natH + pad.top + pad.bottom : natH
          const dx = mode === 'outpaint' ? pad.left : 0
          const dy = mode === 'outpaint' ? pad.top : 0
          const composite = await toPng(drawImageOn(img, width, height, dx, dy))
          const painted = mode === 'paint' ? strokes.length > 0 : width !== natW || height !== natH
          const mask = painted
            ? await toPng(
                mode === 'paint'
                  ? rasterizeStrokes(strokes, width, height)
                  : rasterizeOutpaint(width, height, pad, natW, natH),
              )
            : null
          if (!alive) return
          setExportError(null)
          emit.current({ mask, composite, width, height })
        } catch (err) {
          if (!alive) return
          setExportError(readError(err))
          // 导不出来就把上一版结果作废，宁可让提交按钮拦下，也不让旧蒙版蒙混过关
          emit.current({ mask: null, composite: null, width: 0, height: 0 })
        }
      })()
    }, EMIT_DELAY)
    return () => {
      alive = false
      window.clearTimeout(timer)
    }
  }, [img, mode, strokes, pad, natW, natH])

  /* ---- 渲染 ---- */

  if (loadError !== null) {
    return (
      <div className="mk-root">
        <div className="mk-msg mk-msg-bad">{loadError}</div>
      </div>
    )
  }
  if (img === null) {
    return (
      <div className="mk-root">
        <div className="mk-msg">图片加载中…</div>
      </div>
    )
  }

  const grip = GRIP / scale
  const hairline = 1 / scale
  const barX = Math.min(outW * scale * 0.5, 120) / scale
  const barY = Math.min(outH * scale * 0.5, 120) / scale
  const expanded = mode === 'outpaint' && (outW !== natW || outH !== natH)

  return (
    <div className="mk-root">
      <div className="mk-bar">
        {mode === 'paint' ? (
          <>
            <div className="seg">
              <button className={erasing ? '' : 'active'} onClick={() => setErasing(false)}>
                笔刷
              </button>
              <button className={erasing ? 'active' : ''} onClick={() => setErasing(true)}>
                橡皮
              </button>
            </div>
            <label className="mk-size">
              笔刷
              <input
                className="mk-slider"
                type="range"
                min={6}
                max={200}
                step={2}
                value={brush}
                onChange={(e) => setBrush(Number(e.target.value))}
              />
              <b>{brush}</b>
            </label>
            <button
              className="btn btn-outline btn-sm"
              disabled={strokes.length === 0}
              onClick={() => setStrokes((prev) => prev.slice(0, -1))}
            >
              撤销
            </button>
            <button
              className="btn btn-outline btn-sm"
              disabled={strokes.length === 0}
              onClick={() => setStrokes([])}
            >
              清空
            </button>
          </>
        ) : (
          <>
            <span className="mk-label">一键外扩到</span>
            <div className="mk-ratios">
              {RATIOS.map((r) => (
                <button
                  key={r.key}
                  className={ratioKey === r.key ? 'btn btn-soft btn-sm' : 'btn btn-outline btn-sm'}
                  onClick={() => {
                    setPad(padForRatio(natW, natH, r.w, r.h))
                    setRatioKey(r.key)
                  }}
                >
                  {r.label}
                </button>
              ))}
            </div>
            <button
              className="btn btn-outline btn-sm"
              disabled={!expanded}
              onClick={() => {
                setPad(NO_PAD)
                setRatioKey(null)
              }}
            >
              还原
            </button>
          </>
        )}
      </div>

      <div
        className="mk-area"
        ref={setBox}
        onPointerLeave={() => {
          endStroke()
          setCursor(null)
        }}
      >
        {mode === 'outpaint' ? (
          <div
            className="mk-checker"
            style={{
              left: offX,
              top: offY,
              width: Math.max(0, outW * scale),
              height: Math.max(0, outH * scale),
            }}
          />
        ) : null}
        <Stage
          className="mk-stage"
          width={view.w}
          height={view.h}
          onPointerDown={onStagePointerDown}
          onPointerMove={onStagePointerMove}
          onPointerUp={endStroke}
        >
          <Layer x={offX} y={offY} scaleX={scale} scaleY={scale} listening={false}>
            <KonvaImage image={img} x={mode === 'outpaint' ? pad.left : 0} y={mode === 'outpaint' ? pad.top : 0} width={natW} height={natH} />
          </Layer>

          {/* 笔迹单独一层：橡皮用 destination-out，同层才不会把底图一起擦掉 */}
          <Layer x={offX} y={offY} scaleX={scale} scaleY={scale} listening={false}>
            {strokes.map((stroke, i) => (
              <Line
                key={i}
                points={stroke.points}
                stroke={colors.accent}
                strokeWidth={stroke.size}
                lineCap="round"
                lineJoin="round"
                opacity={stroke.erase ? 1 : 0.45}
                globalCompositeOperation={stroke.erase ? 'destination-out' : 'source-over'}
              />
            ))}
          </Layer>

          <Layer x={offX} y={offY} scaleX={scale} scaleY={scale} listening={mode === 'outpaint'}>
            {mode === 'outpaint' ? (
              <>
                <Rect
                  x={0}
                  y={0}
                  width={outW}
                  height={outH}
                  stroke={colors.accent}
                  strokeWidth={hairline * 1.5}
                  dash={[6 / scale, 4 / scale]}
                  listening={false}
                />
                <Rect
                  x={pad.left}
                  y={pad.top}
                  width={natW}
                  height={natH}
                  stroke={colors.grid}
                  strokeWidth={hairline}
                  listening={false}
                />
                <Rect
                  x={outW / 2 - barX / 2}
                  y={-grip / 2}
                  width={barX}
                  height={grip}
                  cornerRadius={grip / 2}
                  fill={colors.accent}
                  onPointerDown={(e) => startEdge('top', e)}
                  onPointerEnter={(e) => setEdgeCursor(e, 'ns-resize')}
                  onPointerLeave={(e) => setEdgeCursor(e, 'default')}
                />
                <Rect
                  x={outW / 2 - barX / 2}
                  y={outH - grip / 2}
                  width={barX}
                  height={grip}
                  cornerRadius={grip / 2}
                  fill={colors.accent}
                  onPointerDown={(e) => startEdge('bottom', e)}
                  onPointerEnter={(e) => setEdgeCursor(e, 'ns-resize')}
                  onPointerLeave={(e) => setEdgeCursor(e, 'default')}
                />
                <Rect
                  x={-grip / 2}
                  y={outH / 2 - barY / 2}
                  width={grip}
                  height={barY}
                  cornerRadius={grip / 2}
                  fill={colors.accent}
                  onPointerDown={(e) => startEdge('left', e)}
                  onPointerEnter={(e) => setEdgeCursor(e, 'ew-resize')}
                  onPointerLeave={(e) => setEdgeCursor(e, 'default')}
                />
                <Rect
                  x={outW - grip / 2}
                  y={outH / 2 - barY / 2}
                  width={grip}
                  height={barY}
                  cornerRadius={grip / 2}
                  fill={colors.accent}
                  onPointerDown={(e) => startEdge('right', e)}
                  onPointerEnter={(e) => setEdgeCursor(e, 'ew-resize')}
                  onPointerLeave={(e) => setEdgeCursor(e, 'default')}
                />
              </>
            ) : cursor !== null ? (
              <Circle
                x={cursor.x}
                y={cursor.y}
                radius={brush / scale / 2}
                stroke={erasing ? colors.ink : colors.accent}
                strokeWidth={hairline * 1.5}
                dash={[4 / scale, 3 / scale]}
                listening={false}
              />
            ) : null}
          </Layer>
        </Stage>
      </div>

      {exportError !== null ? <div className="mk-err">{exportError}</div> : null}

      <div className="mk-foot">
        {mode === 'paint' ? (
          <>
            <span>
              原图 {natW}×{natH}
            </span>
            <span>已涂 {strokes.length} 笔</span>
            <span className="mk-note">涂过的地方交给模型重画，蒙版按原图像素导出</span>
          </>
        ) : (
          <>
            <span>
              原图 {natW}×{natH} → 新画布 {outW}×{outH}
            </span>
            <span>
              上 {pad.top} · 右 {pad.right} · 下 {pad.bottom} · 左 {pad.left}
            </span>
            <span className="mk-note">扩出来的一圈是透明区，模型往外补的就是它</span>
          </>
        )}
      </div>
    </div>
  )
}
