/* 「让 AI 写一条提示词」的前端侧：一个端点 + 一条覆盖规则。

   **端点只有一份**（`POST /studio/prompts/compose`）。提示词库里的「AI 写一条」给
   `intent`，各工具提示词框旁的「AI 扩写」给 `draft`——两处各写一个端点的话，
   同一条链路会长出两套系统提示词和两种产出形状，改一处忘一处。

   **产出不入库**：这个模块只负责把模型写的东西搬进编辑器，落库仍走常规的
   create / patch。自动入库看着少一步，实际是把「模型写的」和「我认可的」混成一堆——
   生成质量参差是常态，库里一旦混进没人看过的条目，整个库就不敢直接套用了。 */

import { jsonBody, request } from '../../lib/api-image'
import type { PromptVariable } from '../../lib/api-studio'

/** 产出正文的语种。生图模型对英文提示词普遍更准，默认英文 */
export type ComposeLanguage = 'en' | 'zh'

export type ComposeMode = 'create' | 'expand' | 'polish'

export interface ComposeInput {
  intent?: string
  draft?: string
  negative?: string
  mode?: ComposeMode
  language?: ComposeLanguage
  with_negative?: boolean
  with_variables?: boolean
  /** 本轮显式指定部署；留空跟随 chat-general 的能力绑定 */
  deployment_id?: number | null
}

/** AI 产出的草稿。**它不是库里的一条**——落编辑器供人改，改完点保存才入库。 */
export interface ComposedPrompt {
  title: string
  scene: string
  body: string
  negative: string
  variables: PromptVariable[]
  mode: string
  /** 上游真实模型名（核心原则 6）。界面上「模型」那一位显示它，不显示能力名 */
  model: string
  latency_ms: number
}

/** AI 面板的三个开关。默认「英文 · 要负向 · 不留占位」：
    多数时候用户要的是一条能直接用的提示词，不是又一个还得填空的模板。 */
export interface ComposeOptions {
  language: ComposeLanguage
  withNegative: boolean
  withVariables: boolean
}

export const COMPOSE_DEFAULTS: ComposeOptions = {
  language: 'en',
  withNegative: true,
  withVariables: false,
}

export async function composePrompt(input: ComposeInput): Promise<ComposedPrompt> {
  return request<ComposedPrompt>('/studio/prompts/compose', jsonBody('POST', input))
}

/** 编辑器里被 AI 覆盖的那几格。 */
export interface ComposeTarget {
  title: string
  scene: string
  body: string
  negative: string
  variables: PromptVariable[]
}

/** 把产出合进编辑器里的草稿。**返回新草稿，不写任何接口**。

    三条覆盖规则，都是为了「别把用户自己打的东西弄没」：
    - 正文照盖：用户点这个按钮要的就是一段新正文（旧的那版由「撤销」找回来）。
    - 负向只在模型真给了的时候盖：勾掉「带负向」时产出是空串，空串盖上去
      等于悄悄删掉用户自己写的负向。
    - 标题与场景只填空白：用户自己起过的名字不该被模型改掉，那是他用来找这条的。 */
export function applyComposed(current: ComposeTarget, out: ComposedPrompt): ComposeTarget {
  return {
    title: current.title.trim() === '' && out.title !== '' ? out.title : current.title,
    scene: current.scene.trim() === '' && out.scene !== '' ? out.scene : current.scene,
    body: out.body,
    negative: out.negative !== '' ? out.negative : current.negative,
    variables: out.variables,
  }
}

/** 产出之后显示的那行字。「模型」这一位显示上游真名，不显示能力名（核心原则 6）。 */
export function composedNote(out: ComposedPrompt): string {
  const what = out.mode === 'expand' ? '已扩写' : out.mode === 'polish' ? '已润色' : '已写好'
  return `${what} · 模型 ${out.model}`
}
