/* 站内访问记录：按 history 序号记每一页属于哪个模块，给顶栏返回箭头判「上一页是不是本模块的」。

   React Router 把站内导航序号写在 history.state.idx。「深链返回」（BR-G-012）原来只看
   idx > 0 就退一步，但从阅读切菜单进单词本再按返回，退到的是阅读——用户要的是本模块的上一页。
   所以返回箭头的规则改成：上一页在本模块内才退一步，否则去本模块的父级（back.to）。 */

const visits = new Map<number, { module: string | null; route: string }>()

export function currentHistoryIdx(): number | undefined {
  const state = window.history.state as { idx?: number } | null
  return typeof state?.idx === 'number' ? state.idx : undefined
}

/** App 在每次 location 变化时调；同一序号被新导航覆盖（前进分支作废）时直接改写 */
export function recordVisit(idx: number | undefined, module: string | null, route: string): void {
  if (idx === undefined) return
  visits.set(idx, { module, route })
}

export function previousVisit(idx: number | undefined): { module: string | null; route: string } | undefined {
  return idx === undefined ? undefined : visits.get(idx - 1)
}

/** 退一步会落在本模块内吗 */
export function previousVisitInModule(idx: number | undefined, module: string | null): boolean {
  const prev = previousVisit(idx)
  return prev !== undefined && prev.module === module
}

export function resetVisitsForTests(): void {
  visits.clear()
}
