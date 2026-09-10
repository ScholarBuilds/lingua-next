/* 旧主题键（`ln-theme`）到三态 `ThemePref` 的映射。

   单独成文件是因为 `prefStore.ts` 在模块求值期就建了 zustand store 并读 localStorage，
   而本仓 vitest 跑在 node 里没有 jsdom——纯计算留在那边就没法直接测。 */

export type ThemePref = 'light' | 'dark' | 'system'

/**
 * 旧的两态主题键 → 三态。
 *
 * > [!warning] 原来这里把 `'light'` 判成了「跟随系统」
 * >
 * > 判据写的是 `v === '' ? 'light' : 'system'`——只有**空字符串**才映射到浅色，
 * > 而学习端与前台写进去的恰恰是字符串 `'light'`
 * > （`LearningShell` 与 `learner-web/AppShell` 都是
 * > `setItem('ln-theme', dark ? 'dark' : 'light')`）。
 * > 于是「在学习端选了浅色」的用户进后台会被判成跟随系统，
 * > 系统是深色时就莫名其妙变深色，而他并没有选过跟随系统。
 */
export function themeFromLegacy(v: string | null): ThemePref {
  if (v === 'dark') return 'dark'
  if (v === 'light') return 'light'
  // 旧键表达不了「跟随系统」；认不出的一律回默认，别猜
  return 'system'
}
