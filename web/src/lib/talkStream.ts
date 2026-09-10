import type { TalkTurnPair } from './api'

export async function streamTalkTurn(
  sessionId: number,
  input: string | { blob: Blob; filename: string },
  signal: AbortSignal,
  onSentence: (text: string) => void,
  onReset: () => void,
): Promise<TalkTurnPair> {
  const form = new FormData()
  if (typeof input !== 'string') form.append('file', input.blob, input.filename)
  const response = await fetch(`/api/talk/sessions/${sessionId}/turns/${typeof input === 'string' ? 'text' : 'audio'}?stream=true`, {
    method: 'POST', signal,
    headers: typeof input === 'string' ? { 'Content-Type': 'application/json' } : undefined,
    body: typeof input === 'string' ? JSON.stringify({ text: input }) : form,
  })
  if (!response.ok || !response.body) throw new Error(`对话请求失败 (${response.status})`)
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader()
  let buffer = ''
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) throw new Error('对话连接已断开，回复尚未保存')
      buffer += value
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        if (!line.trim()) continue
        const event = JSON.parse(line)
        if (event.type === 'error') throw new Error(event.detail)
        if (event.type === 'sentence' && typeof event.text === 'string') onSentence(event.text)
        if (event.type === 'reset') onReset()
        if (event.type === 'done' && event.user_turn && event.assistant_turn) return event as TalkTurnPair
      }
    }
  } finally {
    await reader.cancel()
    reader.releaseLock()
  }
}
