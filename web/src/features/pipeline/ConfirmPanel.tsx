/* 人工确认面板（需求 12 FR-248）：确认节点上真正能确认的地方。

   之前 confirm 只是个后端状态——run 挂起等人，但界面上没有任何"确认"入口，
   用户看着「人工确认」四个字不知道该点哪。 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'

import { IconCheck, IconTrash } from '../../components/icons'
import { apiScenario } from '../../lib/api-deck'
import { useWordModalStore } from '../reader/wordModalStore'

export function ConfirmPanel({
  domain,
  subjectId,
  onDone,
}: {
  domain: string
  subjectId: number
  onDone: () => void
}) {
  const qc = useQueryClient()
  const openWord = useWordModalStore((s) => s.openWord)
  const [dropped, setDropped] = useState<Set<string>>(new Set())

  const draft = useQuery({
    queryKey: ['scenario-draft', subjectId],
    queryFn: () => apiScenario.draft(subjectId),
    enabled: domain === 'scenario_deck',
  })

  const confirm = useMutation({
    mutationFn: async () => {
      if (dropped.size > 0) {
        await apiScenario.editDraft(subjectId, { remove_words: [...dropped] })
      }
      return apiScenario.confirm(subjectId)
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['decks'] })
      void qc.invalidateQueries({ queryKey: ['domain-subjects'] })
      void qc.invalidateQueries({ queryKey: ['pipeline-todo'] })
      onDone()
    },
  })

  if (domain !== 'scenario_deck') return null
  if (draft.isPending) return <div className="sp-muted">读取待确认内容…</div>
  if (draft.isError || draft.data === undefined) {
    return <div className="sp-muted">读取失败：{draft.error?.message}</div>
  }

  const items = draft.data.items
  const kept = items.length - dropped.size

  return (
    <div className="cp">
      <div className="sp-sec-title">待确认内容</div>
      <div className="cp-note">
        勾掉不想要的词，确认后这个本才进书架与复习队列。不确认它就一直停在这里。
      </div>

      <div className="cp-grid">
        {items.map((it) => {
          const off = dropped.has(it.word)
          return (
            <div key={it.word} className={`cp-word${off ? ' off' : ''}`}>
              <button className="cp-main" onClick={() => openWord(it.word, it.example_en ?? draft.data.name)}>
                <b>{it.word}</b>
                <span>{it.translation}</span>
              </button>
              <button
                className="cp-drop"
                title={off ? '撤销移除' : '不要这个词'}
                onClick={() =>
                  setDropped((prev) => {
                    const next = new Set(prev)
                    if (next.has(it.word)) next.delete(it.word)
                    else next.add(it.word)
                    return next
                  })
                }
              >
                {off ? <IconCheck /> : <IconTrash />}
              </button>
            </div>
          )
        })}
      </div>

      {confirm.isError && <div className="form-err">{confirm.error.message}</div>}

      <div className="cp-foot">
        <span className="sp-muted">
          保留 {kept} 词{dropped.size > 0 ? ` · 已移除 ${dropped.size}` : ''}
        </span>
        <div style={{ flex: 1 }} />
        <button
          className={`btn btn-primary${confirm.isPending ? ' loading' : ''}`}
          disabled={kept === 0 || confirm.isPending}
          onClick={() => confirm.mutate()}
        >
          {confirm.isPending && <span className="spinner" />}
          确认入库（{kept} 词）
        </button>
      </div>
    </div>
  )
}
