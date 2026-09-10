/* 阅读侧「这次用哪个模型」的共用状态。
 *
 * 语义是 per-call 覆盖：只影响下一次分析请求，不写回 capability_binding。选择记在 localStorage，
 * 换一台设备、换一个人就回到跟随绑定——它是一次实验，不是配置。
 *
 * 服务端那边 `deployment_id` 会进缓存寻址（analyze.py 的 provider 加 `#d<id>` 后缀），
 * 所以换了模型不用额外传 refresh 也会真的重算；跟随绑定时寻址键不变，历史缓存照旧有效。
 */

import { useQuery } from '@tanstack/react-query'
import { useCallback, useMemo, useState } from 'react'

import { apiConfig } from '@/lib/api-config'
import { safeStorage } from '@/lib/safeStorage'

const STORAGE_KEY = 'reader-analyze-model'

function readPinned(): Record<string, number> {
  try {
    const raw = safeStorage().getItem(STORAGE_KEY)
    const parsed: unknown = raw === null ? null : JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object') return {}
    return Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>).filter(
        (entry): entry is [string, number] => typeof entry[1] === 'number',
      ),
    )
  } catch {
    return {}
  }
}

export function useAnalyzeModel(capability: string) {
  const [pinned, setPinned] = useState<number | null>(() => readPinned()[capability] ?? null)
  const [open, setOpen] = useState(false)
  const bindingsQuery = useQuery({ queryKey: ['cfg-bindings'], queryFn: apiConfig.bindings })

  const row = useMemo(
    () => bindingsQuery.data?.find((b) => b.capability === capability),
    [bindingsQuery.data, capability],
  )

  const pin = useCallback(
    (deploymentId: number | null) => {
      setPinned(deploymentId)
      const all = readPinned()
      if (deploymentId === null) delete all[capability]
      else all[capability] = deploymentId
      try {
        safeStorage().setItem(STORAGE_KEY, JSON.stringify(all))
      } catch {
        /* 隐私模式下存不了：钉选仍在本次会话内生效，不该因此报错 */
      }
    },
    [capability],
  )

  const options = row?.deployment_options ?? []
  const pinnedRow = pinned === null ? undefined : options.find((d) => d.id === pinned)
  // 钉的那条部署被删了或停用了：悄悄回到跟随绑定，别显示一个指向空的 id
  const deploymentId = pinnedRow === undefined ? null : pinned
  const boundModel = row?.deployment?.upstream_model_id ?? row?.target ?? null

  return {
    open,
    setOpen,
    options,
    deploymentId,
    pin,
    boundModel,
    /* 「模型」位的格式固定 `<中文能力名> · <真实模型名>`（核心原则 6）。能力名不随钉选变化——
       钉的是模型不是能力，把它换成模型名会渲染出「kimi-for-coding · kimi-for-coding」。 */
    label: row?.label ?? capability,
    /** 这次用的不是绑定的那条模型，界面上要说清楚，否则用户不知道自己还钉着 */
    pinned: pinnedRow !== undefined,
    /** 绑定表还没到手时是 true：这时「没绑定」和「还不知道」要分得开 */
    loading: bindingsQuery.isPending,
  }
}
