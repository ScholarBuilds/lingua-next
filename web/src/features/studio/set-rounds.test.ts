/* 跨轮反问的 id 归并（模块 17）。
 *
   实测抓到的坑：模型每一轮都从 `q1` 编起，前端按 id 去重「追加新问题」时，
   第二轮四个**全新**问题会被整批当成重复丢掉——接口 200、内容也对，
   界面上按了「再问我几个」什么都不发生。这与后端那条"more 轮不许回够了"
   是同一个失败面的两半，只修一半等于没修。

   这里测的是归并规则本身，不拖 React 进来（本仓 vitest 跑在 node，没有 jsdom）。 */

import { describe, expect, it } from 'vitest'

interface Q { id: string; title: string }

/** 与 SetPlanDialog 的 ask.onSuccess 同一套规则 */
function merge(prev: Q[], incoming: Q[], round: number): Q[] {
  const seen = new Set(prev.map((p) => p.id))
  const next: Q[] = []
  for (const item of incoming) {
    const id = `r${round}:${item.id}`
    if (seen.has(id)) continue
    seen.add(id)
    next.push({ ...item, id })
  }
  return [...prev, ...next]
}

const q = (id: string, title = id): Q => ({ id, title })

describe('跨轮反问的 id 归并', () => {
  it('第二轮复用 q1/q2 时不会被当成重复丢掉', () => {
    const first = merge([], [q('q1', '整体气质'), q('q2', '页面范围')], 1)
    const second = merge(first, [q('q1', '版式结构'), q('q2', '状态与边界')], 2)
    expect(second).toHaveLength(4)
    expect(second.map((x) => x.title)).toEqual(['整体气质', '页面范围', '版式结构', '状态与边界'])
  })

  it('同一轮内真正重复的仍然去掉', () => {
    const got = merge([], [q('q1'), q('q1'), q('q2')], 1)
    expect(got.map((x) => x.id)).toEqual(['r1:q1', 'r1:q2'])
  })

  it('id 全局唯一——它是 answers / skipped 的索引键，撞了就会串答案', () => {
    let all: Q[] = []
    for (let round = 1; round <= 4; round += 1) {
      all = merge(all, [q('q1'), q('q2'), q('q3')], round)
    }
    expect(all).toHaveLength(12)
    expect(new Set(all.map((x) => x.id)).size).toBe(12)
  })
})
