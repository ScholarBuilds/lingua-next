import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useMemo, useRef, useState } from 'react'
import { apiConfig, type Credential } from '../lib/api-config'
import { filterVoices, voiceChoices, type VoiceChoice } from '../lib/voiceCatalog'
import { useStopTtsOnClose } from '../lib/useStopTtsOnClose'
import { VoiceProbeButton } from '../features/settings/VoiceProbeButton'
import { ServiceProbeButton } from '../features/settings/ServiceProbeButton'
import { Picker } from './ui/picker'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from './ui/dialog'
import { RatePicker } from './RatePicker'
import './voicePicker.css'
import { useFullscreenElement } from './FullscreenPortal'
import { request } from '../lib/api'
import { playUrl, ttsUrl } from '../lib/audio'

const PAGE_SIZE = 20
const GENDERS = [['all', '全部声线'], ['Female', '女声'], ['Male', '男声'], ['Other', '其他 / 未标注']] as const

export interface VoicePickerProps {
  title: string
  current?: string | null
  currentCredentialId?: number | null
  sample?: string
  hint?: string
  rate?: number
  credential?: Credential
  mode?: 'tts' | 'realtime'
  allowLocal?: boolean
  onClear?: () => void
  onClose: () => void
  onPick?: (voice: string) => void
  onChoose?: (voice: VoiceChoice, rate: number) => Promise<void> | void
}

export function VoicePicker({ title, current = null, currentCredentialId, sample, hint, rate = 1,
  credential, mode = 'tts', allowLocal = true, onClear, onClose, onPick, onChoose }: VoicePickerProps) {
  useStopTtsOnClose()
  const fullscreen = useFullscreenElement()
  const client = useQueryClient()
  const local = useQuery({ queryKey: ['local-voices'], enabled: mode === 'tts' && allowLocal,
    queryFn: () => request<{ voices: { name: string; label: string; locale: string }[] }>('/api/tts/local-voices'), staleTime: Infinity })
  const query = useQuery({ queryKey: ['cfg-creds', mode], queryFn: () => apiConfig.credentials(mode) })
  const credentials = (query.data ?? (credential ? [credential] : [])).filter((item) => item.enabled || item.id === credential?.id)
  const [providerId, setProviderId] = useState<number | null>(credential?.id ?? currentCredentialId ?? null)
  const provider = credentials.find((item) => item.id === providerId)
    ?? credentials.find((item) => voiceChoices(item, mode === 'realtime').some((voice) => voice.value === current))
    ?? credentials[0]
  const [keyword, setKeyword] = useState('')
  const [gender, setGender] = useState('all')
  const [locale, setLocale] = useState('all')
  const [page, setPage] = useState(0)
  const [speed, setSpeed] = useState(rate)
  const [choice, setChoice] = useState<VoiceChoice | null>(null)
  const [localPlayback, setLocalPlayback] = useState('')
  useEffect(() => {
    const voice = local.data?.voices.find(item => item.name === current)
    if (voice) setChoice({ id: voice.name, name: voice.label, label: voice.label, locale: voice.locale, gender: 'Other', credentialId: 0, provider: 'Mac 本机', value: voice.name, selectable: true })
  }, [local.data, current])
  const list = useRef<HTMLDivElement>(null)
  const search = useRef<HTMLInputElement>(null)
  const returnFocus = useRef<HTMLElement | null>(null)
  const entries = useMemo(() => provider ? voiceChoices(provider, mode === 'realtime') : [], [provider, mode])
  const selected = choice ?? entries.find((voice) =>
    (voice.value === current || voice.id === current) && (!currentCredentialId || voice.credentialId === currentCredentialId),
  ) ?? null
  const filtered = filterVoices(entries, keyword, locale, gender)
  const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))
  const currentPage = Math.min(page, pages - 1)
  const visible = filtered.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE)
  const locales = [...new Set(entries.map((voice) => voice.locale).filter(Boolean))].sort()
  const refresh = useMutation({ mutationFn: () => apiConfig.refreshModels(provider!.id), onSuccess: async () => {
    await client.invalidateQueries({ queryKey: ['cfg-creds'] })
    await client.invalidateQueries({ queryKey: ['tts-voices'] })
    await client.invalidateQueries({ queryKey: ['tts-voices-v2'] })
  } })
  const save = useMutation({ mutationFn: async (voice: VoiceChoice) => {
    if (onChoose) await onChoose(voice, speed)
    else onPick?.(voice.value)
  }, onSuccess: onClose })
  useEffect(() => { if (list.current) list.current.scrollTop = 0 }, [currentPage, keyword, gender, locale, provider?.id])

  return <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
    <DialogContent portalContainer={fullscreen} className="voice-dialog" overlayClassName="voice-dialog-overlay" aria-describedby={undefined}
      onOpenAutoFocus={(event) => {
        event.preventDefault()
        returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
        search.current?.focus()
      }}
      onCloseAutoFocus={(event) => { event.preventDefault(); returnFocus.current?.focus() }}
      onEscapeKeyDown={(event) => event.stopPropagation()}>
    <DialogHeader className="voice-dialog-header"><DialogTitle>{title}</DialogTitle></DialogHeader>
    <p className="voice-dialog-hint">{hint ?? (mode === 'realtime'
      ? '实时会话音色与朗读音色独立。试听不采集麦克风，也不改变现有绑定。'
      : '先试听，再选择。测速显示点击到开始播放的时间；新请求可能按供应商规则计费。')}</p>
    <div className="voice-workspace">
      <nav className="voice-providers" aria-label="音色供应商">
        {credentials.map((item) => <button key={item.id} aria-pressed={item.id === provider?.id}
          onClick={() => { setProviderId(item.id); setPage(0); setChoice(null); setLocale('all'); setGender('all'); refresh.reset() }}>
          <strong>{item.name}</strong><span>{item.models_count} 个音色{item.provider_type === 'minimax_tts' ? ' · 仅试听' : ''}</span>
        </button>)}
      </nav>
      <div className="voice-main">
        <div className="voice-toolbar">
          <input ref={search} aria-label="搜索目录" placeholder="搜索名称或音色 ID" value={keyword}
            onChange={(event) => { setKeyword(event.target.value); setPage(0) }} />
          <Picker aria-label="音色语言" value={locale} onChange={(value) => { setLocale(value); setPage(0) }}
            options={[{ value: 'all', label: '全部语言' }, ...locales.map((value) => ({ value, label: value }))]} />
          {mode === 'tts' && <RatePicker value={speed} onChange={setSpeed} />}
          <button className="btn-ghost-sm" disabled={!provider?.enabled || refresh.isPending} onClick={() => refresh.mutate()}>
            {refresh.isPending ? '拉取中…' : '从供应商刷新'}
          </button>
        </div>
        <div className="voice-genders" role="group" aria-label="声线分类">{GENDERS.map(([key, label]) =>
          <button key={key} aria-pressed={gender === key} onClick={() => { setGender(key); setPage(0) }}>{label}</button>,
        )}</div>
        {provider?.provider_type === 'bailian_tts' && <p className="voice-catalog-note">Qwen3-TTS-Flash-Realtime 官方系统音色目录；百炼不提供系统音色枚举接口。</p>}
        {(query.error || refresh.error) && <p className="voice-catalog-error" role="alert">{(query.error ?? refresh.error)?.message}
          <button className="btn-ghost-sm" onClick={() => void query.refetch()}>重试</button>
        </p>}
        <div className="voice-results" ref={list} aria-label="音色列表">
          {query.isPending && !credential && <p role="status">正在读取音色目录…</p>}
          {GENDERS.slice(1).map(([key, label]) => {
            const group = visible.filter((voice) => voice.gender === key)
            if (!group.length) return null
            return <section key={key}><h3>{label}</h3>{group.map((voice) => <div className="voice-option"
              data-selected={selected?.credentialId === voice.credentialId && selected.id === voice.id} key={`${voice.credentialId}:${voice.id}`}>
              <button className="voice-option-select" disabled={!voice.selectable || (!onPick && !onChoose)}
                aria-pressed={selected?.credentialId === voice.credentialId && selected.id === voice.id} onClick={() => { setChoice(voice); save.reset() }}>
                <strong>{voice.label}</strong><span>{voice.locale || '语言未标注'}</span><code>{voice.id || '由供应商选择'}</code>
              </button>
              {mode === 'tts'
                ? <VoiceProbeButton key={speed} disabled={!provider?.enabled} credentialId={voice.credentialId} voice={voice.id} rate={Math.round((speed - 1) * 100)} sample={sample?.slice(0, 500)} separateActions />
                : <ServiceProbeButton compact disabled={!provider?.enabled} label="试听并测速" run={() => apiConfig.realtimeVoiceProbe(voice.credentialId, voice.id)} />}
            </div>)}</section>
          })}
          {(!query.isPending || credential) && !filtered.length && <p className="voice-empty">{entries.length ? '没有匹配的音色，请调整筛选。' : '目录尚未拉取，请从供应商刷新；若尚未接入，请先到语音服务添加凭据。'}</p>}
        </div>
        <div className="voice-pagination"><span>{filtered.length} 个音色 · {currentPage + 1} / {pages} 页</span><div>
          <button className="btn-ghost-sm" disabled={!currentPage} onClick={() => setPage(currentPage - 1)}>上一页</button>
          <button className="btn-ghost-sm" disabled={currentPage + 1 >= pages} onClick={() => setPage(currentPage + 1)}>下一页</button>
        </div></div>
      </div>
    </div>
    {mode === 'tts' && allowLocal && !!local.data?.voices.length && <details>
      <summary>Mac 本机声音 · 无需联网合成</summary>
      <Picker aria-label="Mac 本机声音" value={choice?.value.startsWith('mac:') ? choice.value : ''}
        options={[{ value: '', label: '选择已安装声音' }, ...local.data.voices.map(voice => ({ value: voice.name, label: `${voice.label} · ${voice.locale}` }))]}
        onChange={value => { const voice = local.data.voices.find(item => item.name === value); if (voice) setChoice({ id: voice.name, name: voice.label, label: voice.label, locale: voice.locale, gender: 'Other', credentialId: 0, provider: 'Mac 本机', value, selectable: true }) }} />
      <button className="btn btn-outline" disabled={!choice?.value.startsWith('mac:')}
        onClick={() => {
          setLocalPlayback('正在合成…')
          const audio = playUrl(ttsUrl(sample || 'Hello, welcome back.', 'word', choice?.value, Math.round((speed - 1) * 100)))
          audio.addEventListener('playing', () => setLocalPlayback('正在播放'), { once: true })
          audio.addEventListener('ended', () => setLocalPlayback('播放完成'), { once: true })
          audio.addEventListener('error', () => setLocalPlayback('播放失败，请重试'), { once: true })
        }}>试听本机声音</button>
      <span role="status">{localPlayback}</span>
    </details>}
    <footer className="voice-footer">
      <div><strong>{selected?.label ?? (onPick || onChoose ? '请选择音色' : '音色试听')}</strong><span>{selected?.provider ?? '试听不会修改当前音色'}</span>
        {save.error && <span role="alert">保存失败：{save.error.message}</span>}
      </div>
      {onClear && <button className="btn" onClick={onClear}>跟随全局设置</button>}
      <button className="btn" onClick={onClose}>返回</button>
      {(onPick || onChoose) && <button className="btn btn-primary" disabled={!selected?.selectable || save.isPending}
        onClick={() => { if (selected) save.mutate(selected) }}>{save.isPending ? '保存中…' : '使用这个音色'}</button>}
    </footer>
    </DialogContent>
  </Dialog>
}
