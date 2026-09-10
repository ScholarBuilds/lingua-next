/* 陪读上下文引用卡（需求 07 v2 FR-13/BR-07，v11.3 FR-311~313）。

   卡里列的就是 AI 会看到的。加引用**不触发回答**——火山的 ChatTextQuery(501)
   语义是"用户说了这句话"，模型收到必答，加一张卡就抢答等于用户还没问 AI 就开讲。
   引用攒着，随下一次提问一起送出；已送出的卡片标灰，不再重复带上。 */

import { IconClose, IconSparkle } from '../../components/icons'
import { useCompanionContext } from './contextStore'

const KIND_LABEL: Record<string, string> = {
  sentence: '句',
  selection: '选区',
  shadow: '跟读',
}

interface ContextRefsProps {
  /** 一键就着这些引用提问；未连接会话时不给按钮 */
  onAsk?: (question: string) => void
}

/** 就着当前引用的一键问法：省掉"我说的是哪句"这一步 */
const QUICK_ASKS = ['这句什么意思', '拆一下这句的语法', '这句怎么读才自然']

export function ContextRefs({ onAsk }: ContextRefsProps) {
  const refs = useCompanionContext((s) => s.refs)
  const removeRef = useCompanionContext((s) => s.removeRef)
  const clear = useCompanionContext((s) => s.clear)

  if (refs.length === 0) return null
  const waiting = refs.filter((r) => r.sent !== true)

  return (
    <div className="cmp-refs">
      <div className="cmp-refs-head">
        <span>正在讨论</span>
        <span className="chip">{refs.length}</span>
        <div style={{ flex: 1 }} />
        <button className="btn-ghost-sm" onClick={clear}>
          全部移除
        </button>
      </div>
      {refs.map((r) => (
        <div key={r.key} className={`cmp-ref k-${r.kind}${r.sent === true ? ' sent' : ''}`}>
          <span className="cmp-ref-src">
            {KIND_LABEL[r.kind] ?? '引用'} · {r.source}
            {r.sent === true ? (
              <em className="cmp-ref-flag">已发给 AI</em>
            ) : (
              <em className="cmp-ref-flag wait">待随提问发出</em>
            )}
          </span>
          <span className="cmp-ref-text" title={r.text}>
            {r.text}
          </span>
          {r.note !== undefined && <span className="cmp-ref-note">{r.note}</span>}
          <button
            className="icon-btn cmp-ref-x"
            title="从上下文中移除"
            onClick={() => removeRef(r.key)}
          >
            <IconClose />
          </button>
        </div>
      ))}
      {onAsk !== undefined && waiting.length > 0 && (
        <div className="cmp-ref-asks">
          <IconSparkle />
          {QUICK_ASKS.map((q) => (
            <button key={q} onClick={() => onAsk(q)}>
              {q}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
