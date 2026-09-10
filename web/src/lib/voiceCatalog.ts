import { ttsVoicesOf, type Credential, type TtsVoiceModel } from './api-config'

const PREFIX: Record<string, string> = {
  volc_speech: 'volc', edge_tts: 'edge', azure_speech: 'azure',
  bailian_tts: 'bailian', cartesia_tts: 'cartesia', minimax_tts: 'minimax',
}
export interface VoiceChoice extends TtsVoiceModel {
  credentialId: number
  provider: string
  value: string
  selectable: boolean
}

export function voiceChoices(credential: Credential, realtime = false): VoiceChoice[] {
  const prefix = PREFIX[credential.provider_type] ?? credential.provider_type
  const items = ttsVoicesOf(credential)
  const voices = realtime && !items.length
    ? [{ id: '', name: '', label: '默认音色', locale: '', gender: '' }]
    : items
  return voices.map((voice) => ({
    ...voice,
    credentialId: credential.id,
    provider: credential.name,
    gender: /^female$|^女声?$/.test(voice.gender.toLowerCase()) ? 'Female'
      : /^male$|^男声?$/.test(voice.gender.toLowerCase()) ? 'Male' : 'Other',
    value: ['volc', 'edge'].includes(prefix) ? `${prefix}:${voice.id}` : `${prefix}:${credential.id}:${voice.id}`,
    selectable: credential.enabled && credential.provider_type !== 'minimax_tts',
  }))
}

export function filterVoices(voices: VoiceChoice[], keyword: string, locale: string, gender: string) {
  const query = keyword.trim().toLowerCase()
  return voices.filter((voice) => (locale === 'all' || voice.locale === locale)
    && (gender === 'all' || voice.gender === gender)
    && `${voice.label} ${voice.id} ${voice.locale} ${voice.provider}`.toLowerCase().includes(query))
}
