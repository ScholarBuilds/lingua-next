/* 播放器偏好（需求 09 v9 FR-115）：设备级设置，本地持久化不进服务端账户配置。

   倍速/音量/静音/字幕样式/自动连播——都是"这台设备怎么放"的问题，
   与阅读偏好（跨设备同步的 prefStore）分开存。 */

import { create } from 'zustand'
import { persist } from 'zustand/middleware'

/** 倍速档位（FR-108）：0.8-1.25 细分，语言学习的常用微调带 */
export const PLAYBACK_RATES = [0.5, 0.75, 0.8, 0.9, 1, 1.1, 1.2, 1.25, 1.5, 1.75, 2] as const

export type SubScale = 's' | 'm' | 'l'

/** 内嵌字幕语言（FR-116）：auto 跟随右栏模式，其余为玩家显式覆盖 */
export type CaptionMode = 'auto' | 'both' | 'en' | 'zh' | 'off'

/** AI 陪读说话时对视频的处理（FR-120）：教学场景业内默认是暂停（真人老师讲解
    也会按暂停），ducking（压低音量）是语音助手对背景媒体的通行做法，都给。 */
export type AiDuckPolicy = 'pause' | 'duck' | 'off'

/** 一句念完后字幕的 lead-out 上限 ms（FR-121）。
    1.5s 是 BBC Subtitle Guidelines §5.2 的封顶值（不得在语音结束后挂留超过 1.5 秒），
    3s 超出规范但对跟读抄写有用，留给用户自己选；0 = 严格按出点消失。
    短于 1 秒的句间空隙无论选哪档都会桥接，那是消抖动的规范要求，不是偏好。 */
export const SUB_HOLD_OPTIONS: Array<[number, string]> = [
  [0, '不停留'],
  [1500, '标准'],
  [3000, '长驻'],
]

interface PlayerPrefs {
  rate: number
  volume: number // 0-1
  muted: boolean
  /** 字幕背景不透明度 0-100（FR-109）：调高可遮视频自带硬字幕 */
  subBgAlpha: number
  subScale: SubScale
  /** 字幕距底部偏移（0-40，占播放器高度百分比） */
  subOffset: number
  /** 播完自动连播（FR-113）：默认关，学习场景不打断为先 */
  autoNext: boolean
  captionMode: CaptionMode
  aiDuck: AiDuckPolicy
  subHold: number
  set: (patch: Partial<Omit<PlayerPrefs, 'set'>>) => void
}

export const usePlayerPrefs = create<PlayerPrefs>()(
  persist(
    (set) => ({
      rate: 1,
      volume: 1,
      muted: false,
      subBgAlpha: 55,
      subScale: 'm',
      subOffset: 3,
      autoNext: false,
      captionMode: 'auto',
      aiDuck: 'pause',
      subHold: 1500,
      set: (patch) => set(patch),
    }),
    {
      name: 'lingua-player-prefs',
      version: 1,
      // 早期版本存过 2000/5000，档位收敛到规范口径后把旧值夹到最近的档
      migrate: (persisted, from) => {
        const st = persisted as Partial<PlayerPrefs>
        if (from < 1 && typeof st.subHold === 'number') {
          const allowed = SUB_HOLD_OPTIONS.map(([ms]) => ms)
          if (!allowed.includes(st.subHold)) {
            st.subHold = st.subHold <= 0 ? 0 : st.subHold >= 3000 ? 3000 : 1500
          }
        }
        return st
      },
    },
  ),
)

export const SUB_SCALE_PX: Record<SubScale, number> = { s: 16, m: 19, l: 23 }
