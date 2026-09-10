export interface PronunciationSettings { enabled: boolean; credential_id: number | null }
export interface PronunciationResult {
  text: string
  latency_ms: number
  scores: Record<string, number | null>
  words: { word: string; accuracy: number | null; error: string | null }[]
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init)
  if (!response.ok) {
    const body = await response.json().catch(() => null)
    throw new Error(typeof body?.detail === 'string' ? body.detail : `请求失败 (${response.status})`)
  }
  return response.json()
}

export const pronunciation = {
  settings: () => request<PronunciationSettings>('/api/config/pronunciation'),
  save: (value: PronunciationSettings) => request<PronunciationSettings>('/api/config/pronunciation', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value),
  }),
  assess: async (recording: Blob, text: string, signal?: AbortSignal): Promise<PronunciationResult> => {
    const context = new AudioContext()
    let decoded: AudioBuffer
    try { decoded = await context.decodeAudioData(await recording.arrayBuffer()) }
    finally { await context.close() }
    if (decoded.duration < 0.4 || decoded.duration > 30) throw new Error('请录制 0.4～30 秒的短句')
    const offline = new OfflineAudioContext(1, Math.ceil(decoded.duration * 16000), 16000)
    const source = offline.createBufferSource(); source.buffer = decoded; source.connect(offline.destination); source.start()
    const samples = (await offline.startRendering()).getChannelData(0)
    const bytes = new ArrayBuffer(44 + samples.length * 2), view = new DataView(bytes)
    const tag = (offset: number, text: string) => { for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i)) }
    tag(0, 'RIFF'); view.setUint32(4, bytes.byteLength - 8, true); tag(8, 'WAVE'); tag(12, 'fmt ')
    view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true)
    view.setUint32(24, 16000, true); view.setUint32(28, 32000, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true)
    tag(36, 'data'); view.setUint32(40, samples.length * 2, true)
    samples.forEach((sample, i) => { const value = Math.max(-1, Math.min(1, sample)); view.setInt16(44 + i * 2, Math.round(value * (value < 0 ? 32768 : 32767)), true) })
    const form = new FormData()
    form.append('file', new Blob([bytes], { type: 'audio/wav' }), 'assessment.wav')
    form.append('text', text); form.append('consent', 'true')
    signal?.throwIfAborted()
    return request<PronunciationResult>('/api/talk/pronunciation', { method: 'POST', body: form, signal })
  },
}
