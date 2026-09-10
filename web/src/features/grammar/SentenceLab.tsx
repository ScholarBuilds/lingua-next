/* 句法可视化（FR-405）。

   **默认视图是句内成分着色，不是树图**（FR-405a）：主/谓/宾/状用底色标出、
   从句可折叠成一个色块。纯 CSS + span，零渲染成本，直接服务「看懂长句」这个真实需求。

   依存图是二级入口（FR-405b），用已装的 @xyflow/react + dagre 渲染，零新增前端依赖。
   节点是 React 组件——点节点能查词、跳回原句，这是把树图从「装饰」变成「入口」的关键。 */

import {
  Background,
  Controls,
  Handle,
  Position,
  ReactFlow,
  type Edge,
  type Node,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import dagre from 'dagre'
import { useMemo, useState } from 'react'
import { GrammarVoiceButton } from './GrammarVoice'

import type { ConstituentSpan, DepWord, SentenceAnalysis } from '@/lib/api-grammar'

import { PlayButton } from '../exercise/Widgets'

/* ── 成分着色（默认视图） ── */

function ColoredSentence({
  analysis,
  collapsed,
  onToggleClause,
}: {
  analysis: SentenceAnalysis
  collapsed: Set<number>
  onToggleClause: (head: number) => void
}) {
  // 一个词只能属于一个成分：服务端已按「从句优先」分配好，这里直接建索引
  const roleOf = new Map<number, ConstituentSpan>()
  for (const s of analysis.spans) {
    for (const t of s.tokens) roleOf.set(t, s)
  }

  const out: JSX.Element[] = []
  let i = 0
  while (i < analysis.words.length) {
    const w = analysis.words[i]
    const span = roleOf.get(w.i)
    if (span === undefined) {
      out.push(
        <span key={w.i} className="gl-word plain">
          {w.is_punct ? w.text : ` ${w.text}`}
        </span>,
      )
      i += 1
      continue
    }
    // 同一 span 的连续词合成一块
    const members: DepWord[] = []
    while (i < analysis.words.length && roleOf.get(analysis.words[i].i) === span) {
      members.push(analysis.words[i])
      i += 1
    }
    const isClause = span.role === 'clause'
    const folded = isClause && collapsed.has(span.head)
    out.push(
      <span
        key={`s-${span.head}-${members[0].i}`}
        className={`gl-span role-${span.role}${folded ? ' folded' : ''}`}
        title={span.role_zh}
        onClick={isClause ? () => onToggleClause(span.head) : undefined}
      >
        <span className="gl-role">{span.role_zh}</span>
        {folded ? (
          <span className="gl-folded-text">…{members.length} 个词</span>
        ) : (
          // JSX 数组元素之间不会自动留空白，词与词必须显式插空格，
          // 否则整块渲染成 "wholivesnextdoor"
          members.map((m, k) => (
            <span key={m.i}>
              {k > 0 && ' '}
              <span className="gl-word" title={`${m.text} · ${m.tag_zh} · ${m.dep_zh}`}>
                {m.text}
              </span>
            </span>
          ))
        )}
      </span>,
    )
  }
  return <p className="gl-sentence">{out}</p>
}

/* ── 依存图（二级入口） ── */

const NODE_W = 108
const NODE_H = 46

function WordNode({ data }: { data: { label: string; tag: string; onPick: () => void } }) {
  return (
    <div className="dep-node" onClick={data.onPick}>
      <Handle type="target" position={Position.Top} />
      <b>{data.label}</b>
      <i>{data.tag}</i>
      <Handle type="source" position={Position.Bottom} />
    </div>
  )
}

const NODE_TYPES = { word: WordNode }

function layout(words: DepWord[], arcs: SentenceAnalysis['arcs'], onPick: (w: DepWord) => void) {
  const g = new dagre.graphlib.Graph()
  g.setGraph({ rankdir: 'TB', nodesep: 18, ranksep: 44 })
  g.setDefaultEdgeLabel(() => ({}))
  const shown = words.filter((w) => !w.is_punct)
  for (const w of shown) g.setNode(String(w.i), { width: NODE_W, height: NODE_H })
  const edges = words
    .filter((w) => !w.is_punct && w.head !== w.i)
    .map((w) => ({ from: w.head, to: w.i, label: w.dep_zh }))
  for (const e of edges) {
    if (g.hasNode(String(e.from)) && g.hasNode(String(e.to))) {
      g.setEdge(String(e.from), String(e.to))
    }
  }
  dagre.layout(g)

  const nodes: Node[] = shown.map((w) => {
    const pos = g.node(String(w.i))
    return {
      id: String(w.i),
      type: 'word',
      position: { x: (pos?.x ?? 0) - NODE_W / 2, y: (pos?.y ?? 0) - NODE_H / 2 },
      data: { label: w.text, tag: w.tag_zh, onPick: () => onPick(w) },
    }
  })
  const flowEdges: Edge[] = edges
    .filter((e) => g.hasNode(String(e.from)) && g.hasNode(String(e.to)))
    .map((e) => ({
      id: `${e.from}-${e.to}`,
      source: String(e.from),
      target: String(e.to),
      label: e.label,
      type: 'smoothstep',
      labelBgPadding: [4, 2] as [number, number],
    }))
  void arcs
  return { nodes, edges: flowEdges }
}

function DepGraph({
  analysis,
  onPick,
}: {
  analysis: SentenceAnalysis
  onPick: (w: DepWord) => void
}) {
  const { nodes, edges } = useMemo(
    () => layout(analysis.words, analysis.arcs, onPick),
    [analysis, onPick],
  )
  return (
    <div className="dep-graph">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={NODE_TYPES}
        fitView
        proOptions={{ hideAttribution: true }}
        nodesDraggable={false}
        nodesConnectable={false}
      >
        <Background gap={16} />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  )
}

/* ── 主组件 ── */

export function SentenceLab({
  analysis,
  onWord,
  only,
}: {
  analysis: SentenceAnalysis
  onWord?: (word: string) => void
  /* 只开一个视图。阅读器/视频面板传 'tree'：那两处正下方就是 AI 的成分着色，
     spaCy 再画一遍同样的主谓宾状是重复的（同一个面板上下两块干同一件事）。
     语法页「句子实验室」不传，两个视图都留——那边没有 AI 并排，且它走的是
     /grammar/concepts/deconstruct，返回里还带命中构式与指回讲义概念。 */
  only?: 'color' | 'tree'
}) {
  const [view, setView] = useState<'color' | 'tree'>(only ?? 'color')
  const [collapsed, setCollapsed] = useState<Set<number>>(new Set())
  const [picked, setPicked] = useState<DepWord | null>(null)

  const toggle = (head: number) => {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(head)) next.delete(head)
      else next.add(head)
      return next
    })
  }

  return (
    <div className="sentence-lab">
      <div className="gl-toolbar">
        {only === undefined ? (
          <div className="gl-view-switch">
            <button className={view === 'color' ? 'on' : ''} onClick={() => setView('color')}>
              成分着色
            </button>
            <button className={view === 'tree' ? 'on' : ''} onClick={() => setView('tree')}>
              依存关系图
            </button>
          </div>
        ) : (
          <span className="gl-view-only">依存关系图</span>
        )}
        <PlayButton text={analysis.text} label="朗读整句" />
        <GrammarVoiceButton sentence={analysis.text} analysis={analysis} source="句法实验室" />
      </div>

      {view === 'color' ? (
        <>
          <ColoredSentence analysis={analysis} collapsed={collapsed} onToggleClause={toggle} />
          <div className="gl-legend">
            {Object.entries(analysis.legend).map(([role, zh]) => (
              <span key={role} className={`gl-chip role-${role}`}>
                {zh}
              </span>
            ))}
            <span className="gl-legend-hint">点从句色块可折叠</span>
          </div>
        </>
      ) : (
        <>
          <DepGraph analysis={analysis} onPick={setPicked} />
          {picked !== null && (
            <div className="dep-detail">
              <b>{picked.text}</b>
              <span>{picked.tag_zh}</span>
              <span>{picked.dep_zh}</span>
              <span className="dep-lemma">原形 {picked.lemma}</span>
              <PlayButton text={picked.text} label="读一下" />
              {onWord !== undefined && (
                <button className="btn btn-outline" onClick={() => onWord(picked.text)}>
                  查词
                </button>
              )}
            </div>
          )}
        </>
      )}

      <p className="gl-note">{analysis.note}</p>
    </div>
  )
}
