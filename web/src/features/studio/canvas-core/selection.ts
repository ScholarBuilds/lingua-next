/* 画布内核 · 选择语义（模块 17 · CR-005 §3.1）
 *
   蓝本 `static/js/smart-canvas.js` 只有「点 = 只选它」和「Ctrl 点 = 加选」两档，
   多选之后想摘掉其中一个只能整批重选。这里补齐第三档（反选），
   并且把三档的判定与结算收成两个纯函数——

   收成纯函数的原因很实际：节点、连线两处各写一遍的话，迟早出现
   「⌘ 点节点是减选、⌘ 点连线是加选」这种同一个手势在同一块画布上两种含义。
   现在两处调同一个 `selectModeOf`，语义只有一个产地。 */

/** 点一下是什么意思。
 *
 *  `replace` 裸点：只选它。
 *  `append` ⇧点：加进选区（连续加选，不会误减）。
 *  `toggle` ⌘/Ctrl 点：在选区里就去掉，不在就加进来。 */
export type SelectMode = 'replace' | 'append' | 'toggle'

/** 从指针/鼠标事件读出档位。
 *
 *  ⌘/Ctrl 优先于 ⇧：两个都按住时按反选算，与 Figma、Illustrator 一致。 */
export function selectModeOf(e: { shiftKey: boolean; metaKey: boolean; ctrlKey: boolean }): SelectMode {
  if (e.metaKey || e.ctrlKey) return 'toggle'
  if (e.shiftKey) return 'append'
  return 'replace'
}

/**
 * 结算一次点击后的选区。
 *
 * `keys` 是这一下点中的东西——通常一个，但连线会成桶（同一来源连到分组各成员的边
 * 合并成一条线，点中它等于点中背后所有边），所以按数组处理。
 *
 * `toggle` 的判据是「**整桶**都在选区里才算已选中」：合并线背后压着好几条边，
 * 只要还有一条没选上，这一下的意图就是把它们补齐，而不是把已选的那几条摘掉。
 *
 * 返回新数组，顺序按「先来的留在前面、新加的接在后面」，
 * 这样帮助面板或状态栏里显示的顺序不会每点一下就重排。
 */
export function applySelection(current: readonly string[], keys: readonly string[], mode: SelectMode): string[] {
  if (keys.length === 0) return [...current]
  if (mode === 'replace') return [...new Set(keys)]
  const set = new Set(current)
  const on = mode === 'append' || !keys.every((k) => set.has(k))
  for (const k of keys) {
    if (on) set.add(k)
    else set.delete(k)
  }
  const kept = current.filter((k) => set.has(k))
  const added = [...set].filter((k) => !current.includes(k))
  return [...kept, ...added]
}
