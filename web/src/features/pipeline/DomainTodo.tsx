/* 域内待办条（需求 12 FR-241）：待办常驻，不必回首页才知道有事要处理。

   只显示本域的待办项——跨域的完整清单在首页，这里做的是「别让人漏掉」。 */

import { useQuery } from '@tanstack/react-query'

import { apiPipeline } from '../../lib/api-pipeline'

const TONE: Record<string, string> = { ok: 'ok', warn: 'warn', err: 'err', accent: 'accent' }

export function DomainTodo({
  domain,
  onPick,
}: {
  domain: string
  onPick: (healthKey: string) => void
}) {
  const query = useQuery({ queryKey: ['pipeline-todo'], queryFn: apiPipeline.todo })
  const mine = (query.data?.items ?? []).filter((i) => i.domain === domain)
  if (mine.length === 0) return null

  return (
    <div className="dt-bar">
      <span className="dt-label">待处理</span>
      {mine.map((i) => (
        <button
          key={i.key}
          className="pc-pill"
          // 问题类没有对应的健康档位，点它不改筛选，只做提示
          onClick={() => (i.kind === 'health' ? onPick(i.key) : undefined)}
        >
          <i className={`pc-dot ${TONE[i.tone] ?? ''}`} />
          {i.label} <em>{i.count}</em>
        </button>
      ))}
    </div>
  )
}
