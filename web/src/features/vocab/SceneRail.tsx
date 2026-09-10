/* 考纲本浏览页的场景选择器：一行常驻的快捷药丸 + 一个可搜索的全场景面板。

   > [!info] 它是筛选器，不是入口
   >
   > 更早一版做成整屏的场景卡网格，点进去把网格换掉、再给一条「← 所有场景」退回去，
   > 读起来像「进了另一个页面」，而这里要的只是换一下下面看哪批词。
   > 卡片网格（`SceneGrid`）没删，它在场景速记里仍是主入口——那一屏是导航不是筛选。

   > [!danger] 「展开全部」这条路走不通，别再加回来
   >
   > 上一版是三行药丸 + 一个「展开全部 67 个」。两头都不讨好：
   > 折着时 67 个里只露得出约 30 个，想找的多半不在其中；展开后是七八行药丸，
   > **把下面的词卡整片推下屏**——用户点一下筛选器，代价是丢掉正在看的内容。
   > 高考 67 个场景，GRE 143 个，行数还会继续涨。
   >
   > 现在换成：常驻一行只放「全部」+ 少数几个**在学的**场景（点开过或测过的，
   > 那才是会反复回去的那几个），其余全部收进一个可搜索的浮层面板。
   > 面板是浮层，开合不改变页面布局，也就不存在「一展开内容全跑了」。
   > 67 个还是 143 个都是同一个交互，不随数量退化。 */

import { useMemo, useState } from 'react'

import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'

import { IconCheck, IconChevronDown } from '../../components/icons'
import type { DeckGroup } from '../../lib/api-deck'
import { TRACK_CLASS, TRACK_HINT, TRACK_LABEL } from './SceneGrid'

/** 常驻行最多放几个快捷场景。再多就又变成一堵墙了 */
const QUICK_MAX = 6

export interface SceneRailProps {
  scenes: DeckGroup[]
  /** 当前选中的场景，空串表示「全部」 */
  active: string
  total: number
  onPick: (key: string) => void
}

function progressOf(g: DeckGroup): { passed: number; done: boolean; pct: number } {
  const passed = g.passed ?? 0
  return {
    passed,
    done: g.count > 0 && passed >= g.count,
    pct: g.count ? (passed / g.count) * 100 : 0,
  }
}

function ScenePill({
  g,
  active,
  onPick,
}: {
  g: DeckGroup
  active: boolean
  onPick: () => void
}) {
  const { passed, done, pct } = progressOf(g)
  return (
    <button
      className={`dd-scenes-pill${done ? ' done' : ''}${active ? ' active' : ''}`}
      style={{ '--pct': `${pct}%` } as React.CSSProperties}
      title={
        g.root ? `词根 ${g.root} · ${TRACK_LABEL[g.track ?? 'scene']}` : TRACK_HINT[g.track ?? 'scene']
      }
      onClick={onPick}
    >
      {done ? <IconCheck /> : <em className={TRACK_CLASS[g.track ?? 'scene']} />}
      {g.label}
      <i>
        {passed}/{g.count}
      </i>
    </button>
  )
}

export function SceneRail({ scenes, active, total, onPick }: SceneRailProps) {
  const [open, setOpen] = useState(false)

  const doneCount = scenes.filter((g) => progressOf(g).done).length

  /* 常驻行放哪几个：动过的排前面（有入册或有通过），其次按词数。
     当前选中的无条件在列——否则从面板里挑一个冷门场景，
     常驻行上看不见它，用户不知道自己正筛在哪。 */
  const quick = useMemo(() => {
    /* 「在学」只认 passed（真通过了自测），不认 learned（入册）。
       learned 是「词进了生词本」，随便翻几页就一片非零——拿它当判据，
       排序会整个退化成按词数倒序，常驻行永远是那几个最大的场景，
       而用户正在啃的那个小场景反倒排不进来（实测：67 个里 6 个位置
       全被 103/97/95/93/88/83 占满）。 */
    const touched = (g: DeckGroup) => (g.passed ?? 0) > 0
    const ranked = [...scenes].sort((a, b) => {
      const t = Number(touched(b)) - Number(touched(a))
      return t !== 0 ? t : b.count - a.count
    })
    const picked = ranked.slice(0, QUICK_MAX)
    if (active !== '' && !picked.some((g) => g.key === active)) {
      const cur = scenes.find((g) => g.key === active)
      if (cur !== undefined) picked.splice(QUICK_MAX - 1, 1, cur)
    }
    return picked
  }, [scenes, active])

  /** 面板里按轨别分组：具象场景 / 词根词族 / 抽象主题，三类记法不同 */
  const grouped = useMemo(() => {
    const by = new Map<string, DeckGroup[]>()
    for (const g of scenes) {
      const t = g.track ?? 'scene'
      const list = by.get(t)
      if (list) list.push(g)
      else by.set(t, [g])
    }
    return [...by.entries()].sort((a, b) => b[1].length - a[1].length)
  }, [scenes])

  const activeLabel = scenes.find((g) => g.key === active)?.label

  return (
    <div className="dd-scenes">
      <div className="dd-scenes-rail">
        <button
          className={`dd-scenes-pill all${active === '' ? ' active' : ''}`}
          onClick={() => onPick('')}
        >
          全部
          <i>{total}</i>
        </button>

        {quick.map((g) => (
          <ScenePill
            key={g.key}
            g={g}
            active={active === g.key}
            onPick={() => onPick(active === g.key ? '' : g.key)}
          />
        ))}

        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <button className="dd-scenes-more" title="搜索或浏览全部场景">
              {activeLabel !== undefined && !quick.some((g) => g.key === active)
                ? activeLabel
                : '全部场景'}
              <i>{scenes.length}</i>
              <IconChevronDown />
            </button>
          </PopoverTrigger>
          <PopoverContent className="w-[340px] p-0" align="start">
            <Command>
              <CommandInput placeholder="搜场景…" />
              <CommandList className="max-h-[320px]">
                <CommandEmpty>没有匹配的场景</CommandEmpty>
                {grouped.map(([track, list]) => (
                  <CommandGroup key={track} heading={`${TRACK_LABEL[track]}（${list.length}）`}>
                    {list.map((g) => {
                      const { passed, done } = progressOf(g)
                      return (
                        <CommandItem
                          key={g.key}
                          value={`${g.label} ${g.root ?? ''}`}
                          onSelect={() => {
                            onPick(active === g.key ? '' : g.key)
                            setOpen(false)
                          }}
                        >
                          <span className="dd-scenes-opt">
                            {done ? <IconCheck /> : <em className={TRACK_CLASS[track]} />}
                            <span className="dd-scenes-opt-name">{g.label}</span>
                            <span className="dd-scenes-opt-n">
                              {passed}/{g.count}
                            </span>
                          </span>
                        </CommandItem>
                      )
                    })}
                  </CommandGroup>
                ))}
              </CommandList>
            </Command>
          </PopoverContent>
        </Popover>

        <span className="dd-scenes-sum">
          {scenes.length} 个场景{doneCount > 0 && ` · ${doneCount} 个已学会`}
        </span>
      </div>
    </div>
  )
}
