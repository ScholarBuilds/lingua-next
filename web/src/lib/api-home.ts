/* 「今天」首页聚合（CR-006 D5）：服务端一次算好，页面只渲染 */

import { request } from './api'

export interface ContinueReading {
  article_id: number
  title: string
  /** 书内章节名；独立文章为 null */
  chapter: string | null
  author: string | null
  book_id: number | null
  cover_url: string | null
  progress_pct: number
  state: 'unstarted' | 'reading' | 'finished'
  updated_at: string | null
}

export interface ContinueVideo {
  video_id: number
  title: string
  title_zh: string | null
  channel: string | null
  last_pos_s: number
  duration_s: number | null
  progress_pct: number
  thumb_url: string | null
  updated_at: string | null
}

export interface ContinueTalk {
  session_id: number
  scenario_key: string | null
  title: string
  mode: string
  difficulty: string
  started_at: string | null
  ended_at: string | null
  /** 已结束的会话才有 */
  minutes: number | null
}

export interface RecentItem {
  kind: 'book' | 'article' | 'video'
  id: number
  title: string
  subtitle: string | null
  status: string
  created_at: string | null
  href: string
}

export interface MorningBrief {
  text: string
  payload: Record<string, unknown> | null
  at: string | null
}

export interface HomePayload {
  plan: { day: string; timezone: string; daily_new: number; learned: number; completed_practices: number; resume: PlanItem[] }
  /** 今天的早报（模块 20 例程），07:30 之前或没跑过就是 null */
  brief: MorningBrief | null
  review_due: number
  today_minutes: number
  /** 周一到周日，分钟 */
  week_minutes: number[]
  continue: {
    reading: ContinueReading | null
    video: ContinueVideo | null
    talk: ContinueTalk | null
  }
  recent: RecentItem[]
}

export interface PlanItem {
  key: string
  kind: 'practice' | 'grammar' | 'drill' | 'listen' | 'reading' | 'video' | 'talk' | 'review' | 'learn'
  title: string
  progress: string
  updated_at: string | null
  href: string
  priority: number
  deckKey?: string
  word?: string
  scopeKey?: string
  unavailable?: string
}

export const apiHome = {
  get: () => request<HomePayload>('/api/home'),
}
