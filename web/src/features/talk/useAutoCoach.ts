import { useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef } from 'react'
import { toast } from 'sonner'
import { generateCoach, sessionCoachQueue } from './coachQueue'

export function useAutoCoach(sessionId: number | null,
  turns: { turnId?: number; role: string; complete?: boolean }[], enabled: boolean) {
  const client = useQueryClient()
  const seen = useRef(new Set<number>())
  const previouslyEnabled = useRef(enabled)
  useEffect(() => {
    seen.current.clear()
    return () => { if (sessionId !== null) sessionCoachQueue(sessionId).cancelAutomatic() }
  }, [sessionId])
  useEffect(() => {
    if (sessionId === null) return
    const eligible = turns.filter((t) => t.turnId != null && t.role === 'ai' && t.complete)
    const unseen = eligible.filter((t) => !seen.current.has(t.turnId!))
    const candidates = !previouslyEnabled.current && enabled ? eligible.slice(-1) : unseen
    eligible.forEach((t) => seen.current.add(t.turnId!))
    previouslyEnabled.current = enabled
    if (!enabled) { sessionCoachQueue(sessionId).cancelAutomatic(); return }
    candidates.forEach((turn) => {
      void generateCoach(client, sessionId, turn.turnId!, 0, true).catch(() => {
        toast.error('自动辅助请求失败，可在右侧手动重试；语音对话不受影响')
      })
    })
  }, [sessionId, turns, enabled, client])
}
