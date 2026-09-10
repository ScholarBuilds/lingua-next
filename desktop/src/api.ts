export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

const HEALTH_TIMEOUT_MS = 2000

export function clientProxyConfig(policy: { enabled: boolean; scope: string; address: string }): {
  mode: 'direct' | 'fixed_servers'; proxyRules?: string; proxyBypassRules?: string
} {
  return policy.enabled && policy.scope === 'all' ? {
    mode: 'fixed_servers', proxyRules: policy.address,
    proxyBypassRules: 'localhost;127.0.0.0/8;[::1]',
  } : { mode: 'direct' }
}

/** 依次探 `${base}/healthz`，第一个回 200 的就是；全失败把试过的地址列在错误里，日志一眼看出配错在哪 */
export async function resolveApiBase(candidates: string[], fetchImpl: FetchLike = fetch): Promise<string> {
  const tried: string[] = []
  for (const candidate of candidates) {
    const base = candidate.replace(/\/+$/, '')
    tried.push(base)
    const healthy = await fetchImpl(`${base}/healthz`, { signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) })
      .then((response) => response.status === 200)
      .catch(() => false)
    if (healthy) return base
  }
  throw new Error(`本地 API 没有响应，试过：${tried.join('、')}`)
}
