import { useEffect, useRef, useState } from 'react'

import type { PartnerStatus } from './avatarMotion'
import './talkAvatar.css'

export function TalkAvatar({ status, readLevel, readBrightness }: {
  status: PartnerStatus
  readLevel: () => number
  readBrightness?: () => number
}) {
  const hostRef = useRef<HTMLDivElement>(null)
  const live = useRef({ status, readLevel, readBrightness })
  live.current = { status, readLevel, readBrightness }
  const [phase, setPhase] = useState<'loading' | 'ready' | 'error'>('loading')
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    let active = true
    let dispose: (() => void) | undefined
    const motion = window.matchMedia('(prefers-reduced-motion: reduce)')
    setPhase('loading')
    void import('./avatarScene').then(({ createAvatarScene }) => {
      if (!active) return
      dispose = createAvatarScene(host, () => ({
        status: live.current.status,
        level: live.current.readLevel(),
        brightness: live.current.readBrightness?.(),
        reducedMotion: motion.matches,
      }), () => {
        if (active) setPhase('ready')
      }, () => {
        if (active) setPhase('error')
      })
    }).catch(() => {
      if (active) setPhase('error')
    })
    return () => {
      active = false
      dispose?.()
    }
  }, [attempt])

  return (
    <div className="talk-avatar" data-phase={phase}>
      <div className="talk-avatar-canvas" ref={hostRef} role="img" aria-label="3D 口语伙伴，口型随播放声音变化" />
      {phase !== 'ready' && (
        <div className="talk-avatar-placeholder" role="status">
          <span>{phase === 'loading' ? '正在准备数字人…' : '数字人暂时无法显示'}</span>
          <span className="talk-avatar-note">语音和字幕不受影响</span>
          {phase === 'error' && (
            <button className="btn btn-outline" onClick={() => setAttempt((value) => value + 1)}>
              重新加载数字人
            </button>
          )}
        </div>
      )}
    </div>
  )
}
