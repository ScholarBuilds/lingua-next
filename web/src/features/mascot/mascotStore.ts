/* 看板娘全局状态：开关与当前模型经 prefStore 服务端化持久化；
   角落 / 拖动偏移属于本机布局细节，仍走 localStorage */

import { create } from 'zustand'

import { usePrefStore } from '../../lib/prefStore'

export type MascotCorner = 'br' | 'bl'

export interface MascotOffset {
  x: number
  y: number
}

const CORNER_KEY = 'ln-mascot-corner'
const OFFSET_KEY = 'ln-mascot-offset'

function initOffset(): MascotOffset {
  try {
    const raw = localStorage.getItem(OFFSET_KEY)
    if (raw !== null) {
      const v = JSON.parse(raw) as { x?: unknown; y?: unknown }
      if (typeof v.x === 'number' && typeof v.y === 'number') return { x: v.x, y: v.y }
    }
  } catch {
    /* 损坏的存档忽略 */
  }
  return { x: 0, y: 0 }
}

interface MascotState {
  /** 看板娘总开关（阅读器顶栏切换），默认开 */
  enabled: boolean
  corner: MascotCorner
  /** 拖动微调偏移（px，相对角落基准位） */
  offset: MascotOffset
  /** 当前模型 id（对应 /mascots/manifest.json），null = 用清单第一个 */
  modelId: string | null
  setEnabled: (on: boolean) => void
  setCorner: (corner: MascotCorner) => void
  setOffset: (offset: MascotOffset) => void
  setModelId: (id: string) => void
}

export const useMascotStore = create<MascotState>((set) => ({
  enabled: usePrefStore.getState().prefs.mascot.enabled,
  corner: localStorage.getItem(CORNER_KEY) === 'bl' ? 'bl' : 'br',
  offset: initOffset(),
  modelId: usePrefStore.getState().prefs.mascot.modelId,
  setEnabled: (on) => {
    usePrefStore.getState().update({ mascot: { enabled: on } })
    set({ enabled: on })
  },
  setCorner: (corner) => {
    localStorage.setItem(CORNER_KEY, corner)
    // 换边后旧偏移大概率把模型推出屏幕，一并归零
    localStorage.setItem(OFFSET_KEY, JSON.stringify({ x: 0, y: 0 }))
    set({ corner, offset: { x: 0, y: 0 } })
  },
  setOffset: (offset) => {
    localStorage.setItem(OFFSET_KEY, JSON.stringify(offset))
    set({ offset })
  },
  setModelId: (id) => {
    usePrefStore.getState().update({ mascot: { modelId: id } })
    set({ modelId: id })
  },
}))

/* ---- 模型清单 ---- */

export interface MascotManifestEntry {
  id: string
  name: string
  path: string
  /** 相对基准缩放的倍率 */
  scale: number
  /** 垂直微调（px，正值下移） */
  offsetY: number
}

let manifestCache: Promise<MascotManifestEntry[]> | null = null

export function loadMascotManifest(): Promise<MascotManifestEntry[]> {
  manifestCache ??= fetch('/mascots/manifest.json')
    .then((r) => {
      if (!r.ok) throw new Error(`manifest ${r.status}`)
      return r.json() as Promise<MascotManifestEntry[]>
    })
    .catch((err: unknown) => {
      manifestCache = null // 失败后允许重试
      throw err
    })
  return manifestCache
}
