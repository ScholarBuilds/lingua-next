import type { ReactNode } from 'react'
import { FolderOpen, Image, LayoutDashboard, TextCursorInput, Workflow } from '@/components/NexusIcon'
import { useNavigate } from 'react-router-dom'

import './asset-manager-tabs.css'

type Tab = 'assets' | 'workflows' | 'prompts' | 'canvas' | 'local'

export function AssetManagerTabs({
  active,
  onAssets,
  onCanvas,
  onLocal,
}: {
  active: Tab
  onAssets?: () => void
  onCanvas?: () => void
  onLocal?: () => void
}) {
  const navigate = useNavigate()
  const tabs: Array<{ key: Tab; label: string; icon: ReactNode; run: () => void }> = [
    { key: 'assets', label: '图片资产', icon: <Image />, run: onAssets ?? (() => navigate('/studio/assets')) },
    { key: 'workflows', label: '工作流管理', icon: <Workflow />, run: () => navigate('/studio/workflows') },
    { key: 'prompts', label: '提示词库', icon: <TextCursorInput />, run: () => navigate('/studio/prompts') },
    { key: 'canvas', label: '画布资产', icon: <LayoutDashboard />, run: onCanvas ?? (() => navigate('/studio/assets')) },
    { key: 'local', label: '本地素材', icon: <FolderOpen />, run: onLocal ?? (() => navigate('/studio/assets')) },
  ]
  return (
    <nav className="amt-tabs" aria-label="素材管理分类">
      {tabs.map((tab) => (
        <button key={tab.key} className={active === tab.key ? 'amt-tab is-active' : 'amt-tab'} onClick={tab.run}>
          {tab.icon}<span>{tab.label}</span>
        </button>
      ))}
    </nav>
  )
}
