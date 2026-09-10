/* 场景本推荐条（需求 01 v2 FR-233、FR-234）。

   推荐必须可解释：直接列出命中了哪些词，用户一眼判断这个推荐靠不靠谱。
   后端只在命中≥3 个特征词时才返回，宁可不推也不推错。 */

import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'

import { IconClose, IconSparkle } from '../../components/icons'
import { apiDeck } from '../../lib/api-deck'

interface DeckRecommendProps {
  videoId?: number
  articleId?: number
}

export function DeckRecommend({ videoId, articleId }: DeckRecommendProps) {
  const navigate = useNavigate()
  const [dismissed, setDismissed] = useState(false)

  const query = useQuery({
    queryKey: ['deck-recommend', videoId ?? 0, articleId ?? 0],
    queryFn: () => apiDeck.recommend({ videoId, articleId }),
    enabled: videoId !== undefined || articleId !== undefined,
    staleTime: 10 * 60_000,
    retry: false,
  })

  const top = query.data?.[0]
  if (dismissed || top === undefined) return null

  return (
    <div className="dr-bar">
      <IconSparkle />
      <span className="dr-text">
        这段内容里出现了
        <b>{top.sample.slice(0, 3).join(' / ')}</b>
        等 {top.matched} 个
        <em>
          {top.emoji} {top.name}
        </em>
        场景词
      </span>
      <button className="btn-ghost-sm" onClick={() => navigate('/vocab')}>
        去学这个场景本
      </button>
      <button className="icon-btn" title="不再提示" onClick={() => setDismissed(true)}>
        <IconClose />
      </button>
    </div>
  )
}
