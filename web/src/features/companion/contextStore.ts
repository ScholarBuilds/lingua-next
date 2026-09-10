/* 陪读上下文引用（需求 07 v2 FR-13/BR-07）。

   原先点句即隐式注入 AI，用户既看不到 AI"正看着"哪句，也无法撤回——业内已收敛到
   显式范式（VS Code Copilot / JetBrains 的 Add to Chat：引用可见、可移除）。
   本 store 是「AI 知道什么」的唯一事实来源：卡里列的就是发出去的，不多不少。

   文章页与视频页共用；引用来源可以是整句、拖选片段或跟读比对结果。 */

import { create } from 'zustand'

export type RefKind = 'sentence' | 'selection' | 'shadow'

export interface CompanionRef {
  /** 稳定 key：同一句重复添加不产生第二张卡 */
  key: string
  /** 交给 AI 的文本 */
  text: string
  /** 出处标签，卡片上展示（"第 12 句" / "03:21" / "选区"） */
  source: string
  kind: RefKind
  /** 附加说明：跟读比对的漏读/错读词等，随文本一起交给 AI */
  note?: string
  /** 已随某次提问发给 AI。未发出的只是"AI 待会儿要看的"，不触发任何回答（FR-311） */
  sent?: boolean
}

/** 引用上限：语音会话里堆太多句反而让 AI 抓不住重点 */
const MAX_REFS = 5

interface CompanionContextState {
  refs: CompanionRef[]
  /** 添加引用；已存在同 key 则提到最后（表示"再问一次这句"） */
  addRef: (ref: CompanionRef) => void
  removeRef: (key: string) => void
  /** 随提问送出后调用：卡片转为"已发给 AI"，下次提问不再重复带上 */
  markSent: () => void
  clear: () => void
}

export const useCompanionContext = create<CompanionContextState>((set) => ({
  refs: [],
  addRef: (ref) =>
    set((s) => {
      const rest = s.refs.filter((r) => r.key !== ref.key)
      return { refs: [...rest, ref].slice(-MAX_REFS) }
    }),
  removeRef: (key) => set((s) => ({ refs: s.refs.filter((r) => r.key !== key) })),
  markSent: () => set((s) => ({ refs: s.refs.map((r) => ({ ...r, sent: true })) })),
  clear: () => set({ refs: [] }),
}))

/** 待发送的引用（还没随任何提问出去过） */
export function pendingRefs(): CompanionRef[] {
  return useCompanionContext.getState().refs.filter((r) => r.sent !== true)
}

/** 引用 → 交给 AI 的文本（带出处与附注，便于 AI 指名道姓地讲） */
export function refToPrompt(ref: CompanionRef): string {
  const head =
    ref.kind === 'shadow'
      ? `[跟读比对] ${ref.source}`
      : ref.kind === 'selection'
        ? `[用户选中了这段] ${ref.source}`
        : `[用户想学这句] ${ref.source}`
  return ref.note ? `${head}\n"${ref.text}"\n${ref.note}` : `${head}\n"${ref.text}"`
}
