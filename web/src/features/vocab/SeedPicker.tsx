/* 种子场景勾选（需求 01 v2 FR-246）：批量生成前必须能看见要生成什么、生成几个。

   上一版的「批量生成」按钮直接提交空 keys 当成"全都要"，一点跑掉 50 个本，
   全是待确认状态且不可撤销。批量且不可逆的操作不该一次点击就执行。 */

import { useMutation, useQuery } from '@tanstack/react-query'

import { Overlay } from '../../components/Overlay'
import { useMemo, useState } from 'react'

import { IconCheck, IconClose, IconSparkle } from '../../components/icons'
import { apiScenario } from '../../lib/api-deck'
import type { ScenarioSeed } from '../../lib/api-deck'

/** 单个场景实测约 30 秒（含例句）；不含例句约 20 秒 */
const SECONDS_EACH = 30
const SECONDS_EACH_NO_EG = 20

interface SeedPickerProps {
  onClose: () => void
  onStarted: (jobs: Array<{ key: string; title: string; job_id: string }>) => void
}

export function SeedPicker({ onClose, onStarted }: SeedPickerProps) {
  const seeds = useQuery({ queryKey: ['scenario-seeds'], queryFn: apiScenario.seeds })
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [withExamples, setWithExamples] = useState(true)
  const [needConfirm, setNeedConfirm] = useState(false)

  const byCategory = useMemo(() => {
    const map = new Map<string, ScenarioSeed[]>()
    for (const seed of seeds.data ?? []) {
      const bucket = map.get(seed.category)
      if (bucket) bucket.push(seed)
      else map.set(seed.category, [seed])
    }
    return map
  }, [seeds.data])

  const run = useMutation({
    mutationFn: () => apiScenario.generateSeeds([...picked], withExamples, needConfirm),
    onSuccess: (data) => onStarted(data.jobs),
  })

  const toggle = (key: string) =>
    setPicked((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })

  const toggleCategory = (items: ScenarioSeed[]) => {
    const usable = items.filter((s) => !s.exists).map((s) => s.key)
    const allOn = usable.every((k) => picked.has(k))
    setPicked((prev) => {
      const next = new Set(prev)
      for (const k of usable) {
        if (allOn) next.delete(k)
        else next.add(k)
      }
      return next
    })
  }

  const seconds = picked.size * (withExamples ? SECONDS_EACH : SECONDS_EACH_NO_EG)
  const minutes = Math.ceil(seconds / 60)

  return (
    <Overlay onClose={onClose} card="spk-card">
        <div className="overlay-head">
          <div className="overlay-title">
            <IconSparkle />
            批量生成场景本
          </div>
          <div style={{ flex: 1 }} />
          <button className="icon-btn" onClick={onClose} title="关闭">
            <IconClose />
          </button>
        </div>

        <div className="spk-note">
          勾选要生成的场景。每个场景会调用一次 AI 生成词表，生成后
          {needConfirm ? '停在待确认，需要你过目' : '直接入库进复习队列'}。
        </div>

        {seeds.isPending && <div className="state-block"><div className="spinner" /></div>}
        {seeds.isError && <div className="form-err">推荐场景加载失败</div>}

        <div className="spk-list">
          {[...byCategory.entries()].map(([category, items]) => {
            const usable = items.filter((s) => !s.exists)
            const on = usable.length > 0 && usable.every((s) => picked.has(s.key))
            return (
              <section key={category}>
                <div className="spk-cat">
                  <button className="spk-cat-all" onClick={() => toggleCategory(items)}>
                    <span className={`spk-box${on ? ' on' : ''}`} />
                    {category}
                  </button>
                  <span className="spk-cat-n">{usable.length} 个可生成</span>
                </div>
                <div className="spk-grid">
                  {items.map((seed) => {
                    const checked = picked.has(seed.key)
                    return (
                      <button
                        key={seed.key}
                        className={`spk-seed${checked ? ' on' : ''}${seed.exists ? ' done' : ''}`}
                        disabled={seed.exists}
                        title={seed.exists ? '已经生成过' : seed.description}
                        onClick={() => toggle(seed.key)}
                      >
                        <span className={`spk-box${checked ? ' on' : ''}`} />
                        <em>{seed.emoji}</em>
                        <b>{seed.title_zh}</b>
                        <i>{seed.cefr}</i>
                        {seed.exists && <IconCheck />}
                      </button>
                    )
                  })}
                </div>
              </section>
            )
          })}
        </div>

        <div className="spk-opts">
          <label>
            <input
              type="checkbox"
              checked={withExamples}
              onChange={(e) => setWithExamples(e.target.checked)}
            />
            为每个词生成场景例句（更慢但更好记）
          </label>
          <label>
            <input
              type="checkbox"
              checked={needConfirm}
              onChange={(e) => setNeedConfirm(e.target.checked)}
            />
            生成后由我确认（不勾则直接入库）
          </label>
        </div>

        {run.isError && <div className="form-err">{run.error.message}</div>}

        <div className="overlay-foot">
          {/* 批量且不可逆，代价必须先说清楚再让人点 */}
          <span className="spk-cost">
            {picked.size === 0
              ? '还没有勾选任何场景'
              : `将生成 ${picked.size} 个场景本 · 约 ${minutes} 分钟 · 消耗 ${picked.size * (withExamples ? 2 : 1)} 次 AI 调用`}
          </span>
          <button className="btn" onClick={onClose}>
            取消
          </button>
          <button
            className={`btn btn-primary${run.isPending ? ' loading' : ''}`}
            disabled={picked.size === 0 || run.isPending}
            onClick={() => run.mutate()}
          >
            {run.isPending && <span className="spinner" />}
            开始生成 {picked.size > 0 ? `（${picked.size}）` : ''}
          </button>
        </div>
      </Overlay>
  )
}
