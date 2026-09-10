/* 会话级持久化（BR-G-013）。

   「领取一批新词」这类接口一调用就落库，刷新后重新请求只会领到新的一批，
   旧批次的进度无处可寻。这类数据必须存客户端，且只在本标签页有效——
   换标签页重开就该是一次新的学习，用 sessionStorage 而不是 localStorage。 */

export function readSession<T>(key: string): T | null {
  try {
    const raw = sessionStorage.getItem(key)
    return raw === null ? null : (JSON.parse(raw) as T)
  } catch {
    return null
  }
}

export function writeSession(key: string, value: unknown): void {
  try {
    sessionStorage.setItem(key, JSON.stringify(value))
  } catch {
    // 配额满或隐私模式：持久化失败不该让学习流程崩掉
  }
}

export function clearSession(key: string): void {
  try {
    sessionStorage.removeItem(key)
  } catch {
    /* 同上 */
  }
}
