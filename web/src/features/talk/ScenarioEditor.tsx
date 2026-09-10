import { useMutation, useQueryClient } from '@tanstack/react-query'

import { Overlay } from '../../components/Overlay'
import { useState } from 'react'
import type { FormEvent } from 'react'

import { IconClose, IconSparkle } from '../../components/icons'
import { Picker } from '@/components/ui/picker'
import { api } from '../../lib/api'
import type { KeySentence, TalkScenario, TalkScenarioData } from '../../lib/api'

const LEVELS = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2']
const KEY_SENTENCE_SLOTS = 3
const HINT_SLOTS = 2

interface FormState {
  key: string
  title: string
  title_en: string
  level: string
  role_ai: string
  role_user: string
  goal: string
  opening_line: string
  key_sentences: KeySentence[]
  hints: string[]
}

function padSentences(list: KeySentence[]): KeySentence[] {
  const out = list.slice(0, Math.max(KEY_SENTENCE_SLOTS, list.length))
  while (out.length < KEY_SENTENCE_SLOTS) out.push({ en: '', zh: '' })
  return out
}

function padHints(list: string[]): string[] {
  const out = list.slice(0, Math.max(HINT_SLOTS, list.length))
  while (out.length < HINT_SLOTS) out.push('')
  return out
}

function emptyForm(): FormState {
  return {
    key: '',
    title: '',
    title_en: '',
    level: 'B1',
    role_ai: '',
    role_user: '',
    goal: '',
    opening_line: '',
    key_sentences: padSentences([]),
    hints: padHints([]),
  }
}

function fromScenario(s: TalkScenarioData): FormState {
  return {
    key: s.key,
    title: s.title,
    title_en: s.title_en,
    level: LEVELS.includes(s.level) ? s.level : 'B1',
    role_ai: s.role_ai,
    role_user: s.role_user,
    goal: s.goal,
    opening_line: s.opening_line,
    key_sentences: padSentences(s.key_sentences ?? []),
    hints: padHints(s.hints ?? []),
  }
}

/** 新建场景无 key 时按英文标题生成，兜底时间戳 */
function makeKey(titleEn: string): string {
  const slug = titleEn
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
  return slug !== '' ? `custom_${slug}` : `custom_${Date.now().toString(36)}`
}

interface ScenarioEditorProps {
  /** null 为新建，否则编辑该用户场景（走 PUT） */
  initial: TalkScenario | null
  onClose: () => void
}

export function ScenarioEditor({ initial, onClose }: ScenarioEditorProps) {
  const queryClient = useQueryClient()
  const editing = initial !== null
  const [form, setForm] = useState<FormState>(() =>
    initial ? fromScenario(initial) : emptyForm(),
  )
  const [idea, setIdea] = useState('')
  const [invalid, setInvalid] = useState<string | null>(null)

  const set = <K extends keyof FormState>(field: K, value: FormState[K]) =>
    setForm((f) => ({ ...f, [field]: value }))

  const setSentence = (i: number, part: keyof KeySentence, value: string) =>
    setForm((f) => ({
      ...f,
      key_sentences: f.key_sentences.map((s, j) => (j === i ? { ...s, [part]: value } : s)),
    }))

  const setHint = (i: number, value: string) =>
    setForm((f) => ({ ...f, hints: f.hints.map((h, j) => (j === i ? value : h)) }))

  const draftMutation = useMutation({
    mutationFn: () => api.draftTalkScenario({ idea: idea.trim(), level: form.level }),
    onSuccess: (draft) => {
      // 编辑模式下保留原 key，避免 AI 草稿改动既有场景标识
      setForm((f) => ({ ...fromScenario(draft), key: editing ? f.key : (draft.key ?? '') }))
      setInvalid(null)
    },
  })

  const saveMutation = useMutation({
    mutationFn: (data: TalkScenarioData) =>
      editing ? api.updateTalkScenario(initial.key, data) : api.createTalkScenario(data),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['talk-scenarios'] })
      onClose()
    },
  })

  const submit = (e: FormEvent) => {
    e.preventDefault()
    setInvalid(null)
    const required: Array<[string, string]> = [
      [form.title, '中文标题'],
      [form.title_en, '英文标题'],
      [form.role_ai, 'AI 扮演角色'],
      [form.role_user, '你扮演的角色'],
      [form.goal, '场景目标'],
      [form.opening_line, '开场白'],
    ]
    const missing = required.find(([v]) => v.trim() === '')
    if (missing) {
      setInvalid(`请填写「${missing[1]}」`)
      return
    }
    const sentences = form.key_sentences
      .map((s) => ({ en: s.en.trim(), zh: s.zh.trim() }))
      .filter((s) => s.en !== '')
    if (sentences.length === 0) {
      setInvalid('至少填写一条关键句（英文）')
      return
    }
    const hints = form.hints.map((h) => h.trim()).filter((h) => h !== '')
    if (hints.length === 0) {
      setInvalid('至少填写一条提示')
      return
    }
    const data: TalkScenarioData = {
      key: editing ? initial.key : form.key.trim() !== '' ? form.key.trim() : makeKey(form.title_en),
      title: form.title.trim(),
      title_en: form.title_en.trim(),
      level: form.level,
      role_ai: form.role_ai.trim(),
      role_user: form.role_user.trim(),
      goal: form.goal.trim(),
      opening_line: form.opening_line.trim(),
      key_sentences: sentences,
      hints,
    }
    saveMutation.mutate(data)
  }

  return (
    <Overlay onClose={onClose} card="wide">
        <div className="overlay-head">
          <div className="overlay-title">{editing ? `编辑场景 · ${initial.title}` : '新建场景'}</div>
          <button className="icon-btn" title="关闭 (Esc)" onClick={onClose}>
            <IconClose />
          </button>
        </div>

        <div className="sce-ai">
          <input
            className="field-input"
            type="text"
            placeholder="一句话描述你想练的场景，如：去咖啡店点单并要求换燕麦奶"
            value={idea}
            disabled={draftMutation.isPending}
            onChange={(e) => setIdea(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && idea.trim() !== '' && !draftMutation.isPending) {
                e.preventDefault()
                draftMutation.mutate()
              }
            }}
          />
          <button
            type="button"
            className={`btn btn-primary${draftMutation.isPending ? ' loading' : ''}`}
            disabled={idea.trim() === '' || draftMutation.isPending}
            onClick={() => draftMutation.mutate()}
          >
            {draftMutation.isPending ? <span className="spinner" /> : <IconSparkle />}
            {draftMutation.isPending ? '生成中…' : 'AI 生成'}
          </button>
        </div>
        {draftMutation.isError && (
          <div className="form-err">生成失败：{draftMutation.error.message}</div>
        )}

        <form className="sce-form" onSubmit={submit}>
          <div className="form-row">
            <div className="field">
              <label htmlFor="sce-title">中文标题</label>
              <input
                id="sce-title"
                className="field-input"
                value={form.title}
                onChange={(e) => set('title', e.target.value)}
                placeholder="咖啡店点单"
              />
            </div>
            <div className="field">
              <label htmlFor="sce-title-en">英文标题</label>
              <input
                id="sce-title-en"
                className="field-input"
                value={form.title_en}
                onChange={(e) => set('title_en', e.target.value)}
                placeholder="Ordering Coffee"
              />
            </div>
          </div>

          <div className="form-row">
            <div className="field">
              <label htmlFor="sce-level">难度等级</label>
              <Picker
                size="sm"
                className="field-select"
                value={form.level}
                onChange={(v) => set('level', v)}
                options={LEVELS.map((l) => ({ value: l, label: l }))}
              />
            </div>
            <div className="field">
              <label htmlFor="sce-role-ai">AI 扮演</label>
              <input
                id="sce-role-ai"
                className="field-input"
                value={form.role_ai}
                onChange={(e) => set('role_ai', e.target.value)}
                placeholder="咖啡店店员"
              />
            </div>
          </div>

          <div className="form-row">
            <div className="field">
              <label htmlFor="sce-role-user">你扮演</label>
              <input
                id="sce-role-user"
                className="field-input"
                value={form.role_user}
                onChange={(e) => set('role_user', e.target.value)}
                placeholder="点单的顾客"
              />
            </div>
            <div className="field">
              <label htmlFor="sce-opening">开场白（AI 第一句）</label>
              <input
                id="sce-opening"
                className="field-input"
                value={form.opening_line}
                onChange={(e) => set('opening_line', e.target.value)}
                placeholder="Hi there! What can I get for you today?"
              />
            </div>
          </div>

          <div className="field">
            <label htmlFor="sce-goal">场景目标</label>
            <textarea
              id="sce-goal"
              className="field-textarea"
              style={{ minHeight: 64 }}
              value={form.goal}
              onChange={(e) => set('goal', e.target.value)}
              placeholder="完成点单：选择饮品和规格、换燕麦奶、堂食或外带、付款"
            />
          </div>

          <div className="field">
            <label>关键句（英文 + 中文对照）</label>
            {form.key_sentences.map((s, i) => (
              <div className="ks-row" key={i}>
                <input
                  className="field-input"
                  value={s.en}
                  onChange={(e) => setSentence(i, 'en', e.target.value)}
                  placeholder={`Key sentence ${i + 1}`}
                />
                <input
                  className="field-input"
                  value={s.zh}
                  onChange={(e) => setSentence(i, 'zh', e.target.value)}
                  placeholder="中文释义"
                />
              </div>
            ))}
          </div>

          <div className="field">
            <label>提示（练习时展示的攻略）</label>
            {form.hints.map((h, i) => (
              <input
                key={i}
                className="field-input"
                value={h}
                onChange={(e) => setHint(i, e.target.value)}
                placeholder={`提示 ${i + 1}`}
              />
            ))}
          </div>

          {invalid && <div className="form-err">{invalid}</div>}
          {saveMutation.isError && (
            <div className="form-err">保存失败：{saveMutation.error.message}</div>
          )}

          <div className="overlay-foot">
            <button type="button" className="btn" onClick={onClose}>
              取消
            </button>
            <button
              type="submit"
              className={`btn btn-primary${saveMutation.isPending ? ' loading' : ''}`}
              disabled={saveMutation.isPending}
            >
              {saveMutation.isPending && <span className="spinner" />}
              {saveMutation.isPending ? '保存中…' : editing ? '保存修改' : '创建场景'}
            </button>
          </div>
        </form>
      </Overlay>
  )
}
