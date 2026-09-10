/* 词库页（需求 01 v2）：书架为落地页，四类单词本同构展示。
   v1 的侧边栏词表列表已由书架卡片取代，复习/报告/学新词仍是同一批面板。 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { Overlay } from '../../components/Overlay'
import { Topbar } from '../../components/Topbar'
import { useMemo, useState } from 'react'

import { IconSpeaker } from '../../components/icons'
import type { Deck } from '../../lib/api-deck'
import { apiDeck } from '../../lib/api-deck'
import type { ParamPatch } from '../../lib/urlState'
import { useUrlParams } from '../../lib/urlState'
import { WordModal } from '../reader/WordModal'
import type { PracticeMode } from '../../lib/api-practice'
import { PracticePrepare } from './PracticePrepare'
import { PracticeHub } from './PracticeHub'
import { PracticeSessionPane } from './PracticeSessionPane'
import { DeckDetail } from './DeckDetail'
import { DictationPane } from './DictationPane'
import { GroupDrillPane } from './GroupDrillPane'
import { DeckShelf } from './DeckShelf'
import { Navigate } from 'react-router-dom'
import { ScenarioCreate } from './ScenarioCreate'
import { ScenarioDraftPane } from './ScenarioDraft'
import { LearnPane } from './LearnPane'
import { ReportPane } from './ReportPane'
import { ReviewPane } from './ReviewPane'
import { WordlistImportPanel } from './WordlistImportPanel'
import { getAutoplay, storeAutoplay, VOCAB_BOOK_KEY, WHOLE_DECK_SCENE } from './shared'
import './deck.css'
import './vocab-m5.css'
import './practice.css'

type View =
  | { kind: 'shelf' }
  /** 深链进来时 decks 还没到，先占位再决定去哪 */
  | { kind: 'pending' }
  | { kind: 'review' }
  | { kind: 'report' }
  | { kind: 'practice' }
  | { kind: 'learn'; listKey: string; listName: string }
  | { kind: 'browse'; deck: Deck }
  | { kind: 'draft'; wordlistId: number }
  | { kind: 'dictation'; deckKey: string; deckName: string }
  | { kind: 'drill'; deckKey: string; deckName: string; scene?: string }
  /** 查词（FR-507）：q 是输入，w 是右栏词卡正在看的词 */
  | { kind: 'dict'; q: string; w: string }

/* 视图 ↔ URL（BR-G-011）：刷新、分享链接、浏览器前进后退都指向同一个可见状态。
   离开某个本时顺手清掉它的子状态参数，避免下一个本继承上一个的筛选。 */
const SUB_PARAMS: ParamPatch = { tab: null, f: null, sort: null, q: null, grid: null, g: null, w: null }

function viewToParams(v: View): ParamPatch {
  switch (v.kind) {
    case 'practice':
      return { v: 'practice', k: null, id: null, ...SUB_PARAMS }
    case 'review':
      return { v: 'review', k: null, id: null, ...SUB_PARAMS }
    case 'report':
      return { v: 'report', k: null, id: null, ...SUB_PARAMS }
    case 'learn':
      return { v: 'learn', k: v.listKey, id: null, ...SUB_PARAMS }
    case 'browse':
      return { v: 'deck', k: v.deck.key, id: null }
    case 'draft':
      return { v: 'draft', k: null, id: String(v.wordlistId), ...SUB_PARAMS }
    case 'dictation':
      return { v: 'dictation', k: v.deckKey, id: null, ...SUB_PARAMS }
    case 'drill':
      // 场景进 URL：一个 95 词的场景要分几次做完，刷新得回到同一个场景
      return { v: 'drill', k: v.deckKey, id: null, ...SUB_PARAMS, g: v.scene ?? null }
    case 'dict':
      // q / w 要写在 SUB_PARAMS 之后，否则被里面的 q: null 抹掉
      return { ...SUB_PARAMS, v: 'dict', k: null, id: null, q: v.q || null, w: v.w || null }
    default:
      return { v: null, k: null, id: null, ...SUB_PARAMS }
  }
}

function paramsToView(
  kind: string,
  key: string,
  id: number,
  decks: Deck[] | undefined,
  scene = '',
  q = '',
  w = '',
): View {
  if (kind === 'dict') return { kind: 'dict', q, w }
  if (kind === 'practice') return { kind: 'practice' }
  if (kind === 'review') return { kind: 'review' }
  if (kind === 'report') return { kind: 'report' }
  if (kind === 'draft') return Number.isFinite(id) && id > 0 ? { kind: 'draft', wordlistId: id } : { kind: 'shelf' }
  if (
    kind === 'learn' ||
    kind === 'deck' ||
    kind === 'dictation' ||
    kind === 'drill'
  ) {
    if (decks === undefined) return { kind: 'pending' }
    const deck = decks.find((d) => d.key === key)
    if (deck === undefined) return { kind: 'shelf' } // 本已被删或链接失效
    if (kind === 'deck') return { kind: 'browse', deck }
    if (kind === 'learn') return { kind: 'learn', listKey: deck.key, listName: deck.name }
    if (kind === 'dictation') return { kind: 'dictation', deckKey: deck.key, deckName: deck.name }
    return {
      kind: 'drill',
      deckKey: deck.key,
      deckName: deck.name,
      ...(scene === '' ? {} : { scene }),
    }
  }
  return { kind: 'shelf' }
}

interface DeleteDeckDialogProps {
  deck: Deck
  pending: boolean
  error: string | null
  onCancel: () => void
  onConfirm: () => void
}

function DeleteDeckDialog({ deck, pending, error, onCancel, onConfirm }: DeleteDeckDialogProps) {
  return (
    <Overlay onClose={onCancel} card="ov-narrow">
        <div className="overlay-head">
          <div className="overlay-title">删除单词本</div>
        </div>
        <div style={{ fontSize: 'var(--text-sm)', lineHeight: 1.8, color: 'var(--ink-secondary)' }}>
          确定删除「{deck.name}」（{deck.total.toLocaleString()} 词）？
          删除只解除归属关系，已学词的复习进度与历史记录不受影响（BR-29）。
        </div>
        {error && <div className="form-err">{error}</div>}
        <div className="overlay-foot">
          <button className="btn" onClick={onCancel} disabled={pending}>
            取消
          </button>
          <button
            className={`btn btn-danger${pending ? ' loading' : ''}`}
            disabled={pending}
            onClick={onConfirm}
          >
            {pending && <span className="spinner" />}
            删除
          </button>
        </div>
    </Overlay>
  )
}

export function VocabPage() {
  const queryClient = useQueryClient()
  const [params, patchParams] = useUrlParams()
  const overviewQuery = useQuery({
    queryKey: ['vocab-overview'],
    queryFn: apiDeck.overview,
    staleTime: 30_000,
  })
  const view = useMemo(
    () =>
      paramsToView(
        params.get('v') ?? 'shelf',
        params.get('k') ?? '',
        Number(params.get('id') ?? ''),
        overviewQuery.data?.decks,
        params.get('g') ?? '',
        params.get('q') ?? '',
        params.get('w') ?? '',
      ),
    [params, overviewQuery.data],
  )
  const setView = (next: View) => patchParams(viewToParams(next), { push: true })
  /* 子面板的「退出 / 返回单词本」回到来处的本，从场景速记退出落在那个场景 chip 上；
     顶栏的返回箭头另走 Topbar 的深链返回语义（站内有历史退一步，深链直开去父级） */
  const exitToDeck = (deckKey: string, scene?: string) =>
    patchParams({ v: 'deck', k: deckKey, id: null, ...SUB_PARAMS, g: scene ?? null }, { push: true })
  const deckRoute = (deckKey: string, scene?: string) =>
    `/vocab?v=deck&k=${encodeURIComponent(deckKey)}${scene ? `&g=${encodeURIComponent(scene)}` : ''}`
  const back =
    view.kind === 'shelf' || view.kind === 'pending'
      ? undefined
      : view.kind === 'browse'
        ? { to: '/vocab', label: '词汇' }
        : view.kind === 'drill'
          ? {
              to: deckRoute(
                view.deckKey,
                view.scene !== undefined && view.scene !== WHOLE_DECK_SCENE ? view.scene : undefined,
              ),
              label: '单词本',
            }
          : view.kind === 'learn'
            ? { to: deckRoute(view.listKey), label: '单词本' }
            : view.kind === 'dictation'
              ? { to: deckRoute(view.deckKey), label: '单词本' }
              : { to: '/vocab', label: '词汇' }
  const [autoplay, setAutoplay] = useState(getAutoplay)
  const [importOpen, setImportOpen] = useState(false)
  const [scenarioOpen, setScenarioOpen] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<Deck | null>(null)
  const [prepare, setPrepare] = useState<{ mode: PracticeMode; deck?: string } | null>(null)
  const openPractice = (id: string) => {
    setPrepare(null)
    patchParams({ v: 'practice', id, k: null, ...SUB_PARAMS }, { push: true })
  }

  const deleteMutation = useMutation({
    mutationFn: (key: string) => apiDeck.remove(key),
    onSuccess: (_data, key) => {
      setDeleteTarget(null)
      void queryClient.invalidateQueries({ queryKey: ['decks'] })
      void queryClient.invalidateQueries({ queryKey: ['vocab-overview'] })
      void queryClient.invalidateQueries({ queryKey: ['wordlists'] })
      // 正在浏览/学习被删的本时退回书架
      if (params.get('k') === key) setView({ kind: 'shelf' })
    },
  })

  const startReview = () => {
    setPrepare({ mode: 'review' })
  }

  const crumbLabel =
    view.kind === 'shelf' || view.kind === 'pending'
      ? '单词本'
      : view.kind === 'practice'
        ? '专项练习'
      : view.kind === 'dict'
        ? (view.q ? `查词 · ${view.q}` : '查词')
      : view.kind === 'review'
        ? '今日复习'
        : view.kind === 'report'
          ? '学习报告'
          : view.kind === 'learn'
            ? `学新词 · ${view.listName}`
            : view.kind === 'draft'
              ? '场景本草稿'
              : view.kind === 'dictation'
                ? `听写 · ${view.deckName}`
                : view.kind === 'drill'
                  ? `速记 · ${view.scene === WHOLE_DECK_SCENE ? `${view.deckName} · 整本` : (view.scene ?? view.deckName)}`
                  : view.deck.name

  return (
    <div className="main">
      <Topbar
        back={back}
        crumbs={[
          view.kind === 'shelf' || view.kind === 'pending'
            ? { label: '词汇' }
            : { label: '词汇', onClick: () => setView({ kind: 'shelf' }) },
        ]}
        title={crumbLabel}
        actions={
          <button
            className={`icon-btn${autoplay ? ' active' : ''}`}
            title={`自动发音（背单词新卡 / 点词卡片）：${autoplay ? '开' : '关'}`}
            onClick={() =>
              setAutoplay((v) => {
                storeAutoplay(!v)
                return !v
              })
            }
          >
            <IconSpeaker />
          </button>
        }
      />

      {view.kind === 'dict' && <Navigate replace to={`/dict?${new URLSearchParams({ q: view.q, w: view.w })}`} />}
      {(['shelf', 'practice', 'report'] as string[]).includes(view.kind) && !params.get('id') && (
        <nav className="vp-tabs" aria-label="词汇模块">
          {([{ kind: 'shelf', name: '词书' }, { kind: 'practice', name: '专项练习' }, { kind: 'report', name: '学习报告' }] as const).map((tab) => (
            <button
              key={tab.kind}
              aria-current={view.kind === tab.kind ? 'page' : undefined}
              onClick={() => setView({ kind: tab.kind })}
            >
              {tab.name}
            </button>
          ))}
        </nav>
      )}

      {view.kind === 'pending' && (
        <div className="state-block">
          <div className="spinner" />
        </div>
      )}

      {view.kind === 'shelf' && (
        <DeckShelf
          onOpenDeck={(deck) => setView({ kind: 'browse', deck })}
          onStartLearn={(deck) => setPrepare({ mode: 'learn', deck: deck.key })}
          onStartReview={startReview}
          onResume={openPractice}
          onOpenReport={() => setView({ kind: 'report' })}
          onImport={() => setImportOpen(true)}
          onCreateScenario={() => setScenarioOpen(true)}
          onDelete={(deck) => {
            deleteMutation.reset()
            setDeleteTarget(deck)
          }}
        />
      )}

      {view.kind !== 'shelf' && view.kind !== 'pending' && (
        <div className="body-row">
          {view.kind === 'practice' && (params.get('id')
            ? <PracticeSessionPane key={params.get('id')} id={params.get('id')!} onOpen={openPractice} />
            : <PracticeHub onStart={(mode) => setPrepare({ mode })} onOpen={openPractice} />)}
          {view.kind === 'review' && <ReviewPane autoplay={autoplay} />}
          {view.kind === 'report' && <ReportPane />}
          {view.kind === 'learn' && (
            <LearnPane
              key={view.listKey}
              listKey={view.listKey}
              listName={view.listName}
              autoplay={autoplay}
              onAutoplay={(v) => {
                storeAutoplay(v)
                setAutoplay(v)
              }}
              onExit={() => exitToDeck(view.listKey)}
            />
          )}
          {view.kind === 'draft' && (
            <ScenarioDraftPane
              key={view.wordlistId}
              wordlistId={view.wordlistId}
              onConfirmed={() => setView({ kind: 'shelf' })}
              onDiscarded={() => setView({ kind: 'shelf' })}
            />
          )}
          {view.kind === 'dictation' && (
            <DictationPane
              key={view.deckKey}
              deckKey={view.deckKey}
              deckName={view.deckName}
              onExit={() => exitToDeck(view.deckKey)}
            />
          )}
          {view.kind === 'drill' && (
            <GroupDrillPane
              key={view.deckKey}
              deckKey={view.deckKey}
              deckName={view.deckName}
              scene={view.scene ?? null}
              onScene={(s) =>
                setView({
                  kind: 'drill',
                  deckKey: view.deckKey,
                  deckName: view.deckName,
                  ...(s === null ? {} : { scene: s }),
                })
              }
              onExit={() =>
                exitToDeck(
                  view.deckKey,
                  view.scene !== undefined && view.scene !== WHOLE_DECK_SCENE ? view.scene : undefined,
                )
              }
            />
          )}
          {view.kind === 'browse' && (
            <DeckDetail
              key={view.deck.key}
              deck={view.deck}
              onReview={() => setPrepare({ mode: 'review', deck: view.deck.key })}
              onDictation={() =>
                setPrepare({ mode: 'dictation', deck: view.deck.key })
              }
              onDrill={(scene) =>
                setView({
                  kind: 'drill',
                  deckKey: view.deck.key,
                  deckName: view.deck.name,
                  ...(scene === '' ? {} : { scene }),
                })
              }
              onLearn={
                view.deck.key === VOCAB_BOOK_KEY
                  ? undefined
                  : () => {
                      setPrepare({ mode: 'learn', deck: view.deck.key })
                    }
              }
            />
          )}
        </div>
      )}

      {importOpen && (
        <WordlistImportPanel
          onClose={() => setImportOpen(false)}
          onDone={() => {
            setImportOpen(false)
            // 新本随 decks 失效重新拉到，回书架比构造假 Deck 跳转更稳
            void queryClient.invalidateQueries({ queryKey: ['decks'] })
            void queryClient.invalidateQueries({ queryKey: ['vocab-overview'] })
            void queryClient.invalidateQueries({ queryKey: ['wordlists'] })
            setView({ kind: 'shelf' })
          }}
        />
      )}

      {scenarioOpen && (
        <ScenarioCreate
          onClose={() => setScenarioOpen(false)}
          onDraftReady={(wordlistId) => {
            setScenarioOpen(false)
            setView({ kind: 'draft', wordlistId })
          }}
          onBatchDone={() => {
            void queryClient.invalidateQueries({ queryKey: ['decks'] })
            void queryClient.invalidateQueries({ queryKey: ['vocab-overview'] })
            void queryClient.invalidateQueries({ queryKey: ['scenario-seeds'] })
          }}
        />
      )}

      <WordModal />
      {prepare && <PracticePrepare {...prepare} onClose={() => setPrepare(null)} onReady={openPractice} />}

      {deleteTarget && (
        <DeleteDeckDialog
          deck={deleteTarget}
          pending={deleteMutation.isPending}
          error={deleteMutation.isError ? deleteMutation.error.message : null}
          onCancel={() => setDeleteTarget(null)}
          onConfirm={() => deleteMutation.mutate(deleteTarget.key)}
        />
      )}
    </div>
  )
}
