/* 「模型」位怎么写字：全项目统一口径（规范见 01.项目文档/02.架构/02.模型命名与展示口径.md）。

   两层名字不能混：
   - **能力名**（`repair-agent` / `image-free`）是路由键，只在代码与接口里出现，UI 上不露 slug；
   - **上游真实模型名**（`gpt-image-2` / `deepseek-chat`）是用户在「模型」位真正想看到的东西。

   凡是标着「模型」的位置一律显示真名；查不到就说查不到，不拿能力名顶替（核心原则 4）。 */

/** 真名查不到时的占位。写死一句话是为了让"没绑定"和"绑了但没显示"看起来不一样 */
export const UNKNOWN_MODEL_TEXT = '未绑定模型'

/** 「模型」位的文本：有真名给真名，没有就如实说没有。 */
export function modelText(model: string | null | undefined): string {
  const name = (model ?? '').trim()
  return name === '' ? UNKNOWN_MODEL_TEXT : name
}

/** 既要说清是哪个能力、又要说清实际用了哪个模型时的统一格式：`<中文能力名> · <真实模型名>`。
 *
 *  `capabilityLabel` 传中文标签（绑定行的 `label`）。传空就退化成只显示模型名——
 *  宁可少一层信息，也不要把 `image-free` 这种 slug 摆到用户眼前。 */
export function capabilityWithModel(
  capabilityLabel: string | null | undefined,
  model: string | null | undefined,
): string {
  const label = (capabilityLabel ?? '').trim()
  return label === '' ? modelText(model) : `${label} · ${modelText(model)}`
}
