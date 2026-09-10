/* 值的防抖：输入框每个键都改 state，请求只在停手 `delayMs` 后发一次。
   `useDeferredValue` 不是防抖——它只推迟渲染，每个键仍各发一次请求。 */

import { useEffect, useState } from 'react'

export function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs)
    return () => clearTimeout(timer)
  }, [value, delayMs])
  return debounced
}
