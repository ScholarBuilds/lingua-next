/* 设置弹窗（需求 09 v7 FR-93）：从任意页面点齿轮以模态打开，关闭回原页原状态。

   深链走 URL search param（?settings=<section>）：刷新后弹窗在同一页面重开，
   分区可直达可分享；/settings/:section 整页路由保留，直链与旧入口不受影响。 */

import { lazy, Suspense } from 'react'
import { useSearchParams } from 'react-router-dom'

import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'

import { ModuleBoundary } from '@/components/ModuleBoundary'
import { workspaceSnapshot, useWorkspaceStore } from '@/lib/workspaceStore'

export const SETTINGS_PARAM = 'settings'

const SettingsShell = lazy(async () => {
  const page = await import('./SettingsPage')
  return { default: ({ active, onSelect }: { active: string; onSelect: (key: string) => void }) =>
    <page.SettingsShell active={page.normalizeSection(active)} onSelect={onSelect} /> }
})

/** 任意组件打开设置弹窗：useOpenSettings()('models') */
export function useOpenSettings(): (section?: string) => void {
  const [params, setParams] = useSearchParams()
  return (section = workspaceSnapshot('settings', 'section').selected ?? 'models') => {
    const next = new URLSearchParams(params)
    next.set(SETTINGS_PARAM, section)
    useWorkspaceStore.getState().put('settings', 'section', { selected: section })
    setParams(next)
  }
}

export function SettingsModal() {
  const [params, setParams] = useSearchParams()
  const raw = params.get(SETTINGS_PARAM)

  const close = () => {
    const next = new URLSearchParams(params)
    next.delete(SETTINGS_PARAM)
    setParams(next)
  }

  return (
    <Dialog open={raw !== null} onOpenChange={(o) => !o && close()}>
      <DialogContent className="settings-modal" aria-describedby={undefined}>
        {/* Radix 无障碍要求标题存在；视觉上由 shell 的子导航承担 */}
        <DialogTitle className="sr-only">设置</DialogTitle>
        {raw !== null && (
          <ModuleBoundary name="设置"><Suspense fallback={<p className="state-block">正在加载设置…</p>}>
          <SettingsShell
            active={raw}
            onSelect={(k) => {
              useWorkspaceStore.getState().put('settings', 'section', { selected: k })
              const next = new URLSearchParams(params)
              next.set(SETTINGS_PARAM, k)
              setParams(next)
            }}
          />
          </Suspense></ModuleBoundary>
        )}
      </DialogContent>
    </Dialog>
  )
}
