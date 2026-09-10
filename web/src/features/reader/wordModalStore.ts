/* 中央卡片状态（M5 反馈迭代）：点词 / 点词组打开屏幕中央模态卡，
   卡内递归点词压栈（最多 5 层），面包屑回退。
   阅读器右栏英文与视频字幕共用这一套弹层。 */

import { create } from 'zustand'
import type { VocabSource } from '../../lib/api'

interface EntryBase {
  /** AI 语境释义的语境（该词 / 词组所在句 · 段） */
  context: string
  /** 视频场景收藏出处的字幕句 id；文章场景省略 */
  cueId?: number
  source?: VocabSource
}

export interface WordEntry extends EntryBase {
  kind: 'word'
  /** 词典 / 收藏用小写词元 */
  word: string
  /** 展示用原样文本 */
  surface: string
}

export interface PhraseEntry extends EntryBase {
  kind: 'phrase'
  text: string
}

export type ModalEntry = WordEntry | PhraseEntry

/** 面包屑与去重用的展示文本 */
export function entryLabel(entry: ModalEntry): string {
  return entry.kind === 'word' ? entry.surface : entry.text
}

const MAX_DEPTH = 5

interface WordModalState {
  stack: ModalEntry[]
  followListen: boolean
  /** 关闭态开新卡；打开态压栈，超出深度丢最早一层 */
  openWord: (surface: string, context: string, cueId?: number, source?: VocabSource) => void
  openPhrase: (text: string, context: string, cueId?: number) => void
  /** 原地替换当前卡（词库详情页上一个/下一个翻页用，不产生面包屑层） */
  replaceWord: (surface: string, context: string, source?: VocabSource) => void
  /** 面包屑回退到第 index 层（0 起） */
  backTo: (index: number) => void
  close: () => void
}

/** 压栈：卡内重复点当前条目不压栈 */
function push(stack: ModalEntry[], entry: ModalEntry): ModalEntry[] {
  const top = stack[stack.length - 1]
  if (top !== undefined && top.kind === entry.kind && entryLabel(top) === entryLabel(entry)) {
    return stack
  }
  return [...stack, entry].slice(-MAX_DEPTH)
}

export const useWordModalStore = create<WordModalState>((set) => ({
  stack: [],
  followListen: false,
  openWord: (surface, context, cueId, source) =>
    set((s) => ({
      followListen: false,
      stack: push(s.stack, {
        kind: 'word',
        word: surface.toLowerCase(),
        surface,
        context,
        ...(cueId !== undefined ? { cueId } : {}),
        ...(source !== undefined ? { source } : {}),
      }),
    })),
  openPhrase: (text, context, cueId) =>
    set((s) => ({
      followListen: false,
      stack: push(s.stack, {
        kind: 'phrase',
        text,
        context,
        ...(cueId !== undefined ? { cueId } : {}),
      }),
    })),
  replaceWord: (surface, context, source) =>
    set((s) => {
      const entry: ModalEntry = {
        kind: 'word',
        word: surface.toLowerCase(),
        surface,
        context,
        ...(source !== undefined ? { source } : {}),
      }
      // 栈空时等同开卡；否则只换栈顶，保留上层面包屑
      return { stack: s.stack.length === 0 ? [entry] : [...s.stack.slice(0, -1), entry] }
    }),
  backTo: (index) => set((s) => ({ stack: s.stack.slice(0, index + 1) })),
  close: () => set({ stack: [], followListen: false }),
}))
