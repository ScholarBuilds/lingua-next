import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { apiConfig } from '../../lib/api-config'
import { pronunciation } from '../../lib/pronunciation'
import { CGroup, Sel, Switch } from './shared'

export function PronunciationSettings() {
  const client = useQueryClient()
  const settings = useQuery({ queryKey: ['pronunciation-settings'], queryFn: pronunciation.settings })
  const credentials = useQuery({ queryKey: ['cfg-creds', 'tts'], queryFn: () => apiConfig.credentials('tts') })
  const save = useMutation({ mutationFn: pronunciation.save, onSuccess: (value) => client.setQueryData(['pronunciation-settings'], value) })
  const value = settings.data
  const choices = credentials.data?.filter((c) => c.enabled && c.provider_type === 'azure_speech') ?? []
  return <section aria-label="发音评测设置">
    <CGroup>Azure 发音评测</CGroup>
    <p className="tier-lead">默认关闭。开启后可在对话助手中录制英语短句，确认提交后才发送给 Azure，可能产生评测费用。不上传整场对话，不保存评测录音。</p>
    {value && <div className="bt-voice">
      <span>按需评测</span><Switch on={value.enabled} disabled={save.isPending || !value.credential_id} title="开启 Azure 发音评测" onChange={(enabled) => save.mutate({ ...value, enabled })} />
      <Sel display={choices.find((c) => c.id === value.credential_id)?.name ?? '选择 Azure Speech 凭据'} groups={[{ label: 'Azure Speech', items: choices.map((c) => ({ key: String(c.id), label: c.name, active: c.id === value.credential_id, onSelect: () => save.mutate({ ...value, credential_id: c.id }) })) }]} />
    </div>}
    {choices.length === 0 && <p>先在上方添加 Azure Speech 的 Key 与 Region。</p>}
    {(settings.error || save.error) && <p role="alert">{(settings.error || save.error)?.message}</p>}
  </section>
}
