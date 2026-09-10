/* 查词结果列表（FR-508~511）：分组、行、键盘高亮、近义词辨析。
   行是 role=option 的按钮：点 = 选中换右栏词卡，双击 / 行尾按钮 = 弹中央词卡。 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { IconArrowUpRight, IconClock, IconSparkle } from '../../../components/icons'
import { api, ApiError } from '../../../lib/api'
import type { DictSearchKind, NuanceResponse } from '../../../lib/api'
import { capabilityWithModel } from '../../../lib/model-label'
import { useVocabCollectionStore } from '../../../lib/vocabCollectionStore'
import { tagLabel } from '../shared'
import type { DictRow, Section } from './dictQuery'
import { briefOf } from './dictQuery'
import type { RecentLookup } from './dictStore'

const STAGE_TITLE: Record<string, string> = {
  learning: '学习中',
  tested: '短期会了',
  mastered: '已掌握',
  hard: '困难词',
}
const MAX_TAG_CHIPS = 3
/** 能力绑定行上的中文标签（与设置页一致），模型位显示真名 */
const EXPLAIN_LABEL = '词语解释'

interface RowProps {
  row: DictRow
  index: number
  active: boolean
  selected: boolean
  exact: boolean
  query: string
  onSelect: (word: string) => void
  onOpen: (word: string) => void
}

function highlight(text: string, needle: string) {
  if (needle === '' || !text.includes(needle)) return text
  const at = text.indexOf(needle)
  return (
    <>
      {text.slice(0, at)}
      <mark>{needle}</mark>
      {text.slice(at + needle.length)}
    </>
  )
}

function Row({ row, index, active, selected, exact, query, onSelect, onOpen }: RowProps) {
  const collected = useVocabCollectionStore((s) => s.collected.has(row.lc))
  // 刚在词卡里收藏的词，服务端还标着 unseen：本地收藏集合先顶上，不为这个刷新整个搜索
  const stage = row.stage !== 'unseen' ? row.stage : row.in_vocab || collected ? 'collected' : null
  const extra = row.tags.length - MAX_TAG_CHIPS
  return (
    <button
      type="button"
      role="option"
      id={`dq-opt-${index}`}
      aria-selected={selected}
      className={`dq-row${active ? ' is-active' : ''}${selected ? ' is-selected' : ''}${exact ? ' is-exact' : ''}`}
      onClick={() => onSelect(row.word)}
      onDoubleClick={() => onOpen(row.word)}
    >
      {row.label !== undefined && <span className="dq-row-label">{row.label}</span>}
      <span className="dq-row-word">{row.word}</span>
      {row.phonetic !== null && <span className="dq-row-phon">/{row.phonetic}/</span>}
      <span className="dq-row-brief">{highlight(briefOf(row), row.gloss !== undefined ? query : '')}</span>
      {row.tags.length > 0 && (
        <span className="dq-row-tags">
          {row.tags.slice(0, MAX_TAG_CHIPS).map((t) => (
            <span key={t} className="chip">
              {tagLabel(t)}
            </span>
          ))}
          {extra > 0 && <span className="chip">+{extra}</span>}
        </span>
      )}
      {stage !== null && (
        <i
          className={`dq-dot ${stage}`}
          title={stage === 'collected' ? '已收藏' : (STAGE_TITLE[stage] ?? stage)}
        />
      )}
      <span
        className="icon-btn dq-row-open"
        title="打开词卡"
        onClick={(e) => {
          e.stopPropagation()
          onOpen(row.word)
        }}
      >
        <IconArrowUpRight />
      </span>
    </button>
  )
}

function NuanceBlock({ word, synonyms }: { word: string; synonyms: string[] }) {
  const qc = useQueryClient()
  const key = ['nuance', word, synonyms.join(' ')]
  const probe = useQuery({
    queryKey: key,
    queryFn: () => api.wordNuance(word, synonyms, { cachedOnly: true }),
    staleTime: Infinity,
  })
  const run = useMutation({
    mutationFn: () => api.wordNuance(word, synonyms),
    onSuccess: (data) => qc.setQueryData<NuanceResponse>(key, data),
  })
  const data = probe.data
  if (data?.result === null || data === undefined) {
    const err = run.error
    return (
      <div className="dq-chips">
        <button
          className="btn btn-soft btn-sm"
          disabled={run.isPending || probe.isPending}
          onClick={() => run.mutate()}
        >
          <IconSparkle />
          {run.isPending ? 'AI 辨析中…' : 'AI 辨析'}
        </button>
        {err !== null && (
          <span className="form-err">
            {err instanceof ApiError && err.status === 503 ? 'AI 网关未配置，暂不可用' : err.message}
          </span>
        )}
      </div>
    )
  }
  const result = data.result
  return (
    <div className="dq-nuance">
      <div>{result.summary}</div>
      {result.items.map((item) => (
        <div key={item.word} className="dq-nuance-item">
          <b>{item.word}</b>：{item.difference}
          <div className="dq-nuance-ex">
            {item.example_en}
            {item.example_zh !== '' && ` — ${item.example_zh}`}
          </div>
        </div>
      ))}
      <div className="dq-nuance-meta">
        {data.cached && <span className="chip">已缓存</span>}
        <span>{capabilityWithModel(EXPLAIN_LABEL, data.model)}</span>
        <button className="btn-ghost-sm" disabled={run.isPending} onClick={() => run.mutate()}>
          重新辨析
        </button>
      </div>
    </div>
  )
}

interface DictResultsProps {
  sections: Section[]
  kind: DictSearchKind
  query: string
  activeIndex: number
  selectedWord: string
  /** 近义词辨析的目标词（原形）；没有近义词组时不显示按钮 */
  nuanceWord: string | null
  onSelect: (word: string) => void
  onOpen: (word: string) => void
  onSuggest: (word: string) => void
}

export function DictResults({
  sections,
  kind,
  query,
  activeIndex,
  selectedWord,
  nuanceWord,
  onSelect,
  onOpen,
  onSuggest,
}: DictResultsProps) {
  let index = -1
  return (
    <>
      {sections.map((section) => {
        if (section.kind === 'suggestions') {
          return (
            <div key={section.kind} className="dq-sec">
              <div className="dq-sec-head">{section.title}</div>
              <div className="dq-chips">
                {section.entries.map((row) => (
                  <button key={row.lc} className="chip" onClick={() => onSuggest(row.word)}>
                    {row.word}
                    {row.brief !== null && ` · ${row.brief}`}
                  </button>
                ))}
              </div>
            </div>
          )
        }
        const synonyms = section.kind === 'syn' ? section.entries.map((e) => e.lc).slice(0, 8) : []
        return (
          <div key={section.kind} className="dq-sec">
            <div className="dq-sec-head">{section.title}</div>
            {section.entries.map((row) => {
              index += 1
              const i = index
              return (
                <Row
                  key={`${section.kind}:${row.lc}`}
                  row={row}
                  index={i}
                  active={i === activeIndex}
                  selected={row.word === selectedWord}
                  exact={section.kind === 'exact' || (kind === 'zh' && section.kind === 'reverse-exact')}
                  query={query}
                  onSelect={onSelect}
                  onOpen={onOpen}
                />
              )
            })}
            {section.kind === 'syn' && nuanceWord !== null && synonyms.length > 0 && (
              <NuanceBlock word={nuanceWord} synonyms={synonyms} />
            )}
          </div>
        )
      })}
    </>
  )
}

export function RecentList({
  recent,
  onPick,
  onClear,
}: {
  recent: RecentLookup[]
  onPick: (word: string) => void
  onClear: () => void
}) {
  if (recent.length === 0) {
    return <div className="dq-state">输入英文或中文开始查词，最近查过的词会留在这里</div>
  }
  return (
    <div className="dq-recent">
      <div className="dq-sec-head">
        最近查过
        <button className="btn-ghost-sm" onClick={onClear}>
          清空
        </button>
      </div>
      {recent.map((r) => (
        <button key={r.word} className="dq-recent-row" onClick={() => onPick(r.word)}>
          <IconClock />
          <b>{r.word}</b>
          <span className="dq-row-brief">{r.brief}</span>
        </button>
      ))}
    </div>
  )
}
