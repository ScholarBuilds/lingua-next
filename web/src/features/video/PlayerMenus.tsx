/* 播放器控制组件（需求 09 v9 FR-108~112 / v9.3 FR-124）：倍速菜单 / 音量 / 设置 /
   内嵌字幕 / 快捷键帮助。全部读写 playerPrefs（设备级持久化），与 VideoLearnPage
   的 <video> 通过回调解耦。

   弹层一律悬停即出：进入延迟 120ms 挡住"扫过就弹"，离开延迟 240ms 留出移进弹层的
   余量——hover intent 的通行参数区间。点击仍可开合，键盘聚焦也能打开。 */

import { useCallback, useEffect, useRef, useState } from 'react'

import { useEscapeClose } from '../../components/Overlay'
import { LearningIcon } from '../../components/LearningIcon'
import type { ReactNode } from 'react'

import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover'

import { FullscreenPortal } from '../../components/FullscreenPortal'

import { PLAYBACK_RATES, SUB_HOLD_OPTIONS, usePlayerPrefs } from './playerPrefs'
import type { AiDuckPolicy, CaptionMode, SubScale } from './playerPrefs'

const OPEN_DELAY_MS = 120
const CLOSE_DELAY_MS = 240

/** 悬停即出的弹层开合状态机，附带"是否由悬停打开"以决定要不要抢焦点 */
function useHoverPopover() {
  const [open, setOpen] = useState(false)
  const timer = useRef<number | undefined>(undefined)
  const byHover = useRef(false)

  const hold = useCallback(() => {
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => {
      byHover.current = true
      setOpen(true)
    }, OPEN_DELAY_MS)
  }, [])
  const release = useCallback(() => {
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => setOpen(false), CLOSE_DELAY_MS)
  }, [])
  const toggle = useCallback(() => {
    window.clearTimeout(timer.current)
    byHover.current = false
    setOpen((v) => !v)
  }, [])
  useEffect(() => () => window.clearTimeout(timer.current), [])

  /** 悬停打开时不抢焦点（鼠标扫过就把焦点拽走很难受），点击打开时正常聚焦 */
  const onOpenAutoFocus = useCallback((e: Event) => {
    if (byHover.current) e.preventDefault()
  }, [])

  return { open, setOpen, hold, release, toggle, onOpenAutoFocus }
}

/** 悬停区包装：鼠标与键盘焦点都能触发 */
function HoverZone({
  hold,
  release,
  children,
}: {
  hold: () => void
  release: () => void
  children: ReactNode
}) {
  return (
    <div
      className="vm-menu-wrap"
      onMouseEnter={hold}
      onMouseLeave={release}
      onFocus={hold}
      onBlur={release}
    >
      {children}
    </div>
  )
}

/** 倍速菜单（FR-108）：档位密、当前档高亮、选择即记忆 */
export function RateMenu({ rate, onRate }: { rate: number; onRate: (r: number) => void }) {
  const m = useHoverPopover()
  return (
    <Popover open={m.open} onOpenChange={m.setOpen}>
      <HoverZone hold={m.hold} release={m.release}>
        <PopoverAnchor asChild>
          <button className="btn-ghost-sm vm-rate-btn" title="播放速度" onClick={m.toggle}>
            <LearningIcon name="speed" size={18} />
            <span>{rate}×</span>
          </button>
        </PopoverAnchor>
      </HoverZone>
      <PopoverContent
        className="vm-rate-menu"
        align="start"
        side="top"
        sideOffset={6}
        onOpenAutoFocus={m.onOpenAutoFocus}
        onMouseEnter={m.hold}
        onMouseLeave={m.release}
      >
        {PLAYBACK_RATES.map((r) => (
          <button
            key={r}
            className={`vm-rate-item${r === rate ? ' active' : ''}`}
            onClick={() => {
              onRate(r)
              m.setOpen(false)
            }}
          >
            {r}×{r === 1 && <span className="vm-rate-tag">正常</span>}
          </button>
        ))}
      </PopoverContent>
    </Popover>
  )
}

/** 音量（FR-110 / FR-122）：悬停向上弹竖向滑杆。
    横向内联滑杆展开会顶动整条控制栏，Netflix / B 站 / Plex 都用竖向弹层避开这点。
    滚轮调音量是播放器通行手势，用原生非被动监听接（React 的 onWheel 是被动的，
    preventDefault 无效会让页面跟着滚）。 */
export function VolumeControl({
  volume,
  muted,
  onVolume,
  onMute,
}: {
  volume: number
  muted: boolean
  onVolume: (v: number) => void
  onMute: () => void
}) {
  const m = useHoverPopover()
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const pct = muted ? 0 : Math.round(volume * 100)

  // 滚轮 ±5%，越界夹紧
  useEffect(() => {
    const el = wrapRef.current
    if (el === null) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const next = Math.min(100, Math.max(0, pct + (e.deltaY < 0 ? 5 : -5)))
      onVolume(next / 100)
      m.hold()
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  })

  return (
    <Popover open={m.open} onOpenChange={m.setOpen}>
      <div
        ref={wrapRef}
        className="vm-menu-wrap"
        onMouseEnter={m.hold}
        onMouseLeave={m.release}
        onFocus={m.hold}
        onBlur={m.release}
      >
        <PopoverAnchor asChild>
          <button
            className="icon-btn"
            title={muted ? '取消静音（M）' : '静音（M）· 滚轮调音量'}
            aria-label={`音量 ${pct}%`}
            onClick={onMute}
          >
            <LearningIcon name="voice" size={19} />
          </button>
        </PopoverAnchor>
      </div>
      <PopoverContent
        className="vm-volpop"
        side="top"
        align="center"
        sideOffset={8}
        onOpenAutoFocus={(e) => e.preventDefault()}
        onMouseEnter={m.hold}
        onMouseLeave={m.release}
      >
        <em>{pct}</em>
        <input
          className="vm-vol-slider"
          type="range"
          min={0}
          max={100}
          value={pct}
          aria-label="音量"
          onChange={(e) => onVolume(Number(e.target.value) / 100)}
        />
      </PopoverContent>
    </Popover>
  )
}

/** 播放器设置（FR-109/113/121）：字幕样式 + 停留时长 + 自动连播 */
export function PlayerSettings() {
  const prefs = usePlayerPrefs()
  const m = useHoverPopover()
  return (
    <Popover open={m.open} onOpenChange={m.setOpen}>
      <HoverZone hold={m.hold} release={m.release}>
        <PopoverAnchor asChild>
          <button
            className="icon-btn"
            title="播放器设置（字幕样式 / 停留 / 自动连播）"
            onClick={m.toggle}
          >
            <GearIcon />
          </button>
        </PopoverAnchor>
      </HoverZone>
      <PopoverContent
        className="vm-pset"
        align="end"
        side="top"
        sideOffset={6}
        onOpenAutoFocus={m.onOpenAutoFocus}
        onMouseEnter={m.hold}
        onMouseLeave={m.release}
      >
        <div className="vm-pset-row">
          <span>字幕背景</span>
          <input
            type="range"
            min={0}
            max={100}
            value={prefs.subBgAlpha}
            onChange={(e) => prefs.set({ subBgAlpha: Number(e.target.value) })}
          />
          <em>{prefs.subBgAlpha}%</em>
        </div>
        <div className="vm-pset-hint">调高不透明度可遮住视频自带的硬字幕</div>
        <div className="vm-pset-row">
          <span>字幕位置</span>
          <input
            type="range"
            min={0}
            max={40}
            value={prefs.subOffset}
            onChange={(e) => prefs.set({ subOffset: Number(e.target.value) })}
          />
          <em>{prefs.subOffset}%</em>
        </div>
        <div className="vm-pset-row">
          <span>字幕字号</span>
          <div className="seg vm-pset-seg">
            {(['s', 'm', 'l'] as SubScale[]).map((k) => (
              <button
                key={k}
                className={prefs.subScale === k ? 'active' : ''}
                onClick={() => prefs.set({ subScale: k })}
              >
                {k === 's' ? '小' : k === 'm' ? '标准' : '大'}
              </button>
            ))}
          </div>
        </div>
        <div className="vm-pset-row">
          <span>字幕停留</span>
          <div className="seg vm-pset-seg">
            {SUB_HOLD_OPTIONS.map(([ms, label]) => (
              <button
                key={ms}
                className={prefs.subHold === ms ? 'active' : ''}
                onClick={() => prefs.set({ subHold: ms })}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
        <div className="vm-pset-hint">念完一句后再挂多久；1 秒内的句间空隙一律不清屏</div>
        <div className="vm-pset-row">
          <span>AI 说话时</span>
          <div className="seg vm-pset-seg">
            {(
              [
                ['pause', '暂停'],
                ['duck', '压低音量'],
                ['off', '不处理'],
              ] as Array<[AiDuckPolicy, string]>
            ).map(([k, label]) => (
              <button
                key={k}
                className={prefs.aiDuck === k ? 'active' : ''}
                onClick={() => prefs.set({ aiDuck: k })}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
        <div className="vm-pset-row">
          <span>自动连播</span>
          <span className="vm-pset-note">播完接着放推荐第一条</span>
          <button
            className={`vm-toggle${prefs.autoNext ? ' on' : ''}`}
            role="switch"
            aria-checked={prefs.autoNext}
            onClick={() => prefs.set({ autoNext: !prefs.autoNext })}
          >
            <i />
          </button>
        </div>
      </PopoverContent>
    </Popover>
  )
}

function GearIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"
      strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1 1.55V21a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1-1.55 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.55-1H3a2 2 0 1 1 0-4h.09a1.7 1.7 0 0 0 1.55-1 1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34h.01a1.7 1.7 0 0 0 1-1.55V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1 1.55 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87v.01a1.7 1.7 0 0 0 1.55 1H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.55 1z" />
    </svg>
  )
}

const CC_OPTIONS: Array<[CaptionMode, string]> = [
  ['auto', '跟随右栏模式'],
  ['both', '双语'],
  ['en', '仅英文'],
  ['zh', '仅中文'],
  ['off', '关闭字幕'],
]

/** 内嵌字幕语言菜单（FR-116）：双语/仅英/仅中/关，独立于右栏模式 */
export function CcMenu() {
  const captionMode = usePlayerPrefs((s) => s.captionMode)
  const set = usePlayerPrefs((s) => s.set)
  const m = useHoverPopover()
  const label =
    captionMode === 'auto' ? 'CC' : captionMode === 'off' ? 'CC关' :
    captionMode === 'both' ? 'CC双' : captionMode === 'en' ? 'CC英' : 'CC中'
  return (
    <Popover open={m.open} onOpenChange={m.setOpen}>
      <HoverZone hold={m.hold} release={m.release}>
        <PopoverAnchor asChild>
          <button
            className={`btn-ghost-sm vm-cc-btn${captionMode !== 'auto' ? ' active' : ''}`}
            title="内嵌字幕显示"
            onClick={m.toggle}
          >
            <LearningIcon name="captions" size={18} />
            <span>{label}</span>
          </button>
        </PopoverAnchor>
      </HoverZone>
      <PopoverContent
        className="vm-rate-menu"
        align="start"
        side="top"
        sideOffset={6}
        onOpenAutoFocus={m.onOpenAutoFocus}
        onMouseEnter={m.hold}
        onMouseLeave={m.release}
      >
        {CC_OPTIONS.map(([key, text]) => (
          <button
            key={key}
            className={`vm-rate-item${captionMode === key ? ' active' : ''}`}
            onClick={() => {
              set({ captionMode: key })
              m.setOpen(false)
            }}
          >
            {text}
          </button>
        ))}
      </PopoverContent>
    </Popover>
  )
}

/** 画中画按钮（FR-112） */
export function PipButton({ videoRef }: { videoRef: React.RefObject<HTMLVideoElement | null> }) {
  if (!('pictureInPictureEnabled' in document)) return null
  return (
    <button
      className="icon-btn"
      title="画中画（P）"
      onClick={() => {
        const el = videoRef.current
        if (el === null) return
        if (document.pictureInPictureElement !== null) void document.exitPictureInPicture()
        else void el.requestPictureInPicture().catch(() => {})
      }}
    >
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"
        strokeLinecap="round" strokeLinejoin="round">
        <rect x="2" y="4" width="20" height="16" rx="2.5" />
        <rect x="12" y="12" width="7" height="5" rx="1" fill="currentColor" stroke="none" />
      </svg>
    </button>
  )
}

const SHORTCUTS: Array<[string, string]> = [
  ['Space', '播放 / 暂停'],
  ['← / →', '上一句 / 下一句'],
  ['Shift + ← / →', '快退 / 快进 5 秒'],
  ['↑ / ↓', '音量增减'],
  ['Home / 0', '从头开始'],
  ['M', '静音切换'],
  ['F', '全屏'],
  ['P', '画中画'],
  ['?', '本帮助'],
]

/** 快捷键帮助浮层（FR-111，? 键呼出） */
export function ShortcutHelp({ open, onClose }: { open: boolean; onClose: () => void }) {
  // hook 不能放在 early return 之后，用 enabled 控制入栈
  useEscapeClose(onClose, open)
  if (!open) return null
  return (
    <FullscreenPortal>
      <div className="vm-help-scrim" onClick={onClose}>
        <div className="vm-help" onClick={(e) => e.stopPropagation()}>
          <b>键盘快捷键</b>
          <table>
            <tbody>
              {SHORTCUTS.map(([key, desc]) => (
                <tr key={key}>
                  <td>
                    <kbd>{key}</kbd>
                  </td>
                  <td>{desc}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <span className="vm-help-hint">按 Esc 或点击任意处关闭</span>
        </div>
      </div>
    </FullscreenPortal>
  )
}
