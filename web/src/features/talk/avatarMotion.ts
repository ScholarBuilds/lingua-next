export type PartnerStatus = 'connecting' | 'listening' | 'thinking' | 'speaking' | 'ended' | 'error'

export function mouthOpening(previous: number, level: number, status: PartnerStatus, dt: number): number {
  if (status !== 'speaking' || !Number.isFinite(level)) return 0
  const target = Math.min(0.8, Math.max(0, level) * 0.8)
  const speed = target > previous ? 24 : 18
  return previous + (target - previous) * (1 - Math.exp(-speed * Math.min(0.1, Math.max(0, dt))))
}

export function blinkAmount(time: number): number {
  const phase = time % 4.7
  return phase < 0.18 ? Math.sin((phase / 0.18) * Math.PI) : 0
}
