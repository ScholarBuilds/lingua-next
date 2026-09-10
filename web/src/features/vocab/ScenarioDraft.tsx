/* 场景本草稿预览（需求 01 v2 FR-176、BR-32）：确认前可删词、改名、换封面。
   草稿不在书架列表里，也不进复习队列，放弃即整本删除，库内不留半成品。 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useMemo, useState } from 'react'

import { IconCheck, IconClose, IconSparkle, IconTrash } from '../../components/icons'
import type { DraftItem } from '../../lib/api-deck'
import { apiDeck, apiScenario, deckGradient } from '../../lib/api-deck'
import { playTts } from '../../lib/audio'

interface ScenarioDraftProps {
  wordlistId: number
  onConfirmed: () => void
  onDiscarded: () => void
}

export function ScenarioDraftPane({
  wordlistId,
  onConfirmed,
  onDiscarded,
}: ScenarioDraftProps) {
  const queryClient = useQueryClient()
  const draftQuery = useQuery({
    queryKey: ['scenario-draft', wordlistId],
    queryFn: () => apiScenario.draft(wordlistId),
  })
  const draft = draftQuery.data
  const [name, setName] = useState('')
  const [emoji, setEmoji] = useState('')
  const [removed, setRemoved] = useState<Set<string>>(new Set())

  useEffect(() => {
    if (draft === undefined) return
    setName(draft.name)
    setEmoji(draft.emoji ?? '📘')
  }, [draft])

  const save = useMutation({
    mutationFn: () =>
      apiScenario.editDraft(wordlistId, {
        name: name.trim(),
        emoji: emoji.trim() || '📘',
        ...(removed.size > 0 ? { remove_words: [...removed] } : {}),
      }),
  })

  const confirm = useMutation({
    mutationFn: async () => {
      // 先落编辑再确认：确认接口只翻状态，不承担内容变更
      await apiScenario.editDraft(wordlistId, {
        name: name.trim(),
        emoji: emoji.trim() || '📘',
        ...(removed.size > 0 ? { remove_words: [...removed] } : {}),
      })
      return apiScenario.confirm(wordlistId)
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['decks'] })
      onConfirmed()
    },
  })

  const discard = useMutation({
    mutationFn: () => apiDeck.remove(`custom:${wordlistId}`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['decks'] })
      onDiscarded()
    },
  })

  const grouped = useMemo(() => {
    const map = new Map<string, { label: string; items: DraftItem[] }>()
    for (const item of draft?.items ?? []) {
      const key = item.group_key ?? 'other'
      const bucket = map.get(key)
      if (bucket) bucket.items.push(item)
      else map.set(key, { label: item.group_label ?? '其他', items: [item] })
    }
    return [...map.values()]
  }, [draft])

  const kept = (draft?.total ?? 0) - removed.size

  if (draftQuery.isPending) {
    return (
      <div className="state-block">
        <div className="spinner" />
        <div>加载草稿…</div>
      </div>
    )
  }
  if (draftQuery.isError || draft === undefined) {
    return <div className="state-block">草稿加载失败：{draftQuery.error?.message}</div>
  }

  return (
    <div className="dd">
      <div className="dd-head sd-head" style={{ background: deckGradient(draft.color_seed) }}>
        <input
          className="sd-emoji"
          value={emoji}
          maxLength={2}
          title="点击换 emoji"
          onChange={(e) => setEmoji(e.target.value)}
        />
        <div className="dd-head-main">
          <input className="sd-name" value={name} onChange={(e) => setName(e.target.value)} />
          {draft.description && <div className="dd-head-desc">{draft.description}</div>}
          <div className="dd-head-stats">
            <span className="deck-badge ai">
              <IconSparkle />
              AI 生成
            </span>
            {draft.cefr && <span className="deck-badge">{draft.cefr}</span>}
            {draft.category && <span className="deck-badge">{draft.category}</span>}
            <span className="dd-head-total">
              保留 {kept} 词{removed.size > 0 ? ` · 已移除 ${removed.size}` : ''}
            </span>
          </div>
        </div>
      </div>

      <div className="sd-note">
        草稿尚未进入书架与复习队列。删掉不需要的词后点确认，本才会正式建立。
      </div>

      <div className="dd-body">
        {grouped.map((group) => (
          <section className="dd-section" key={group.label}>
            <div className="dd-section-head">
              {group.label}
              <span className="shelf-group-count">{group.items.length}</span>
            </div>
            <div className="dd-grid">
              {group.items.map((item) => {
                const off = removed.has(item.word)
                return (
                  <div className={`dd-tile sd-tile${off ? ' off' : ''}`} key={item.word}>
                    <div className="dd-tile-head">
                      <b onClick={() => playTts(item.word, 'vocab')} title="点击朗读">
                        {item.word}
                      </b>
                      {item.dict_miss && <span className="dd-chip miss">词典外</span>}
                      <button
                        className="sd-drop"
                        title={off ? '撤销移除' : '移除该词'}
                        onClick={() =>
                          setRemoved((prev) => {
                            const next = new Set(prev)
                            if (next.has(item.word)) next.delete(item.word)
                            else next.add(item.word)
                            return next
                          })
                        }
                      >
                        {off ? <IconCheck /> : <IconTrash />}
                      </button>
                    </div>
                    <div className="dd-tile-trans">{item.translation ?? '—'}</div>
                    {item.example_en && (
                      <div className="dd-tile-eg">
                        {item.example_en}
                        {item.example_zh && <div>{item.example_zh}</div>}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          </section>
        ))}
      </div>

      <div className="sd-foot">
        {(confirm.isError || discard.isError || save.isError) && (
          <div className="form-err">
            {(confirm.error ?? discard.error ?? save.error)?.message}
          </div>
        )}
        <div style={{ flex: 1 }} />
        <button
          className={`btn btn-danger${discard.isPending ? ' loading' : ''}`}
          disabled={discard.isPending || confirm.isPending}
          onClick={() => discard.mutate()}
        >
          <IconClose />
          放弃
        </button>
        <button
          className={`btn btn-primary${confirm.isPending ? ' loading' : ''}`}
          disabled={kept === 0 || confirm.isPending || discard.isPending}
          onClick={() => confirm.mutate()}
        >
          {confirm.isPending && <span className="spinner" />}
          确认入库（{kept} 词）
        </button>
      </div>
    </div>
  )
}
