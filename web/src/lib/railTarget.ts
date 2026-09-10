/* 侧栏菜单项的去向。放独立模块而不是留在 App.tsx 里：那里 import 一次会拉起 prefStore 等一串
   带副作用的模块（node 环境下碰 localStorage 直接抛），纯计算测不了。 */

/** 侧栏菜单项点下去该落在哪。抽成纯函数是因为它是**用户出不去时的最后一个出口**，
 *  判据写在 JSX 的三元里没人能测，也没人看得见。
 *
 *  工坊固定进入应用首页，其余模块分三档：
 *  - 不在这个模块 → 上次待的地方（开了页面记忆时），否则模块首页
 *  - 已在这个模块的子页 → **模块首页**。深链直接打开 `/talk/session?id=…` 时页面自己可能
 *    没给返回键、面包屑也可能不可点，菜单项原来指向当前 URL——点了什么都不会发生
 *  - 已在模块首页 → 原地，不留一条没用的历史
 */
export function railTarget({
  to,
  active,
  here,
  pathname,
  lastRoute,
}: {
  to: string
  active: boolean
  here: string
  pathname: string
  lastRoute?: string
}): string {
  if (to === '/studio') return to
  if (to === '/vocab' && new URLSearchParams(lastRoute?.split('?')[1]).get('v') === 'dict') return to
  if (to === '/vocab' && lastRoute?.split(/[?#]/)[0] === '/vocab/scenes') return to
  if (!active) return lastRoute !== undefined && lastRoute !== '' ? lastRoute : to
  return pathname === to ? here : to
}
