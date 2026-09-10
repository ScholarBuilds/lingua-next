import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { apiConfig, type Credential } from '../../lib/api-config'
import { BindingTable } from './BindingTable'
import { AddCredButton, CredCard, CredOverlay } from './credentials'
import { CGroup, ErrorBlock, LoadingCards, SecHead } from './shared'
import { PronunciationSettings } from './PronunciationSettings'

export function VoiceSection() {
  const types = useQuery({ queryKey: ['cfg-provider-types'], queryFn: apiConfig.providerTypes, staleTime: 300_000 })
  const credentials = useQuery({ queryKey: ['cfg-creds', 'tts'], queryFn: () => apiConfig.credentials('tts') })
  const realtime = useQuery({ queryKey: ['cfg-creds', 'realtime'], queryFn: () => apiConfig.credentials('realtime') })
  const [editing, setEditing] = useState<Credential | 'add' | null>(null)
  const ttsTypes = (types.data ?? []).filter((type) => type.kind === 'tts')
  return <>
    <SecHead title="语音服务" desc="朗读供应商、默认音色与端到端对话分别配置。免费 Edge 和 Azure Speech 用于合成朗读，不是端到端对话模型。" />
    <CGroup>朗读供应商</CGroup>
    <p className="tier-lead">浏览音色可拉取目录、筛选语言和逐项试听。添加供应商不会替换已有用途的默认音色。</p>
    {credentials.isPending && <LoadingCards />}
    {credentials.error && <ErrorBlock message={credentials.error.message} onRetry={() => void credentials.refetch()} />}
    <div className="pcard-list">{credentials.data?.map((credential) => <CredCard key={credential.id} cred={credential} unitLabel="音色" refreshLabel="刷新音色" showTest onEdit={() => setEditing(credential)} />)}</div>
    <AddCredButton text="添加朗读供应商" onClick={() => setEditing('add')} />
    <CGroup>用途与默认音色</CGroup>
    <p className="tier-lead">点击音色打开统一选择窗口。测速显示开始播放的等待时间，不读取缓存，不以其他音色替代失败结果。</p>
    <BindingTable groups={['voice']} />
    <CGroup>实时语音对话</CGroup>
    <p className="tier-lead">实时会话使用下面绑定的供应商和会话音色，与上方朗读音色独立。更改配置后重新开始会话。</p>
    {realtime.isPending && <LoadingCards count={1} />}
    {realtime.error && <ErrorBlock message={realtime.error.message} onRetry={() => void realtime.refetch()} />}
    <div className="pcard-list">{realtime.data?.filter((credential) => !credentials.data?.some((item) => item.id === credential.id)).map((credential) =>
      <CredCard key={credential.id} cred={credential} unitLabel="音色" refreshLabel="刷新音色" onEdit={() => setEditing(credential)} />
    )}</div>
    {realtime.data?.length === 0 && <p>请先添加支持端到端对话的火山语音凭据。</p>}
    <BindingTable groups={['realtime']} />
    <PronunciationSettings />
    {editing && <CredOverlay key={editing === 'add' ? 'add' : editing.id} kind={editing === 'add' ? 'tts' : editing.kind} types={editing === 'add' ? ttsTypes : types.data ?? []} existing={editing === 'add' ? undefined : editing} onClose={() => setEditing(null)} />}
  </>
}
