/* AI 场景本生成入口（需求 01 v2 FR-167 ~ FR-175）：自定义描述 + 推荐场景批量。

   进度只展示后端回报的真实阶段与计数，不编造百分比——阶段序号本身是真实推进量，
   计数缺失时显示占位而非猜一个数字（沿用管线中心 RunningProgress 的口径）。 */

import { useMutation, useQuery } from '@tanstack/react-query'

import { Overlay } from '../../components/Overlay'
import { useEffect, useMemo, useState } from 'react'

import { IconCheck, IconClose, IconSparkle } from '../../components/icons'
import type { CefrLevel, ScenarioJob, ScenarioSeed } from '../../lib/api-deck'
import { apiScenario, CEFR_LEVELS, SCENARIO_STAGES } from '../../lib/api-deck'

const POLL_MS = 2000

interface ScenarioCreateProps {
  onClose: () => void
  /** 单个场景生成完成，进草稿预览 */
  onDraftReady: (wordlistId: number) => void
  /** 批量生成收尾，刷新书架 */
  onBatchDone: () => void
}

export function ScenarioCreate({ onClose, onDraftReady, onBatchDone }: ScenarioCreateProps) {
  const [tab, setTab] = useState<'custom' | 'seeds'>('custom')

  return (
    <Overlay onClose={onClose} card="sc-card">
        <div className="overlay-head">
          <div className="overlay-title">
            <IconSparkle />
            生成场景本
          </div>
          <div style={{ flex: 1 }} />
          <button className="icon-btn" onClick={onClose} title="关闭">
            <IconClose />
          </button>
        </div>

        <div className="seg" style={{ alignSelf: 'flex-start' }}>
          <button className={tab === 'custom' ? 'active' : undefined} onClick={() => setTab('custom')}>
            自定义场景
          </button>
          <button className={tab === 'seeds' ? 'active' : undefined} onClick={() => setTab('seeds')}>
            推荐场景
          </button>
        </div>

        {tab === 'custom' ? (
          <CustomPane onDraftReady={onDraftReady} />
        ) : (
          <SeedPane onBatchDone={onBatchDone} />
        )}
    </Overlay>
  )
}

/* ---- 自定义场景 ---- */

function CustomPane({ onDraftReady }: { onDraftReady: (id: number) => void }) {
  const [idea, setIdea] = useState('')
  const [level, setLevel] = useState<CefrLevel | ''>('')
  const [withExamples, setWithExamples] = useState(true)
  const [jobId, setJobId] = useState<string | null>(null)

  const start = useMutation({
    mutationFn: () =>
      apiScenario.generate({
        idea: idea.trim(),
        ...(level ? { level } : {}),
        with_examples: withExamples,
      }),
    onSuccess: (data) => setJobId(data.job_id),
  })

  const job = useJobPolling(jobId)

  useEffect(() => {
    if (job?.status === 'done' && job.wordlist_id !== undefined) onDraftReady(job.wordlist_id)
  }, [job, onDraftReady])

  if (jobId !== null) {
    return (
      <JobProgress
        job={job}
        onRetry={() => {
          setJobId(null)
          start.reset()
        }}
      />
    )
  }

  return (
    <div className="sc-body">
      <label className="sc-field">
        <span>想学什么场景</span>
        <textarea
          className="sc-input"
          rows={3}
          placeholder="用一句话说明，例如：我想学会在星巴克点咖啡 / 前端面试常用词"
          value={idea}
          onChange={(e) => setIdea(e.target.value)}
        />
      </label>

      <div className="sc-row">
        <span className="sc-label">难度</span>
        <div className="seg">
          <button className={level === '' ? 'active' : undefined} onClick={() => setLevel('')}>
            自动
          </button>
          {CEFR_LEVELS.map((l) => (
            <button key={l} className={level === l ? 'active' : undefined} onClick={() => setLevel(l)}>
              {l}
            </button>
          ))}
        </div>
      </div>

      <label className="sc-check">
        <input
          type="checkbox"
          checked={withExamples}
          onChange={(e) => setWithExamples(e.target.checked)}
        />
        为每个词生成场景例句（更慢，但更容易记住用法）
      </label>

      {start.isError && <div className="form-err">{start.error.message}</div>}

      <div className="overlay-foot">
        <span className="sc-hint">生成的词会先进草稿，确认后才进书架</span>
        <button
          className={`btn btn-primary${start.isPending ? ' loading' : ''}`}
          disabled={idea.trim().length < 2 || start.isPending}
          onClick={() => start.mutate()}
        >
          {start.isPending && <span className="spinner" />}
          开始生成
        </button>
      </div>
    </div>
  )
}

/* ---- 推荐场景批量 ---- */

function SeedPane({ onBatchDone }: { onBatchDone: () => void }) {
  const seedsQuery = useQuery({ queryKey: ['scenario-seeds'], queryFn: apiScenario.seeds })
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [jobs, setJobs] = useState<Array<{ key: string; title: string; job_id: string }>>([])

  const byCategory = useMemo(() => {
    const map = new Map<string, ScenarioSeed[]>()
    for (const seed of seedsQuery.data ?? []) {
      const bucket = map.get(seed.category)
      if (bucket) bucket.push(seed)
      else map.set(seed.category, [seed])
    }
    return map
  }, [seedsQuery.data])

  const run = useMutation({
    mutationFn: () => apiScenario.generateSeeds([...picked]),
    onSuccess: (data) => setJobs(data.jobs),
  })

  if (jobs.length > 0) {
    return <BatchProgress jobs={jobs} onDone={onBatchDone} />
  }

  return (
    <div className="sc-body">
      {seedsQuery.isPending && <div className="state-block"><div className="spinner" /></div>}
      {seedsQuery.isError && <div className="form-err">推荐场景加载失败</div>}

      <div className="sc-seeds">
        {[...byCategory.entries()].map(([category, seeds]) => (
          <section key={category}>
            <div className="sc-seed-cat">{category}</div>
            <div className="sc-seed-grid">
              {seeds.map((seed) => {
                const on = picked.has(seed.key)
                return (
                  <button
                    key={seed.key}
                    className={`sc-seed${on ? ' on' : ''}${seed.exists ? ' done' : ''}`}
                    disabled={seed.exists}
                    title={seed.exists ? '已生成过' : seed.description}
                    onClick={() =>
                      setPicked((prev) => {
                        const next = new Set(prev)
                        if (next.has(seed.key)) next.delete(seed.key)
                        else next.add(seed.key)
                        return next
                      })
                    }
                  >
                    <em>{seed.emoji}</em>
                    <b>{seed.title_zh}</b>
                    <i>{seed.cefr}</i>
                    {seed.exists && <IconCheck />}
                  </button>
                )
              })}
            </div>
          </section>
        ))}
      </div>

      {run.isError && <div className="form-err">{run.error.message}</div>}

      <div className="overlay-foot">
        <span className="sc-hint">
          已选 {picked.size} 个 · 每个约 30 秒，可关掉窗口后台继续
        </span>
        <button
          className={`btn btn-primary${run.isPending ? ' loading' : ''}`}
          disabled={picked.size === 0 || run.isPending}
          onClick={() => run.mutate()}
        >
          {run.isPending && <span className="spinner" />}
          生成 {picked.size} 个
        </button>
      </div>
    </div>
  )
}

/* ---- 进度 ---- */

function useJobPolling(jobId: string | null): ScenarioJob | null {
  const { data } = useQuery({
    queryKey: ['scenario-job', jobId],
    queryFn: () => apiScenario.job(jobId as string),
    enabled: jobId !== null,
    // 跑完就停轮询，避免任务结束后继续打接口
    refetchInterval: (q) => (q.state.data?.status === 'running' ? POLL_MS : false),
    // 生成要跑几十秒，用户切走再回来必须看到最新阶段；
    // 默认行为是页面不可见即暂停轮询，会停在"排队中"
    refetchIntervalInBackground: true,
  })
  return data ?? null
}

function JobProgress({ job, onRetry }: { job: ScenarioJob | null; onRetry: () => void }) {
  const stageIndex = job ? SCENARIO_STAGES.indexOf(job.stage) : 0
  const pct =
    job?.status === 'done'
      ? 100
      : Math.max(0, Math.round(((stageIndex + 1) / SCENARIO_STAGES.length) * 100))
  const counts = job?.counts ?? {}

  return (
    <div className="sc-body">
      <div className="sc-progress">
        <div className="sc-progress-head">
          <b>{job?.stage_label ?? '排队中'}</b>
          <span>{job?.detail ?? ''}</span>
        </div>
        <div className="sc-progress-bar">
          <i className={job?.status === 'failed' ? 'err' : undefined} style={{ width: `${pct}%` }} />
        </div>
        <div className="sc-progress-counts">
          {counts.rounds ? <span>第 {counts.rounds} 轮</span> : null}
          {counts.candidates ? <span>候选 {counts.candidates}</span> : null}
          {counts.kept ? <span>保留 {counts.kept}</span> : null}
          {counts.dropped ? <span>剔除 {counts.dropped}</span> : null}
          {counts.examples ? <span>例句 {counts.examples}</span> : null}
        </div>
      </div>

      {job?.status === 'failed' && (
        <>
          <div className="form-err">{job.error ?? job.detail}</div>
          <div className="overlay-foot">
            <button className="btn" onClick={onRetry}>
              重新填写
            </button>
          </div>
        </>
      )}
    </div>
  )
}

function BatchProgress({
  jobs,
  onDone,
}: {
  jobs: Array<{ key: string; title: string; job_id: string }>
  onDone: () => void
}) {
  const [states, setStates] = useState<Record<string, ScenarioJob | null>>({})

  useEffect(() => {
    let alive = true
    const tick = async () => {
      const entries = await Promise.all(
        jobs.map(async (j) => {
          try {
            return [j.job_id, await apiScenario.job(j.job_id)] as const
          } catch {
            return [j.job_id, null] as const
          }
        }),
      )
      if (!alive) return
      const next = Object.fromEntries(entries)
      setStates(next)
      const running = entries.some(([, s]) => s?.status === 'running')
      if (running) setTimeout(() => void tick(), POLL_MS)
      else onDone()
    }
    void tick()
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobs])

  const done = jobs.filter((j) => states[j.job_id]?.status === 'done').length
  const failed = jobs.filter((j) => states[j.job_id]?.status === 'failed').length

  return (
    <div className="sc-body">
      <div className="sc-progress-head">
        <b>
          批量生成 {done + failed}/{jobs.length}
        </b>
        <span>{failed > 0 ? `${failed} 个失败` : '进行中'}</span>
      </div>
      <div className="sc-batch">
        {jobs.map((j) => {
          const state = states[j.job_id]
          return (
            <div className={`sc-batch-row ${state?.status ?? 'running'}`} key={j.job_id}>
              <span className="sc-batch-title">{j.title}</span>
              <span className="sc-batch-stage">
                {state?.status === 'done'
                  ? `${state.counts.kept ?? 0} 词`
                  : state?.status === 'failed'
                    ? (state.error ?? '失败')
                    : (state?.stage_label ?? '排队中')}
              </span>
            </div>
          )
        })}
      </div>
    </div>
  )
}
