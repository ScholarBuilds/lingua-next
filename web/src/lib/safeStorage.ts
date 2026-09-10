/* zustand persist 的安全存储：localStorage 在隐私窗口 / 缩略图渲染里会直接抛，
   测试跑在 node 里也没有 window.localStorage；读不到就落内存，别让页面跟着崩。 */

export function safeStorage(): Storage {
  try {
    const store = globalThis.localStorage
    if (store !== undefined && typeof store.getItem === 'function') return store
  } catch {
    /* 落到内存 */
  }
  const memory = new Map<string, string>()
  return {
    getItem: (k) => memory.get(k) ?? null,
    setItem: (k, v) => void memory.set(k, v),
    removeItem: (k) => void memory.delete(k),
    clear: () => memory.clear(),
    key: (i) => [...memory.keys()][i] ?? null,
    get length() {
      return memory.size
    },
  }
}
