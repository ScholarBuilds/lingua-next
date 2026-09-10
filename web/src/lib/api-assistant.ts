/* 工作台定时例程契约。 */

import { request } from './api'

export interface RoutineRunView {
  text: string
  at: string | null
  payload: Record<string, unknown> | null
}

export interface Routine {
  key: string
  label: string
  kind: 'brief' | 'prompt'
  schedule: string
  schedule_label: string
  detail: string | null
  prompt: string | null
  speak: boolean
  enabled: boolean
  source: string
  last_status: 'ok' | 'failed' | null
  last: RoutineRunView | null
}

export const apiAssistant = {
  runRoutine: (key: string) => request<Routine>(`/api/assistant/routines/${key}/run`, { method: 'POST' }),
}
