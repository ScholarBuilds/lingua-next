/* Live2D 看板娘（pixi.js v7 + pixi-live2d-display@0.5.0-beta，cubism2 模型）。
   固定悬浮阅读页角落：拖动微调、hover 工具条（换模型/换边/隐藏）、点按播随机动作；
   语音陪读时下行音量驱动嘴型（ParamMouthOpenY），空闲自动播 idle motion。
   cubism2 运行时 live2d.min.js 从 /mascots/core/ 动态注入，模型清单读 /mascots/manifest.json。 */

import { useEffect, useRef, useState } from 'react'
import { useLocation } from 'react-router-dom'

import { Picker } from '@/components/ui/picker'
import { getVoiceLevel, useVoiceCompanionStore } from './useInlineVoiceCompanion'
import {
  loadMascotManifest,
  useMascotStore,
} from './mascotStore'
import type { MascotManifestEntry, MascotOffset } from './mascotStore'
import './mascot.css'

const CANVAS_W = 180
const CANVAS_H = 240
/** 空闲随机动作间隔（毫秒） */
const IDLE_MOTION_MS = 14000

declare global {
  interface Window {
    Live2D?: unknown
  }
}

/* cubism2 / cubism4 核心模型参数接口（运行时鸭子类型） */
interface MouthCoreModel {
  setParamFloat?: (id: string, value: number) => void
  setParameterValueById?: (id: string, value: number) => void
}

let corePromise: Promise<void> | null = null

/** 注入 Live2D cubism2 运行时（pixi-live2d-display 依赖全局 Live2D） */
function ensureLive2DCore(): Promise<void> {
  if (window.Live2D !== undefined) return Promise.resolve()
  corePromise ??= new Promise((resolve, reject) => {
    const s = document.createElement('script')
    s.src = '/mascots/core/live2d.min.js'
    s.onload = () => resolve()
    s.onerror = () => {
      corePromise = null
      s.remove()
      reject(new Error('Live2D 运行时加载失败'))
    }
    document.head.appendChild(s)
  })
  return corePromise
}

export function IconMascot(props: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="18"
      height="18"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={props.className}
    >
      <path d="M5 9.5 4 4l4.5 2.5a8 8 0 0 1 7 0L20 4l-1 5.5" />
      <path d="M5 9.5a8 7.5 0 1 0 14 0" />
      <circle cx="9.2" cy="12.5" r="0.6" fill="currentColor" stroke="none" />
      <circle cx="14.8" cy="12.5" r="0.6" fill="currentColor" stroke="none" />
      <path d="M10.5 16c.9.8 2.1.8 3 0" />
    </svg>
  )
}

/** 总开关外壳：关闭时不渲染任何东西 */
export function MascotWidget() {
  const enabled = useMascotStore((s) => s.enabled)
  const location = useLocation()
  const params = new URLSearchParams(location.search)
  const training = location.pathname === '/vocab' && (
    (params.get('v') === 'practice' && params.has('id')) ||
    ['learn', 'review', 'dictation', 'drill'].includes(params.get('v') ?? '')
  )
  if (!enabled || training) return null
  return <MascotCanvas />
}

interface DragState {
  pointerId: number
  startX: number
  startY: number
  base: MascotOffset
  moved: boolean
}

function clampOffset(offset: MascotOffset): MascotOffset {
  const maxShift = (v: number, span: number) => Math.max(-(span - 60), Math.min(24, v))
  return {
    x: maxShift(offset.x, window.innerWidth),
    y: maxShift(offset.y, window.innerHeight),
  }
}

function MascotCanvas() {
  const corner = useMascotStore((s) => s.corner)
  const offset = useMascotStore((s) => s.offset)
  const modelId = useMascotStore((s) => s.modelId)
  const setCorner = useMascotStore((s) => s.setCorner)
  const setOffset = useMascotStore((s) => s.setOffset)
  const setModelId = useMascotStore((s) => s.setModelId)
  const setEnabled = useMascotStore((s) => s.setEnabled)
  const speaking = useVoiceCompanionStore((s) => s.status === 'speaking')

  const [manifest, setManifest] = useState<MascotManifestEntry[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [modelReady, setModelReady] = useState(false)

  const wrapRef = useRef<HTMLDivElement>(null)
  const holderRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<DragState | null>(null)
  const speakingRef = useRef(false)
  const tapMotionRef = useRef<(() => void) | null>(null)
  speakingRef.current = speaking

  // 模型清单
  useEffect(() => {
    let alive = true
    loadMascotManifest()
      .then((list) => {
        if (!alive) return
        if (list.length === 0) setLoadError('模型清单为空')
        else setManifest(list)
      })
      .catch(() => {
        if (alive) setLoadError('模型清单加载失败')
      })
    return () => {
      alive = false
    }
  }, [])

  const entry =
    manifest === null ? null : (manifest.find((m) => m.id === modelId) ?? manifest[0])

  // pixi 应用 + 模型装载（换模型时整体重建）。
  // canvas 每次动态新建：pixi 销毁会 lose WebGL context，同一 canvas 无法二次建上下文
  // （React key 不够——HMR/StrictMode 重跑 effect 时元素不变）
  useEffect(() => {
    if (entry === null) return
    const holder = holderRef.current
    if (holder === null) return
    const canvas = document.createElement('canvas')
    canvas.className = 'mascot-canvas'
    canvas.width = CANVAS_W
    canvas.height = CANVAS_H
    holder.appendChild(canvas)
    let disposed = false
    let cleanup: (() => void) | null = null
    setModelReady(false)
    setLoadError(null)

    void (async () => {
      try {
        await ensureLive2DCore()
        // 运行时就绪后再拉插件，避免 cubism2 模块初始化时找不到全局 Live2D
        const [pixi, plugin] = await Promise.all([
          import('pixi.js'),
          import('pixi-live2d-display/cubism2'),
        ])
        if (disposed) return
        const { Application, Ticker } = pixi
        const { Live2DModel } = plugin
        Live2DModel.registerTicker(Ticker)

        const app = new Application({
          view: canvas,
          width: CANVAS_W,
          height: CANVAS_H,
          backgroundAlpha: 0,
          antialias: true,
          autoDensity: true,
          resolution: Math.min(window.devicePixelRatio || 1, 2),
        })

        const model = await Live2DModel.from(entry.path, {
          autoHitTest: false,
          autoFocus: false,
        })
        if (disposed) {
          model.destroy()
          app.destroy(false)
          return
        }

        // 等比装进画布：横向撑满、底部对齐；超高（半身像）时露头裁脚
        const fit = Math.min(CANVAS_W / model.width, CANVAS_H / model.height)
        model.scale.set(fit * entry.scale)
        model.x = (CANVAS_W - model.width) / 2
        model.y = Math.min(0, CANVAS_H - model.height) + entry.offsetY
        app.stage.addChild(model)

        /* 嘴型：在 motionManager.update 之后写参数，避免被动作数据覆盖。
           取不到下行音量（分析器异常）时退化为正弦脉冲随机嘴型。 */
        let mouth = 0
        const internal = model.internalModel
        const mm = internal.motionManager
        const originalUpdate = mm.update.bind(mm)
        mm.update = (...args: Parameters<typeof originalUpdate>) => {
          const r = originalUpdate(...args)
          const core = internal.coreModel as unknown as MouthCoreModel
          try {
            if (core.setParamFloat !== undefined) core.setParamFloat('PARAM_MOUTH_OPEN_Y', mouth)
            else core.setParameterValueById?.('ParamMouthOpenY', mouth)
          } catch {
            /* 个别模型无嘴参数，忽略 */
          }
          return r
        }
        const mouthTick = () => {
          let target = 0
          if (speakingRef.current) {
            const level = getVoiceLevel()
            // 音量驱动为主；音量拿不到时用脉冲兜底，保证说话状态嘴在动
            const pulse = 0.18 + 0.3 * Math.abs(Math.sin(performance.now() / 130))
            target = Math.max(level * 1.4, level > 0.02 ? 0 : pulse)
          }
          mouth += (target - mouth) * 0.35
          if (mouth < 0.01) mouth = 0
          // 调试观测口：嘴型值挂 data 属性（变化超过阈值才写，避免每帧改 DOM）
          const shown = canvas.dataset.mouth
          if (shown === undefined || Math.abs(Number(shown) - mouth) > 0.02) {
            canvas.dataset.mouth = mouth.toFixed(2)
          }
        }
        app.ticker.add(mouthTick)

        // 空闲随机动作：idle 组之外的动作组里随机挑一个（说话时不打扰）
        const groups = Object.keys(mm.definitions).filter(
          (g) => g !== 'idle' && (mm.definitions[g]?.length ?? 0) > 0,
        )
        const randomMotion = () => {
          if (groups.length === 0) return
          const g = groups[Math.floor(Math.random() * groups.length)]
          void model.motion(g)
        }
        const idleTimer = window.setInterval(() => {
          if (!speakingRef.current && Math.random() < 0.5) randomMotion()
        }, IDLE_MOTION_MS)
        tapMotionRef.current = randomMotion

        setModelReady(true)
        cleanup = () => {
          window.clearInterval(idleTimer)
          tapMotionRef.current = null
          app.ticker.remove(mouthTick)
          model.destroy()
          app.destroy(false)
        }
      } catch (err) {
        if (!disposed) {
          setLoadError(err instanceof Error ? err.message : '看板娘加载失败')
        }
      }
    })()

    return () => {
      disposed = true
      cleanup?.()
      canvas.remove()
    }
  }, [entry])

  /* ---- 拖动微调（区分点按：位移 < 4px 视为点按 → 播随机动作） ---- */

  const applyTransform = (o: MascotOffset) => {
    const el = wrapRef.current
    if (el !== null) el.style.transform = `translate(${o.x}px, ${o.y}px)`
  }

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).closest('.mascot-tools') !== null) return
    dragRef.current = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      base: offset,
      moved: false,
    }
    e.currentTarget.setPointerCapture(e.pointerId)
  }

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current
    if (drag === null || drag.pointerId !== e.pointerId) return
    const dx = e.clientX - drag.startX
    const dy = e.clientY - drag.startY
    if (!drag.moved && Math.abs(dx) + Math.abs(dy) > 4) drag.moved = true
    if (drag.moved) {
      applyTransform(clampOffset({ x: drag.base.x + dx, y: drag.base.y + dy }))
    }
  }

  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current
    if (drag === null || drag.pointerId !== e.pointerId) return
    dragRef.current = null
    if (drag.moved) {
      setOffset(
        clampOffset({
          x: drag.base.x + (e.clientX - drag.startX),
          y: drag.base.y + (e.clientY - drag.startY),
        }),
      )
    } else {
      tapMotionRef.current?.()
    }
  }

  return (
    <div
      ref={wrapRef}
      className={`mascot-root ${corner}${speaking ? ' speaking' : ''}`}
      style={{ transform: `translate(${offset.x}px, ${offset.y}px)` }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
    >
      <div className="mascot-tools">
        {manifest !== null && manifest.length > 1 && entry !== null && (
          <Picker
            size="sm"
            className="mascot-select"
            value={entry.id}
            title="切换模型"
            onChange={setModelId}
            options={manifest.map((m) => ({ value: m.id, label: m.name }))}
          />
        )}
        <button
          className="mascot-tool-btn"
          title={corner === 'br' ? '移到左下角' : '移到右下角'}
          onClick={() => setCorner(corner === 'br' ? 'bl' : 'br')}
        >
          ⇄
        </button>
        <button className="mascot-tool-btn" title="隐藏看板娘（顶栏可再打开）" onClick={() => setEnabled(false)}>
          ✕
        </button>
      </div>
      {loadError !== null && <div className="mascot-error">{loadError}</div>}
      {loadError === null && !modelReady && <div className="mascot-loading">看板娘加载中…</div>}
      <div ref={holderRef} className="mascot-canvas-holder" />
    </div>
  )
}
