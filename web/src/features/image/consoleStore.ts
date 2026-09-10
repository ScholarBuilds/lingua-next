/* 生图控制台的状态（模块 16 FR-444）。

   放 store 而不是组件里的 `useState`，是因为**切走页面不该丢东西**：控制台是常驻
   工作区，出图 → 回词库看效果 → 回来改图是主路径，而 react-router 切路由会把
   ImagePage 卸载掉。写了一半的想法、挑好的画风、刚出的图、甚至正在跑的任务，
   全都会没。

   还在跑的任务尤其要留住：`jobId` 丢了就再也接不回进度，图只会默默落进画廊，
   用户以为没出。 */

import { create } from 'zustand'

import type { ChatTurn, ImageAsset, PromptExplain } from '@/lib/api-image'

import type { AdvancedValue } from './AdvancedDialog'

export interface RefImage {
  id: string
  file: File
  url: string
}

/** 提示词是按哪套参数生成的。
 *
 *  这条是为了堵一个真实的坑：管线看到 `prompt_override` 非空就**原样发给模型，
 *  画风完全不参与**。于是「先看提示词」把当时的画风焊进正文之后，再改画风就没有
 *  任何效果，而侧栏还显示着新画风——出来的图一直是旧画风，看不出原因。
 *  记下生成时用的画风与尺寸，和当前选择一比就知道该不该提醒用户。 */
export interface PromptOrigin {
  style: string
  size: string
}

/** 「明确不要画风」的 key。后端 `image_prompts.NO_STYLE` 用的就是这个值。
 *
 *  与「没选」不是一回事：空串走用途的默认画风，`none` 才是不注入任何风格描述词。
 *  自由出图的默认已经改成它——通用出图套一个给单词卡调的插画风，本身就是缺陷。 */
export const NO_STYLE = 'none'

/** 「不指定比例」就是 `ratio === null`。
 *
 *  它不是「没选」的同义词：不指定时**由立意按画面内容挑**——手机整屏挑 9:16、
 *  横幅挑 16:9、头像挑 1:1。画幅本来就是画面的一部分，与其让人在八个比例里
 *  猜哪个配得上自己的想法，不如让想画面的那一步定了再显示出来。 */
export const AUTO_RATIO = null

export const DEFAULT_ADVANCED: AdvancedValue = {
  quality: 'medium',
  count: 1,
  outputFormat: null,
  background: null,
  outputCompression: null,
  moderation: null,
}

interface ConsoleState {
  /** 上一次真正生效的应用。用来区分「换了应用」与「只是页面重新挂载」 */
  appKey: string
  idea: string
  prompt: string
  /** null = 手写的，或者还没生成过 */
  promptOrigin: PromptOrigin | null
  /** 用户在提示词框里手改过。手写的提示词画风一律不参与，与 origin 无关 */
  handWritten: boolean

  styleKey: string | null
  /** null = 不指定，由立意挑 */
  ratio: string | null
  /** 立意最近一次挑中的比例，只用来显示「AI 选了什么」，不参与提交 */
  pickedRatio: string | null
  tier: string
  advanced: AdvancedValue

  refs: RefImage[]

  /** 和 AI 改词的对话历史。放 store 是因为聊到一半切走再回来不该从头开始 */
  chat: ChatTurn[]
  /** 提示词的中文解读，以及它是给哪一份提示词做的——提示词一变解读就作废 */
  explain: PromptExplain | null
  explainOf: string

  results: ImageAsset[]
  picked: number | null
  jobId: number | null
  startedAt: number | null

  railOpen: boolean
  paramsOpen: boolean

  set: (patch: Partial<ConsoleState>) => void
  /** 提示词被自动生成填上：记下当时用的画风与尺寸 */
  fillPrompt: (text: string, origin: PromptOrigin) => void
  /** 用户手改提示词 */
  typePrompt: (text: string) => void
  addRefs: (items: RefImage[]) => void
  removeRef: (id: string) => void
  pushChat: (turns: ChatTurn[]) => void
  clearChat: () => void
  /** 换应用时收掉不适用的输入，但**留住提示词与参考图**（BR-119）。
   *
   *  必须自己判断「到底换没换」：这个回调挂在 effect 上，页面切走再回来会**重新挂载**
   *  并再跑一次。不判断的话，回到控制台画风就被悄悄重置回应用默认——用户挑好的
   *  剪影摄影风变回柔和扁平插画，而他什么都没做。 */
  onAppChanged: (appKey: string, lockedRatio: string | null, quality: string) => void
}

export const useConsoleStore = create<ConsoleState>((set) => ({
  appKey: '',
  idea: '',
  prompt: '',
  promptOrigin: null,
  handWritten: false,

  styleKey: null,
  ratio: null,
  pickedRatio: null,
  tier: '1k',
  advanced: DEFAULT_ADVANCED,

  refs: [],

  chat: [],
  explain: null,
  explainOf: '',

  results: [],
  picked: null,
  jobId: null,
  startedAt: null,

  railOpen: true,
  paramsOpen: true,

  set: (patch) => set(patch),

  // 提示词一换，上一份中文解读就不再描述它了。留着比没有更糟——
  // 用户会照着一段讲的是旧提示词的中文去判断该不该出图
  fillPrompt: (text, origin) =>
    set({ prompt: text, promptOrigin: origin, handWritten: false, explain: null, explainOf: '' }),

  typePrompt: (text) =>
    set((s) => ({
      prompt: text,
      // 一旦手改，就不再声称它属于某个画风——它属于用户
      handWritten: text.trim() !== '' && text !== s.prompt ? true : s.handWritten,
      explain: text === s.explainOf ? s.explain : null,
    })),

  addRefs: (items) => set((s) => ({ refs: [...s.refs, ...items] })),

  pushChat: (turns) => set((s) => ({ chat: [...s.chat, ...turns] })),

  clearChat: () => set({ chat: [] }),

  removeRef: (id) =>
    set((s) => {
      const hit = s.refs.find((r) => r.id === id)
      // objectURL 由 store 持有，只在真正移除时释放；页面卸载时不能释放，
      // 否则切回来图就裂了
      if (hit) URL.revokeObjectURL(hit.url)
      return { refs: s.refs.filter((r) => r.id !== id) }
    }),

  onAppChanged: (appKey, lockedRatio, quality) =>
    set((s) => {
      // 只是重新挂载，不是换应用——什么都别动
      if (s.appKey === appKey) return {}
      return {
        appKey,
        // 对话与解读都是围着上一个应用的画面说的，换了应用就不再成立
        chat: [],
        explain: null,
        explainOf: '',
        styleKey: null,
        pickedRatio: null,
        ratio: lockedRatio !== null ? null : s.ratio,
        advanced: { ...s.advanced, quality: quality || s.advanced.quality },
      }
    }),
}))

/** 提示词当前处于什么状态，决定侧栏怎么说、画风到底生不生效。 */
export type PromptState =
  | { kind: 'empty' }
  | { kind: 'fresh' }
  | { kind: 'stale'; wasStyle: string }
  | { kind: 'hand' }

export function promptStateOf(
  prompt: string,
  origin: PromptOrigin | null,
  handWritten: boolean,
  style: string,
  /** 用户**钉住**的尺寸；null = 不指定比例，这一项不参与比对 */
  pinnedSize: string | null,
): PromptState {
  if (prompt.trim() === '') return { kind: 'empty' }
  if (handWritten || origin === null) return { kind: 'hand' }
  if (origin.style !== style) return { kind: 'stale', wasStyle: origin.style }
  /* 画幅同理。实测过：**`size` 参数不决定出图比例，提示词里的 `layout.canvas`
     那句才决定**。所以换了比例却不重写提示词，出来的图仍是旧比例——
     侧栏显示 9:16、图却是方的，和当初画风那个坑一模一样。

     只在用户钉了比例时才比：不指定的时候尺寸是立意连同这份提示词一起定的，
     天然一致；拿「下次可能挑出别的」去比会让它永远 stale，自动重写陷入死循环。 */
  if (pinnedSize !== null && origin.size !== pinnedSize) {
    return { kind: 'stale', wasStyle: '' }
  }
  return { kind: 'fresh' }
}
