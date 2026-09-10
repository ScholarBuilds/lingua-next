/* 词库模块共用：标签/状态映射、语境句切分、发音自动播放偏好 */

import { usePrefStore } from '../../lib/prefStore'

const TAG_LABELS: Record<string, string> = {
  zk: '中考',
  gk: '高考',
  cet4: 'CET-4',
  cet6: 'CET-6',
  ky: '考研',
  toefl: '托福',
  ielts: '雅思',
  gre: 'GRE',
}

export function tagLabel(tag: string): string {
  return TAG_LABELS[tag] ?? tag
}

const STATUS_LABELS: Record<string, string> = {
  new: '新词',
  learning: '学习中',
  review: '复习',
  relearning: '重学',
  mastered: '已掌握',
}

export function statusLabel(status: string): string {
  return STATUS_LABELS[status] ?? status
}

/** 状态 chip 配色后缀：''/warn/accent/ok */
export function statusChipClass(status: string): string {
  switch (status) {
    case 'learning':
    case 'relearning':
      return ' warn'
    case 'review':
      return ' accent'
    case 'mastered':
      return ' ok'
    default:
      return ''
  }
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export interface ContextPiece {
  text: string
  hit: boolean
}

/** 语境句按目标词切分，供高亮或挖空渲染；未命中时整句原样返回 */
export function splitContext(text: string, word: string): ContextPiece[] {
  const w = word.trim()
  if (!w) return [{ text, hit: false }]
  const re = new RegExp(`(${escapeRegExp(w)})`, 'ig')
  return text
    .split(re)
    .filter((p) => p !== '')
    .map((p) => ({ text: p, hit: p.toLowerCase() === w.toLowerCase() }))
}

/* 新卡自动发音偏好：经 prefStore 服务端化持久化（旧键 ln-vocab-autoplay 已迁移） */

export function getAutoplay(): boolean {
  return usePrefStore.getState().prefs.vocab.autoplay
}

export function storeAutoplay(v: boolean): void {
  usePrefStore.getState().update({ vocab: { autoplay: v } })
}

/** 生词本在词表列表里的虚拟 key（数据走 GET /vocab，不走 /wordlists） */
/** 速记的「整本 · 不分场景」哨兵：进 URL 的 ?g=，服务端不认它，取词时不带 group */
export const WHOLE_DECK_SCENE = '*'

export const VOCAB_BOOK_KEY = '__vocab__'
export const VOCAB_BOOK_NAME = '生词本'
