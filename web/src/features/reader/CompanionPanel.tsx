/* 文章页 AI 陪读：语音优先（FR-282~288）。

   v11.2 起与视频页、场景短文页共用 features/companion/VoiceCompanion：
   去掉输入框与 SSE 文字问答的第二条链路，全程走同一条 realtime 会话。 */

import type { Article } from '../../lib/api'
import { VoiceCompanion } from '../companion/VoiceCompanion'

const FOLLOWUPS = [
  '再简单点讲一遍',
  '举个例子',
  '这个词还有别的意思吗',
  '这句语法是什么结构',
  '这段和前文什么关系',
]

const OPENERS = ['这一章讲了什么', '挑几个重点词讲讲', '带我读一遍这段']

interface CompanionPanelProps {
  article: Article
}

export function CompanionPanel({ article }: CompanionPanelProps) {
  return (
    <VoiceCompanion
      source={{ articleId: article.id }}
      title={article.title}
      hint="句面板的 ✨ 把某句交给 AI；拖选正文可问任意片段"
      followups={FOLLOWUPS}
      openers={OPENERS}
    />
  )
}
