import { useState } from 'react'
import { Cloud, Monitor } from '@/components/NexusIcon'

import ModelEnhancePage from './EnhancePage'
import LocalEnhancePage from './LocalEnhancePage'
import './local-enhance.css'

export default function EnhanceWorkbenchPage(): JSX.Element {
  const [mode, setMode] = useState<'local' | 'model'>('local')
  return (
    <div className="enh-shell">
      <nav className="enh-mode" aria-label="增强引擎">
        <button className={mode === 'local' ? 'active' : ''} onClick={() => setMode('local')}><Monitor />本机工作流</button>
        <button className={mode === 'model' ? 'active' : ''} onClick={() => setMode('model')}><Cloud />通用 AI 重绘</button>
      </nav>
      {mode === 'local' ? <LocalEnhancePage /> : <ModelEnhancePage />}
    </div>
  )
}
