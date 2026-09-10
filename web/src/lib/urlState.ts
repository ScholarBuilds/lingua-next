/* 可见状态进 URL（BR-G-011）。

   视图状态放组件局部 state 等于「刷新即丢」：用户在词库某个本里刷新，回来却在词库主页。
   React Router 的 useSearchParams 是这件事的标准载体，这里只做两件事：
   一次改多个参数、区分「进新页面」（push，浏览器后退能退回来）与「改筛选」（replace，不脏 history）。 */

import { useCallback, useMemo } from 'react'
import { useSearchParams } from 'react-router-dom'

export type ParamPatch = Record<string, string | null | undefined>

export function useUrlParams(): [
  URLSearchParams,
  (patch: ParamPatch, opts?: { push?: boolean }) => void,
] {
  const [params, setParams] = useSearchParams()

  const patch = useCallback(
    (next: ParamPatch, opts?: { push?: boolean }) => {
      setParams(
        (prev) => {
          const out = new URLSearchParams(prev)
          for (const [k, v] of Object.entries(next)) {
            if (v === null || v === undefined || v === '') out.delete(k)
            else out.set(k, v)
          }
          return out
        },
        { replace: opts?.push !== true },
      )
    },
    [setParams],
  )

  return [params, patch]
}

/* > [!danger] 同一个事件里不要连调多次 patch / 多个 setter
   >
   > `setSearchParams` 不是 `useState`：它触发的是导航，同一事件里连调几次，
   > 每次读到的都是导航**前**那份 location，于是只有最后一次生效。
   > 「清空全部筛选」这类要一次 `patch({a: null, b: null, ...})` 写完。
   > 实测症状：点「清除筛选」只清掉最后一个条件，其余原样留在 URL 上。 */

/** 单参数版：取值带兜底，写入时等于兜底就把参数删掉，URL 不留冗余 */
export function useUrlValue<T extends string>(
  key: string,
  fallback: T,
  allowed?: readonly T[],
): [T, (v: T, opts?: { push?: boolean }) => void] {
  const [params, patch] = useUrlParams()
  const raw = params.get(key)
  const value =
    raw !== null && (allowed === undefined || (allowed as readonly string[]).includes(raw))
      ? (raw as T)
      : fallback
  const set = useCallback(
    (v: T, opts?: { push?: boolean }) => patch({ [key]: v === fallback ? null : v }, opts),
    [key, fallback, patch],
  )
  return [value, set]
}

/** 多选集合进 URL：逗号分隔，空集合不留参数（免得 URL 里挂一串空键）。

    与 `useUrlValue` 的分工：那个存单值，这个存「勾了哪几个」。
    `parse` 把字符串还原成集合元素（数字筛选传 `Number`，字符串传 `String`）。
    setter 与 `useState<Set>` 同形，接收新集合而不是 patch，调用方不必改写法。 */
export function useUrlSet<T extends number | string>(
  key: string,
  parse: (raw: string) => T,
): [Set<T>, (next: Set<T>) => void] {
  const [params, patch] = useUrlParams()
  const raw = params.get(key)
  const value = useMemo(() => {
    if (raw === null || raw === '') return new Set<T>()
    return new Set(raw.split(',').filter(Boolean).map(parse))
    // parse 由调用方给且恒定（Number/String），不进依赖免得每次新建集合
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [raw])
  const set = useCallback(
    (next: Set<T>) => patch({ [key]: next.size === 0 ? null : [...next].join(',') }),
    [key, patch],
  )
  return [value, set]
}
