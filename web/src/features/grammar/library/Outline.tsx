/* 右栏：本篇大纲 + 本篇概念掌握度。

   大纲从 Markdown 文本提取（doc-model.tocFromMarkdown），序号与渲染后的
   DOM 标题一一对应，点击按序号滚动定位；正在读到哪一节由上层算好传进来。
   本篇批注也列在这里——批注散在正文里找不着，有个总览才用得起来。

   概念掌握度原先住在概念专栏里，专栏换成整篇阅读后挪到这里——
   FSRS 打分（BR-95 两层学法）不能因为改了阅读布局就丢。 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import type { ConceptBrief } from '../../../lib/api-grammar'
import { grammarApi } from '../../../lib/api-grammar'
import { useUrlValue } from '@/lib/urlState'
import { useWorkspaceStore, useWorkspaceText, workspaceSnapshot } from '@/lib/workspaceStore'
import { GrammarPracticePane } from '../GrammarPracticePane'
import type { DocAnnotation } from '../../../lib/api-grammar-docs'

import type { TocEntry } from './doc-model'

const RATING_LABEL: Record<number, string> = { 1: '忘了', 2: '有点难', 3: '会了', 4: '很熟' }

function ConceptRow({ concept }: { concept: ConceptBrief }) {
  const qc = useQueryClient()
  const grade = useMutation({
    mutationFn: (rating: number) => grammarApi.gradeConcept(concept.slug, rating),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['gr-concepts-tree'] })
      void qc.invalidateQueries({ queryKey: ['gr-concept-stats'] })
    },
  })
  return (
    <div className="glib-concept">
      <div className="glib-concept-head">
        <span className={`glib-concept-layer ${concept.layer}`}>
          {concept.layer === 'active' ? '主动' : '参考'}
        </span>
        <b>{concept.title}</b>
      </div>
      <div className="glib-concept-grade">
        {[1, 2, 3, 4].map((r) => (
          <button key={r} disabled={grade.isPending} onClick={() => grade.mutate(r)}>
            {RATING_LABEL[r]}
          </button>
        ))}
      </div>
    </div>
  )
}

interface Props {
  toc: TocEntry[]
  activeIndex: number
  docPath: string | null
  onJump: (index: number) => void
  annotations: DocAnnotation[]
  onOpenAnnotation: (id: number) => void
}

export function Outline({
  toc,
  activeIndex,
  docPath,
  onJump,
  annotations,
  onOpenAnnotation,
}: Props) {
  const [panel, setPanel] = useUrlValue<string>('panel', 'outline', ['outline', 'notes', 'practice'])
  const [note, setNote] = useWorkspaceText('grammar', `note:${docPath ?? 'none'}`)
  const chapterKey = `lecture:${docPath ?? 'none'}`
  const chapter = useWorkspaceStore(s => s.records[`grammar:${chapterKey}`])
  const mapping = useQuery({ queryKey: ['gr-section-points', docPath], queryFn: () => grammarApi.sectionPoints(docPath!), enabled: !!docPath && panel === 'practice' })
  const concepts = useQuery({
    queryKey: ['gr-concepts-tree'],
    queryFn: () => grammarApi.concepts(),
  })

  const docConcepts =
    docPath === null
      ? []
      : (concepts.data?.chapters
          .flatMap((c) => c.docs)
          .find((d) => d.source_path === docPath)?.concepts ?? [])
  const activeConcepts = docConcepts.filter((c) => c.layer === 'active')

  return (
    <aside className="glib-outline" aria-label="本篇大纲">
      <div className="glib-outline-scroll">
        <div className="seg glib-side-tabs">{[['outline', '大纲'], ['notes', '笔记'], ['practice', '本节练习']].map(([value, label]) =>
          <button key={value} className={panel === value ? 'active' : ''} onClick={() => setPanel(value)}>{label}</button>)}</div>
        <div className="glib-learning-status">
          <span>{chapter?.selected === 'read' ? '已读 · 不代表掌握' : chapter?.anchor ? '阅读中' : '未读'}</span>
          <button onClick={() => useWorkspaceStore.getState().put('grammar', chapterKey, {
            ...workspaceSnapshot('grammar', chapterKey), selected: chapter?.selected === 'read' ? 'reading' : 'read',
          })}>{chapter?.selected === 'read' ? '标为阅读中' : '标为已读'}</button>
          <button onClick={() => {
            const title = toc.find(e => e.index === activeIndex)?.text
            if (!title) return
            useWorkspaceStore.getState().put('grammar', chapterKey, { ...workspaceSnapshot('grammar', chapterKey), expanded: [...new Set([...(chapter?.expanded ?? []), title])] })
          }}>添加书签</button>
        </div>
        {panel === 'notes' && <>
          <label className="glib-note-label">本篇个人笔记<textarea value={note} onChange={e => setNote(e.target.value)} placeholder="记录理解、疑问与例句，不修改讲义原文" /></label>
          {(chapter?.expanded ?? []).map(title => <button className="glib-outline-ann" key={title} onClick={() => {
            const target = toc.find(e => e.text === title)
            if (target) onJump(target.index)
          }}>{title}</button>)}
          {annotations.map(a => <button key={a.id} className="glib-outline-ann" onClick={() => onOpenAnnotation(a.id)}>{a.quote}<small>{a.note}</small></button>)}
        </>}
        {panel === 'practice' && <>
          {mapping.isPending && <p>正在读取关联题目…</p>}
          {mapping.error && <p role="alert">{mapping.error.message}</p>}
          {mapping.data && <><p>本篇已关联 {mapping.data.count} 道题，数量不足时按实际题数练习。</p>
            {mapping.data.count === 0 ? <p>本篇尚无关联练习题，可以继续阅读讲义或记录笔记。</p> : <GrammarPracticePane pointIds={mapping.data.point_ids} />}</>}
        </>}
        {panel === 'outline' && <>
        <p className="glib-outline-title">大纲</p>
        {toc.length === 0 && <p className="glib-outline-empty">本篇没有标题</p>}
        <ul className="glib-toc">
          {toc.map((e) => (
            <li key={e.index}>
              <button
                className={`lv${e.level} ${e.index === activeIndex ? 'on' : ''}`}
                onClick={() => onJump(e.index)}
              >
                {e.text}
              </button>
            </li>
          ))}
        </ul>

        {annotations.length > 0 && (
          <>
            <p className="glib-outline-title">本篇批注 {annotations.length}</p>
            {annotations.map((a) => (
              <button
                key={a.id}
                className={`glib-outline-ann ${a.color} ${a.resolved_start === null ? 'lost' : ''}`}
                onClick={() => onOpenAnnotation(a.id)}
                title={a.resolved_start === null ? '原文已改动，找不到落点' : a.quote}
              >
                <span>{a.quote}</span>
                {a.note !== null && a.note !== '' && <i>{a.note}</i>}
              </button>
            ))}
          </>
        )}

        {activeConcepts.length > 0 && (
          <>
            <p className="glib-outline-title">本篇概念 · 掌握度</p>
            {activeConcepts.map((c) => (
              <ConceptRow key={c.slug} concept={c} />
            ))}
          </>
        )}
        </>}
      </div>
    </aside>
  )
}
