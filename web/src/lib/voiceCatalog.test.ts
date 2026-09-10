import { describe, expect, it } from 'vitest'
import type { Credential } from './api-config'
import { filterVoices, voiceChoices } from './voiceCatalog'

const credential: Credential = {
  id: 26, name: 'Azure East Asia', kind: 'tts', provider_type: 'azure_speech', enabled: true,
  status: 'untested', status_detail: null, last_tested_at: null, masked: {}, models_count: 3,
  models_refreshed_at: null, models: [
    { id: 'Jenny', label: 'Jenny', locale: 'en-US', gender: 'female' },
    { id: 'Yunxi', label: '云希', locale: 'zh-CN', gender: '男声' },
    { id: 'Other', label: 'Other', locale: 'en-GB', gender: '' },
  ],
}

describe('voice catalog', () => {
  it('keeps account-scoped values and normalizes voice categories', () => {
    const voices = voiceChoices(credential)
    expect(voices.map((voice) => voice.gender)).toEqual(['Female', 'Male', 'Other'])
    expect(voices[0].value).toBe('azure:26:Jenny')
    expect(voices[0].credentialId).toBe(26)
    expect(voiceChoices({ ...credential, provider_type: 'edge_tts' })[0].value).toBe('edge:Jenny')
  })

  it('combines search, language and gender without changing the catalog', () => {
    const voices = voiceChoices(credential)
    expect(filterVoices(voices, ' JENNY ', 'en-US', 'Female')).toHaveLength(1)
    expect(filterVoices(voices, '', 'en-US', 'Male')).toHaveLength(0)
    expect(filterVoices(voices, '云', 'all', 'all')[0].id).toBe('Yunxi')
    expect(voices).toHaveLength(3)
  })

  it('allows audition-only providers and disabled credentials to be viewed, not selected', () => {
    expect(voiceChoices({ ...credential, provider_type: 'minimax_tts' }).every((voice) => !voice.selectable)).toBe(true)
    expect(voiceChoices({ ...credential, enabled: false }).every((voice) => !voice.selectable)).toBe(true)
  })

  it('uses provider default only for realtime catalogs', () => {
    expect(voiceChoices({ ...credential, models: [] })).toEqual([])
    expect(voiceChoices({ ...credential, models: [] }, true)[0].id).toBe('')
  })
})
