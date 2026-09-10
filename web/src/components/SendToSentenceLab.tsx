import { useLocation, useNavigate } from 'react-router-dom'
import { stopTts } from '@/lib/audio'
import { rememberedRoute, useWorkspaceStore } from '@/lib/workspaceStore'

export function SendToSentenceLab({ text }: { text: string }) {
  const location = useLocation()
  const navigate = useNavigate()
  return <button className="btn-ghost-sm" disabled={!text.trim() || text.length > 600} title={text.length > 600 ? '句子实验室最多支持 600 字符，请选择较短句子' : '送入句子实验室，不自动分析'} onClick={() => {
    stopTts()
    const store = useWorkspaceStore.getState()
    store.put('grammar', 'sentence-draft', { text })
    const route = rememberedRoute(location.pathname + location.search)
    if (route) store.put('grammar', 'sentence-source', { route })
    navigate('/grammar?tab=lab')
  }}>句子分析</button>
}
