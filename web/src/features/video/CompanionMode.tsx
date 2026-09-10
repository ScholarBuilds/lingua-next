/* 视频页 AI 陪读（需求 07 v2 FR-15/16/17）。

   右栏第九个模式，不跳转 /talk、不带看板娘。语音与文字走同一条 realtime 会话。
   v11.2 起面板本体收敛到 features/companion/VoiceCompanion，与文章页、场景短文页同款。 */

import { VoiceCompanion } from '../companion/VoiceCompanion'

const FOLLOWUPS = [
  '再简单点讲一遍',
  '举个例子',
  '这个词还有别的意思吗',
  '这句语法是什么结构',
  '日常口语里会怎么说',
]

const OPENERS = ['这句什么意思', '带我复述这一句', '这段在讲什么']

interface CompanionModeProps {
  videoId: number
  /** 当前学习句序号：字幕过长时截断窗口据此定位 */
  unitOrdinal: number
  title: string
}

export function CompanionMode({ videoId, unitOrdinal, title }: CompanionModeProps) {
  return (
    <VoiceCompanion
      source={{ videoId, unitOrdinal }}
      title={title}
      hint="字幕行的 ✨ 把某句交给 AI；拖选字幕可问任意片段"
      followups={FOLLOWUPS}
      openers={OPENERS}
      showQuiz
    />
  )
}
