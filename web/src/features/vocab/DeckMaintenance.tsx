/* 单词本的三个维护动作（FR-499 / FR-501 / FR-502）：清发音缓存、清学习进度、AI 补全。

   三个都照设置页 DataSection.ClearCacheOverlay 的三态原地换态：确认 → loading →
   结果 + 完成，错误用 form-err，不弹 toast——用户明确点了确认的危险操作，结果要留在
   同一层里给他看。 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'

import { IconClose } from '../../components/icons'
import { Overlay } from '../../components/Overlay'
import {
  AI_RUN_ACTIVE,
  apiDeckOps,
  type Deck,
  type DeckAiKind,
  type DeckAiRun,
} from '../../lib/api-deck'
import { setTtsEpoch } from '../../lib/audio'
import { useListenStore } from './listenStore'

export type MaintenanceKind = 'audio' | 'reset' | 'ai'

/** 大本两项都跑就是上万次调用：超过这个数要多勾一个确认框 */
const BIG_RUN_CALLS = 2000
const KIND_LABEL: Record<DeckAiKind, string> = { explain: 'AI 语境释义', breakdown: '拆开记', tts: '预加载词与例句发音' }
const STATUS_LABEL: Record<DeckAiRun['status'], string> = {
  queued: '排队中',
  running: '进行中',
  done: '已完成',
  failed: '失败',
  cancelled: '已取消',
}

export function isAiRunActive(run: DeckAiRun | null | undefined): boolean {
  return run !== null && run !== undefined && AI_RUN_ACTIVE.includes(run.status)
}

/** 本内最近一次 AI 补全；在跑时 2 秒轮询，Overlay 关了也照样（横幅 chip 要动） */
export function useDeckAiRun(deckKey: string) {
  return useQuery({
    queryKey: ['deck-ai-run', deckKey],
    queryFn: () => apiDeckOps.latestAiRun(deckKey),
    refetchInterval: (q) => (isAiRunActive(q.state.data?.run) ? 2000 : false),
    refetchIntervalInBackground: true,
  })
}

function fmtMb(n: number): string {
  return n >= 1 ? `${n.toFixed(1)} MB` : `${Math.round(n * 1024)} KB`
}

function Head({ title, onClose }: { title: string; onClose: () => void }) {
  return (
    <div className="overlay-head">
      <div className="overlay-title">{title}</div>
      <button className="icon-btn" title="关闭" onClick={onClose}>
        <IconClose />
      </button>
    </div>
  )
}

export function ClearDeckAudioOverlay({ deck, onClose }: { deck: Deck; onClose: () => void }) {
  const qc = useQueryClient()
  const clear = useMutation({
    mutationFn: () => apiDeckOps.clearAudioCache(deck.key),
    onSuccess: (data) => {
      // 删了服务端文件浏览器还有 7 天缓存：代号变了 URL 才变
      setTtsEpoch(data.epoch)
      void qc.invalidateQueries({ queryKey: ['word-voices'] })
      void qc.invalidateQueries({ queryKey: ['cfg-storage'] })
    },
  })
  return (
    <Overlay onClose={onClose} card="ov-narrow">
      <Head title="清除发音缓存" onClose={onClose} />
      {clear.data === undefined ? (
        <>
          <div className="st-note" style={{ marginTop: 0 }}>
            将删除「{deck.name}」{deck.total.toLocaleString()} 个词已合成的发音文件。只清单词本身，
            例句与释义的音频照旧。下次朗读会重新合成：首次会稍慢，也可能产生合成费用；
            不影响任何学习进度。
          </div>
          {clear.isError && <div className="form-err">清理失败：{clear.error.message}</div>}
          <div className="overlay-foot">
            <button className="btn" onClick={onClose}>
              取消
            </button>
            <button
              className={`btn btn-danger${clear.isPending ? ' loading' : ''}`}
              disabled={clear.isPending}
              onClick={() => clear.mutate()}
            >
              {clear.isPending && <span className="spinner" />}
              确认清理
            </button>
          </div>
        </>
      ) : (
        <>
          <div className="chip ok" style={{ alignSelf: 'flex-start' }}>
            已清理 {clear.data.files} 个文件 · {fmtMb(clear.data.cleared_mb)}
          </div>
          <div className="overlay-foot">
            <button className="btn btn-primary" onClick={onClose}>
              完成
            </button>
          </div>
        </>
      )}
    </Overlay>
  )
}

export function ResetProgressOverlay({ deck, onClose }: { deck: Deck; onClose: () => void }) {
  const qc = useQueryClient()
  const reset = useMutation({
    mutationFn: () => apiDeckOps.resetProgress(deck.key),
    onSuccess: () => {
      const listen = useListenStore.getState()
      if (listen.visible && listen.deckKey === deck.key) listen.close()
      for (const key of [
        ['deck-words', deck.key],
        ['deck-words-all', deck.key],
        ['deck-scenes', deck.key],
        ['decks'],
        ['review-stats'],
        ['vocab-overview'],
      ]) {
        void qc.invalidateQueries({ queryKey: key })
      }
    },
  })
  return (
    <Overlay onClose={onClose} card="ov-narrow">
      <Head title="清除学习进度" onClose={onClose} />
      {reset.data === undefined ? (
        <>
          <div className="st-note" style={{ marginTop: 0 }}>
            「{deck.name}」{deck.total.toLocaleString()} 个词的接触次数、自测过关、人工标记、
            复习调度与场景进度全部归零，复习记录一并删除。
          </div>
          <ul className="dd-reset-list">
            <li>从阅读 / 视频里收藏过的词留在生词本里（仍算学习中），只清它的进度</li>
            <li>只因看过、听过、标过而自动建的条目整行删除，回到「未学」</li>
            <li>进度是按词存的：同一个词在别的本里的进度会一起归零</li>
            <li>正在听读这一本的话会停下</li>
          </ul>
          {reset.isError && <div className="form-err">重置失败：{reset.error.message}</div>}
          <div className="overlay-foot">
            <button className="btn" onClick={onClose}>
              取消
            </button>
            <button
              className={`btn btn-danger-solid${reset.isPending ? ' loading' : ''}`}
              disabled={reset.isPending}
              onClick={() => reset.mutate()}
            >
              {reset.isPending && <span className="spinner" />}
              全部归零
            </button>
          </div>
        </>
      ) : (
        <>
          <div className="chip ok" style={{ alignSelf: 'flex-start' }}>
            已重置 {reset.data.words} 词 · 删除条目 {reset.data.deleted} · 复习记录{' '}
            {reset.data.review_logs}
          </div>
          <div className="overlay-foot">
            <button className="btn btn-primary" onClick={onClose}>
              完成
            </button>
          </div>
        </>
      )}
    </Overlay>
  )
}

function RunProgress({ run, onCancel, cancelling }: { run: DeckAiRun; onCancel: () => void; cancelling: boolean }) {
  const pct = run.total > 0 ? Math.min(100, (run.done / run.total) * 100) : 0
  const active = isAiRunActive(run)
  return (
    <div className="sc-progress">
      <div className="sc-progress-head">
        <b>{STATUS_LABEL[run.status]}</b>
        <span>
          {run.done} / {run.total} 词
          {run.current_word && active ? ` · ${run.current_word}` : ''}
        </span>
      </div>
      <div className="sc-progress-bar">
        <i style={{ width: `${pct}%` }} />
      </div>
      <div className="sc-progress-counts">
        <span>已有 {run.cached}</span>
        <span>新生成 {run.generated}</span>
        <span>失败 {run.failed}</span>
        <span>{run.kinds.map((k) => KIND_LABEL[k]).join(' + ')}</span>
      </div>
      {run.error && <div className="form-err">{run.error}</div>}
      {active && (
        <div>
          <button
            className="btn btn-outline"
            disabled={run.cancel_requested || cancelling}
            onClick={onCancel}
          >
            {run.cancel_requested || cancelling ? '取消中…' : '取消'}
          </button>
        </div>
      )}
    </div>
  )
}

export function DeckAiRunOverlay({ deck, onClose }: { deck: Deck; onClose: () => void }) {
  const qc = useQueryClient()
  const query = useDeckAiRun(deck.key)
  const run = query.data?.run ?? null
  const [kinds, setKinds] = useState<DeckAiKind[]>(['explain', 'breakdown', 'tts'])
  const [refresh, setRefresh] = useState(false)
  const [bigOk, setBigOk] = useState(false)
  // 这次打开里点过「开始」：结束后也停在进度态，别一完成就跳回配置页把结果盖掉
  const [startedHere, setStartedHere] = useState(false)

  const start = useMutation({
    mutationFn: () => apiDeckOps.startAiRun(deck.key, { kinds, refresh }),
    onSuccess: (data) => {
      setStartedHere(true)
      qc.setQueryData(['deck-ai-run', deck.key], { run: data })
    },
  })
  const cancel = useMutation({
    mutationFn: (id: number) => apiDeckOps.cancelAiRun(deck.key, id),
    onSuccess: (data) => qc.setQueryData(['deck-ai-run', deck.key], { run: data }),
  })
  const finishedHere = startedHere && run !== null && !isAiRunActive(run)
  useEffect(() => {
    if (finishedHere && run?.status === 'done') {
      void qc.invalidateQueries({ queryKey: ['breakdown'] })
      void qc.invalidateQueries({ queryKey: ['word-analysis-cache'] })
    }
  }, [finishedHere, run?.status, qc])

  const calls = deck.total * kinds.filter(kind => kind !== 'tts').length
  const needsBigOk = calls > BIG_RUN_CALLS
  const showProgress = run !== null && (isAiRunActive(run) || startedHere)

  return (
    <Overlay onClose={onClose} card="dd-ai-opts">
      <Head title={`AI 补全 · ${deck.name}`} onClose={onClose} />
      {showProgress && run !== null ? (
        <>
          <RunProgress run={run} onCancel={() => cancel.mutate(run.id)} cancelling={cancel.isPending} />
          <div className="overlay-foot">
            <span className="sp-muted">
              {isAiRunActive(run) ? '关掉这个窗口也会继续跑，页头有进度' : ''}
            </span>
            <button className="btn btn-primary" onClick={onClose}>
              {isAiRunActive(run) ? '关闭' : '完成'}
            </button>
          </div>
        </>
      ) : (
        <>
          <div className="st-note" style={{ marginTop: 0 }}>
            把「{deck.name}」里每个词的 AI 结果先算好，之后打开词卡直接有，不用一个个点。
            已算过的默认跳过；生词本的词以「从词库页打开词卡」那条路径为准。
          </div>
          <div className="dd-ai-opt">
            {(['explain', 'breakdown', 'tts'] as DeckAiKind[]).map((k) => (
              <label key={k}>
                <input
                  type="checkbox"
                  checked={kinds.includes(k)}
                  onChange={(e) =>
                    setKinds((prev) =>
                      e.target.checked ? [...new Set([...prev, k])] : prev.filter((x) => x !== k),
                    )
                  }
                />
                {KIND_LABEL[k]}
              </label>
            ))}
          </div>
          {kinds.includes('tts') && <p className="st-note">按词的固定音色或默认音色预加载，最多同时合成 4 段。换音色后需重新预加载；收费音源按服务商规则计费。</p>}
          <div className="dd-ai-opt">
            <label>
              <input type="checkbox" checked={refresh} onChange={(e) => setRefresh(e.target.checked)} />
              已有的也重新生成
            </label>
          </div>
          <div className="st-note">
            最多约 {calls.toLocaleString()} 次调用，走「词语解释」能力绑定的模型；
            {refresh ? '已有的也会重算。' : '已有缓存的会跳过，实际次数只会更少。'}
            可以随时取消，重启后从断点续跑。
          </div>
          {needsBigOk && (
            <div className="dd-ai-opt">
              <label>
                <input type="checkbox" checked={bigOk} onChange={(e) => setBigOk(e.target.checked)} />
                我知道这是一笔不小的调用量
              </label>
            </div>
          )}
          {run !== null && !startedHere && (
            <div className="sp-muted">
              上次：{STATUS_LABEL[run.status]} · {run.done} / {run.total} 词 · 新生成 {run.generated}
            </div>
          )}
          {start.isError && <div className="form-err">{start.error.message}</div>}
          <div className="overlay-foot">
            <button className="btn" onClick={onClose}>
              取消
            </button>
            <button
              className={`btn btn-primary${start.isPending ? ' loading' : ''}`}
              disabled={kinds.length === 0 || (needsBigOk && !bigOk) || start.isPending}
              onClick={() => start.mutate()}
            >
              {start.isPending && <span className="spinner" />}
              开始{needsBigOk ? `（约 ${calls.toLocaleString()} 次调用）` : ''}
            </button>
          </div>
        </>
      )}
    </Overlay>
  )
}
