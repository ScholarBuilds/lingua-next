export function externalUrl(value: unknown): string | null {
  if (typeof value !== 'string' || !URL.canParse(value)) return null
  const url = new URL(value)
  return ['https:', 'http:', 'mailto:'].includes(url.protocol) ? url.href : null
}

export function trustedFrame(url: string, origin: string, mainFrame: boolean): boolean {
  return mainFrame && URL.canParse(url) && new URL(url).origin === origin
}

export function restartAttempt(previous: number, readyAt: number, now: number): number {
  return readyAt > 0 && now - readyAt >= 60_000 ? 1 : previous + 1
}

export function restartDelay(attempt: number): number | null {
  return attempt > 5 ? null : Math.min(30_000, 1000 * 2 ** Math.max(0, attempt - 1))
}
