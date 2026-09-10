/* 提示词模板变量的前端侧算法。

   占位语法是双花括号 `{{name}}`，与服务端 `domain/studio_prompts.VARIABLE_RE` 同一套：
   单花括号会和提示词里常贴的 JSON 片段撞车，方括号会和 SD/ComfyUI 的权重语法撞车。
   名字允许中文，两边判据必须一字不差地对上（见下面 VARIABLE_RE 的注释）。

   这里重算一遍**不是**为了替服务端把关——保存时服务端会按正文重新派生一次，
   它才是事实源。前端算是为了让编辑器在打字时就能显示「这条正文里有哪些变量」，
   否则用户得先存一次才知道自己写对没有。 */

import type { PromptVariable } from '../../lib/api-studio'
import type { JsonSchema } from './SchemaForm'

/* 名字允许中文：界面上的例子写的就是 `{{主体}}`，内置模板迁入时也把蓝本的 `[主体]`
   换成了它。原来只认 ASCII，照着例子写的占位一个都匹配不上，既不进变量名单也不报错，
   套用时原样发给模型——正是这条链路唯一真正会出事的失败模式。
   JS 的 `\w` 恒为 ASCII，只能用 `\p{L}` 系列写，与服务端 `[^\W\d]\w*` 等价。 */
const VARIABLE_RE = /\{\{\s*([\p{L}_][\p{L}\p{N}_]*)\s*\}\}/gu

/** 按首次出现顺序取占位名并去重。顺序即表单里的字段顺序 */
export function extractVariableNames(...texts: string[]): string[] {
  const names: string[] = []
  for (const text of texts) {
    for (const match of text.matchAll(VARIABLE_RE)) {
      const name = match[1]
      if (!names.includes(name)) names.push(name)
    }
  }
  return names
}

/** 正文里还有没有没填的占位。

    这是套用前的最后一道闸：变量名单正常由服务端按正文派生，两边不该对不上，
    但缓存里的旧条目、手改过的库都可能让 `variables` 为空而正文里还有 `{{name}}`。
    带着占位的正文插进提示词框，模型不会报错，只会照着乱出图——只看 `variables`
    这一个信号不够，正文自己也要问一次。 */
export function hasUnfilledPlaceholders(...texts: string[]): boolean {
  return extractVariableNames(...texts).length > 0
}

/** 把已有的说明对齐到正文里真实存在的占位。
 *  名单由正文决定：声明里多出来的变量替换不了任何东西，留着只会在表单上
 *  多一个填了也没用的格子。 */
export function mergeVariables(
  body: string,
  negative: string,
  declared: PromptVariable[],
): PromptVariable[] {
  const known = new Map(declared.map((item) => [item.name, item]))
  return extractVariableNames(body, negative).map((name) => {
    const spec = known.get(name)
    return {
      name,
      label: spec?.label ?? '',
      description: spec?.description ?? '',
      default: spec?.default ?? '',
      // 没写过就按必填算：漏填一个变量把 `{{name}}` 原样发给模型是唯一真正会出事的
      // 失败模式，默认值站在会报错的那一边
      required: spec?.required ?? true,
    }
  })
}

/** 变量声明 → JSON Schema，交给 SchemaForm 渲染填写表单。
 *  不另写一套表单控件：SchemaForm 已经处理了必填标记、约束提示与错误定位。 */
export function variableSchema(variables: PromptVariable[]): JsonSchema {
  const properties: Record<string, JsonSchema> = {}
  for (const item of variables) {
    const field: JsonSchema = {
      type: 'string',
      title: item.label === '' ? item.name : item.label,
    }
    if (item.description !== '') field.description = item.description
    if (item.default !== '') field.default = item.default
    properties[item.name] = field
  }
  return {
    type: 'object',
    properties,
    required: variables.filter((item) => item.required).map((item) => item.name),
  }
}

/** 表单值 → 接口要的字符串字典。非字符串（用户切到「引用」模式手写的 JSON）按原样转字符串，
 *  由服务端去判合不合法——前端悄悄丢掉一个值比报错更难查。 */
export function toRenderValues(value: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, raw] of Object.entries(value)) {
    if (raw === undefined || raw === null) continue
    out[key] = typeof raw === 'string' ? raw : JSON.stringify(raw)
  }
  return out
}
