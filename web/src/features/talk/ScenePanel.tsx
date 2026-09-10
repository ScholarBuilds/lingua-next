import { useEffect, useState } from 'react'

import { IconLocate, IconSparkle, IconSpeaker, IconTask } from '../../components/icons'
import { replaySentence as playTts } from './talkReplayStore'
import type { TalkScenario } from '../../lib/api'
import { TalkCoachPanel } from './TalkCoachPanel'
import { TalkWordText } from './TalkWordText'
import { WordModal } from '../reader/WordModal'
import { useWordModalStore } from '../reader/wordModalStore'
import './scenePanel.css'
import { useWorkspaceStore } from '@/lib/workspaceStore'

const NO_GOALS: string[] = []

/** 会话页右侧场景面板：目标 / 关键句（可朗读）/ 提示；自由话题给通用引导 */
export function ScenePanel({
  scenario,
  sessionId,
  assistantText,
  onUseReply,
  onPracticeChange,
  turnId,
  realtime,
  suspendPractice,
}: {
  scenario: TalkScenario | null
  sessionId?: number | string | null
  assistantText?: string | null
  onUseReply?: (text: string) => void
  onPracticeChange?: (active: boolean) => void
  turnId?: number | null
  realtime?: boolean
  suspendPractice?: boolean
}) {
  const [expanded, setExpanded] = useState(false)
  const goalKey = `goals:${sessionId ?? 'preview'}`
  const confirmed = useWorkspaceStore(s => s.records[`talk:${goalKey}`]?.expanded ?? NO_GOALS)
  const goals = scenario?.goal.split(/[；;。]/).map(text => text.trim()).filter(Boolean) ?? []
  useEffect(() => () => useWordModalStore.getState().close(), [])
  const wordText = (text: string) => <TalkWordText text={text} />
  return (
    <>
    <div className={`scene-shell${realtime ? ' scene-realtime' : ''}${expanded ? ' expanded' : ''}`}>
    <button className="btn scene-toggle" aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}>{expanded ? '收起辅助' : '对话辅助'}</button>
    <aside className="scene">
      <TalkCoachPanel
        key={String(sessionId)}
        sessionId={sessionId ?? null}
        assistantText={assistantText ?? null}
        onUseReply={onUseReply}
        onPracticeChange={onPracticeChange}
        turnId={turnId}
        realtime={realtime}
        suspendPractice={suspendPractice}
      />
      <details className="scene-practice">
        <summary>卡壳时怎么说</summary>
        {[
          { en: 'Could you say that more slowly?', zh: '可以说慢一点吗？' },
          { en: 'What does that mean?', zh: '那是什么意思？' },
          { en: 'Let me think for a moment.', zh: '让我想一下。' },
          { en: 'How do you say this in English?', zh: '这个用英语怎么说？' },
        ].map((phrase) => <div className="scene-rescue" key={phrase.en}>
          <p>{wordText(phrase.en)}<small>{phrase.zh}</small></p>
          <button className="icon-btn" title={`朗读：${phrase.en}`} onClick={() => playTts(phrase.en)}><IconSpeaker /></button>
          {onUseReply && <button onClick={() => onUseReply(phrase.en)}>填入</button>}
        </div>)}
      </details>
      <details className="scene-practice"><summary>场景与提示</summary>
      {!scenario ? (
        <>
        <div className="sec-title">
          <IconTask />
          自由话题
        </div>
        <div className="card task-card">
          <div className="scene-goal">
            没有预设剧本，想聊什么直接开口。可以从今天的生活、兴趣爱好或最近的新闻切入。
          </div>
        </div>
        <div className="sec-title">
          <IconSparkle />
          提示
        </div>
        <ul className="hint-list">
          <li>{wordText('卡壳时可以请对方换个说法：Could you say that differently?')}</li>
          <li>大胆表达，语法问题会在回合反馈里指出</li>
        </ul>
        <div className="scene-foot">
          <IconSparkle />
          转写逐轮保存，结束后可生成纠错总结
        </div>
        </>
      ) : (
        <>
      <div className="sec-title">
        <IconTask />
        场景目标
      </div>
      <div className="card task-card">
        <div className="scene-goal">
          <p>由你确认完成，不按对话次数自动判定。</p>
          {goals.map(goal => <label className="scene-goal-check" key={goal}>
            <input type="checkbox" disabled={!sessionId} checked={confirmed.includes(goal)} onChange={e => {
              useWorkspaceStore.getState().put('talk', goalKey, { expanded: e.target.checked ? [...confirmed, goal] : confirmed.filter(value => value !== goal) })
            }} />{wordText(goal)}
          </label>)}
        </div>
        <div className="scene-roles">
          <span>
            AI 扮演 <b>{wordText(scenario.role_ai)}</b>
          </span>
          <span>
            你扮演 <b>{wordText(scenario.role_user)}</b>
          </span>
        </div>
      </div>

      <div className="sec-title">
        <IconLocate />
        关键句
      </div>
      <div className="key-list">
        {scenario.key_sentences.map((s) => (
          <div className="key" key={s.en}>
            <div className="key-text">
              <div className="key-en">{wordText(s.en)}</div>
              <div className="key-zh">{wordText(s.zh)}</div>
            </div>
            <button className="icon-btn" title="朗读" onClick={() => playTts(s.en)}>
              <IconSpeaker />
            </button>
          </div>
        ))}
      </div>

      {scenario.hints.length > 0 && (
        <>
          <div className="sec-title">
            <IconSparkle />
            提示
          </div>
          <ul className="hint-list">
            {scenario.hints.map((h) => (
              <li key={h}>{wordText(h)}</li>
            ))}
          </ul>
        </>
      )}

      <div className="scene-foot">
        <IconSparkle />
        转写逐轮保存，结束后可生成纠错总结
      </div>
        </>
      )}
      </details>
    </aside>
    </div>
    <WordModal />
    </>
  )
}
