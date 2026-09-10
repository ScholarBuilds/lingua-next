/* 写作纠错（FR-403）。

   两段式：LLM 出修正句 → ERRANT 切成原子编辑 → 每条单独讲解。
   一步式的实测覆盖率只有 40.6%（NAACL 2024），所以这里**没有**「把整段丢给 AI 写评语」
   的入口——每条讲解都对应一条原子编辑，这是可核对的。

   打字时的即时红线走 Harper（WASM，浏览器端跑，服务器零成本）。
   它必须懒加载：wasm 原始 16MB / brotli 后 6.7MB，绝不能进主 bundle（FR-403c）。 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import { GrammarVoiceButton } from './GrammarVoice'

import type { WritingAttempt, WritingEditItem } from '@/lib/api-grammar'
import { grammarApi } from '@/lib/api-grammar'
import { useWorkspaceText, useWorkspaceStore } from '@/lib/workspaceStore'
import { useUrlValue } from '@/lib/urlState'

/** ERRANT 操作码 → 中文。R=替换 M=缺失 U=多余 */
const OP_ZH: Record<string, string> = { R: '改', M: '缺', U: '多' }
const NO_DECISIONS: string[] = []
const CAT_ZH: Record<string, string> = {
  ADJ: '形容词',
  'ADJ:FORM': '形容词形式',
  ADV: '副词',
  CONJ: '连词',
  CONTR: '缩写',
  DET: '限定词',
  MORPH: '词形',
  NOUN: '名词',
  'NOUN:INFL': '名词屈折',
  'NOUN:NUM': '名词单复数',
  'NOUN:POSS': '名词所有格',
  ORTH: '大小写/拼写形式',
  OTHER: '其他',
  PART: '小品词',
  PREP: '介词',
  PRON: '代词',
  PUNCT: '标点',
  SPELL: '拼写',
  VERB: '动词',
  'VERB:FORM': '动词形式',
  'VERB:INFL': '动词屈折',
  'VERB:SVA': '主谓一致',
  'VERB:TENSE': '时态',
  WO: '语序',
}

function typeLabel(t: string): string {
  const [op, ...rest] = t.split(':')
  const cat = rest.join(':')
  return `${OP_ZH[op] ?? op}·${CAT_ZH[cat] ?? cat}`
}

/** 原句按编辑区间划线：ERRANT 给的是 UTF-16 偏移，直接 slice */
function MarkedOriginal({
  text,
  edits,
  active,
  onPick,
}: {
  text: string
  edits: WritingEditItem[]
  active: number | null
  onPick: (id: number | null) => void
}) {
  const spans = edits
    .filter((e) => e.char_start !== null && e.char_end !== null)
    .sort((a, b) => (a.char_start ?? 0) - (b.char_start ?? 0))
  const out: JSX.Element[] = []
  let cursor = 0
  for (const e of spans) {
    const s = e.char_start ?? 0
    const t = e.char_end ?? 0
    if (s < cursor) continue
    if (s > cursor) out.push(<span key={`p${cursor}`}>{text.slice(cursor, s)}</span>)
    out.push(
      <mark
        key={`e${e.id}`}
        className={`we-mark${active === e.id ? ' on' : ''}${s === t ? ' insert' : ''}`}
        onClick={() => onPick(active === e.id ? null : e.id)}
        title={typeLabel(e.errant_type)}
      >
        {s === t ? '​' : text.slice(s, t)}
      </mark>,
    )
    cursor = Math.max(cursor, t)
  }
  if (cursor < text.length) out.push(<span key="tail">{text.slice(cursor)}</span>)
  return <p className="we-original">{out}</p>
}

/* ── Harper 即时红线（懒加载） ── */

interface HarperLint {
  start: number
  end: number
  message: string
}

function useHarper(text: string, enabled: boolean) {
  const [lints, setLints] = useState<HarperLint[]>([])
  const [state, setState] = useState<'idle' | 'loading' | 'ready' | 'unavailable'>('idle')
  const linterRef = useRef<unknown>(null)

  useEffect(() => {
    if (!enabled || state !== 'idle') return
    setState('loading')
    // 动态 import 是硬要求（FR-403c、AC-104）：Harper 的 wasm 原始 16MB、
    // brotli 后 6.7MB，静态 import 会把它焊进主 bundle。
    // 用 `harper.js/binary` 而不是 `binaryInlined`：前者让 Vite 把 wasm 单独出成资产按需拉，
    // 后者是 data URL，等于把 16MB 塞回 JS 里
    void (async () => {
      try {
        const [{ LocalLinter }, { binary }] = await Promise.all([
          import('harper.js'),
          import('harper.js/binary'),
        ])
        const linter = new LocalLinter({ binary })
        await linter.setup()
        linterRef.current = linter
        setState('ready')
      } catch {
        setState('unavailable')
      }
    })()
  }, [enabled, state])

  useEffect(() => {
    if (state !== 'ready' || text.trim() === '') {
      setLints([])
      return
    }
    let alive = true
    const timer = setTimeout(() => {
      const linter = linterRef.current as {
        lint: (t: string) => Promise<{ span: () => { start: number; end: number }; message: () => string }[]>
      } | null
      if (linter === null) return
      void linter
        .lint(text)
        .then((raw) => {
          if (!alive) return
          setLints(
            raw.slice(0, 40).map((l) => {
              const sp = l.span()
              return { start: sp.start, end: sp.end, message: l.message() }
            }),
          )
        })
        .catch(() => setLints([]))
    }, 400)
    return () => {
      alive = false
      clearTimeout(timer)
    }
  }, [text, state])

  return { lints, state }
}

/* ── 主组件 ── */

export function WritingPane() {
  const qc = useQueryClient()
  const [text, setText] = useWorkspaceText('grammar', 'writing-draft')
  const [attemptId, setAttemptId] = useUrlValue<string>('writing', '')
  const [active, setActive] = useState<number | null>(null)
  const [current, setCurrent] = useState<WritingAttempt | null>(null)
  const [liveCheck, setLiveCheck] = useState(true)

  const { lints, state: harperState } = useHarper(text, liveCheck)
  const history = useQuery({ queryKey: ['gr-writing'], queryFn: () => grammarApi.writingHistory(10) })

  const submit = useMutation({
    mutationFn: () => grammarApi.submitWriting(text.trim()),
    onSuccess: (a) => {
      setCurrent(a)
      setAttemptId(String(a.id))
      setActive(null)
      void qc.invalidateQueries({ queryKey: ['gr-writing'] })
      void qc.invalidateQueries({ queryKey: ['gr-errors'] })
    },
  })

  const shown = current ?? history.data?.items.find(a => String(a.id) === attemptId) ?? null
  const decisions = useWorkspaceStore(s => s.records[`grammar:writing-edits:${shown?.id ?? 'none'}`]?.expanded ?? NO_DECISIONS)
  const decide = (id: number, accepted: boolean) => {
    if (!shown) return
    const next = decisions.filter(value => value.split(':')[0] !== String(id))
    useWorkspaceStore.getState().put('grammar', `writing-edits:${shown.id}`, { expanded: [...next, `${id}:${accepted ? 'accept' : 'ignore'}`] })
  }
  let revised = shown?.original ?? ''
  let boundary = revised.length
  for (const edit of [...(shown?.edits ?? [])].sort((a, b) => (b.char_start ?? -1) - (a.char_start ?? -1))) {
    if (!decisions.includes(`${edit.id}:accept`) || edit.char_start === null || edit.char_end === null || edit.char_end > boundary) continue
    revised = revised.slice(0, edit.char_start) + edit.c_str + revised.slice(edit.char_end)
    boundary = edit.char_start
  }

  return (
    <div className="writing-pane">
      <section className="we-input">
        <div className="we-input-head">
          <h2>写一段英文，我按条给你讲</h2>
          <label className="we-live">
            <input
              type="checkbox"
              checked={liveCheck}
              onChange={(e) => setLiveCheck(e.target.checked)}
            />
            打字时即时检查
            <span className="we-live-state">
              {harperState === 'loading' && '（Harper 加载中）'}
              {harperState === 'ready' && lints.length > 0 && `（${lints.length} 处提示）`}
              {harperState === 'unavailable' && '（Harper 未安装，跳过）'}
            </span>
          </label>
        </div>
        <textarea
          rows={5}
          value={text}
          placeholder="例：I have went to school yesterday and buy a apple."
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && text.trim() !== '') {
              submit.mutate()
            }
          }}
        />
        {harperState === 'ready' && lints.length > 0 && (
          <ul className="we-lints">
            {lints.slice(0, 6).map((l, i) => (
              <li key={i}>
                <code>{text.slice(l.start, l.end) || '（此处）'}</code> {l.message}
              </li>
            ))}
            <li className="we-lints-note">
              这些是浏览器端的规则型提示，只抓表层问题；提交后才有逐条讲解。
            </li>
          </ul>
        )}
        <div className="we-actions">
          <GrammarVoiceButton sentence={shown?.original ?? text} analysis={shown?.error === null ? shown : undefined} source="写作语法纠错" />
          <button
            className="btn btn-primary"
            disabled={submit.isPending || text.trim() === ''}
            onClick={() => submit.mutate()}
          >
            {submit.isPending ? '批改中…' : '提交批改'}
            <kbd>⌘↵</kbd>
          </button>
          {submit.isError && <span className="we-err">{(submit.error as Error).message}</span>}
        </div>
      </section>

      {shown !== null && (
        <section className="we-result">
          <div className="we-summary">
            <span className="we-count">{shown.edits.length} 处改动</span>
            {shown.summary !== null && <span>{shown.summary}</span>}
            {shown.error !== null && <span className="we-err">{shown.error}</span>}
          </div>

          <div className="we-pair">
            <div>
              <h3>你写的</h3>
              <MarkedOriginal
                text={shown.original}
                edits={shown.edits}
                active={active}
                onPick={setActive}
              />
            </div>
            <div>
              <h3>改后</h3>
              <p className="we-corrected">{shown.corrected}</p>
            </div>
          </div>
          <section className="we-revision"><h3>你的修订稿</h3><p>{revised}</p>
            <button className="btn btn-outline" disabled={!decisions.length} onClick={() => useWorkspaceStore.getState().put('grammar', `writing-edits:${shown.id}`, { expanded: decisions.slice(0, -1) })}>撤销上次选择</button>
          </section>

          {shown.edits.length === 0 && <p className="gl-note">这段没有找到需要改的地方。</p>}

          <ol className="we-edits">
            {shown.edits.map((e) => (
              <li
                key={e.id}
                className={active === e.id ? 'on' : undefined}
                onMouseEnter={() => setActive(e.id)}
                onMouseLeave={() => setActive(null)}
              >
                <div className="we-edit-head">
                  <span className="we-type">{typeLabel(e.errant_type)}</span>
                  <code className="we-from">{e.o_str || '（缺）'}</code>
                  <span className="we-arrow">→</span>
                  <code className="we-to">{e.c_str || '（删）'}</code>
                  {e.misconception !== null && <span className="we-mis">误区 · {e.misconception}</span>}
                </div>
                {e.explanation !== null && <p className="we-explain">{e.explanation}</p>}
                <div className="we-edit-actions">
                  <button className="btn btn-outline" disabled={e.char_start === null || decisions.includes(`${e.id}:accept`)} onClick={() => decide(e.id, true)}>{decisions.includes(`${e.id}:accept`) ? '已采纳' : '采纳'}</button>
                  <button className="btn btn-outline" disabled={decisions.includes(`${e.id}:ignore`)} onClick={() => decide(e.id, false)}>{decisions.includes(`${e.id}:ignore`) ? '已忽略' : '忽略'}</button>
                </div>
              </li>
            ))}
          </ol>
        </section>
      )}

      {(history.data?.items.length ?? 0) > 0 && (
        <section className="we-history">
          <h3>历史批改</h3>
          <ul>
            {(history.data?.items ?? []).map((a) => (
              <li key={a.id}>
                <button onClick={() => { setCurrent(a); setAttemptId(String(a.id)) }}>
                  <span className="we-hist-text">{a.original.slice(0, 60)}</span>
                  <span className="we-hist-meta">
                    {a.edits.length} 处 ·{' '}
                    {a.created_at !== null ? new Date(a.created_at).toLocaleDateString('zh-CN') : ''}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  )
}
