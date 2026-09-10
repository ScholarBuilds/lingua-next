/* 场景网格：一本里有哪些场景、各自学到哪一步。

   浏览页与自测页共用同一份进度显示——两处各画一套的话，同一个场景在两个
   界面上会说两个数（上一版就是：浏览页的药丸条显示「入册数」、自测页显示
   「学完数」，用户没法判断哪个是真的）。

   > [!info] 两条进度是两件事
   >
   > `learned` 是**入册**（词进了生词本），`passed` 是**通过自测**。
   > 「学会」的口径是后者。两条叠着画：浅色打底是入册，深色实心是通过。
   >
   > 场景 60 词里 59 个通过、1 个没过时，显示的是「59/60 已通过」，
   > 不是「场景未通过」——AND 门只用来点那个「已学会」的勾，
   > 不能让一个词把整场景的进度显示成归零。 */

import { IconCheck } from '../../components/icons'
import type { DeckGroup } from '../../lib/api-deck'

/* 轨别决定这一组该用哪种记法：具象靠画面、词根靠拆词、抽象靠归类 */
export const TRACK_LABEL: Record<string, string> = {
  scene: '场景',
  family: '词根',
  theme: '主题',
}

/* 轨别 → 类名用显式映射，不要 `t-${track}` 模板拼。
   模板里的兜底字面量 'scene' 会被 check-css 的静态解析当成类名读出来，
   而 `.scene` 在 app.css 里已经是场景对话页的右栏（还带 overflow-y: auto）——
   撞名不报错、只是样式莫名其妙，正是守卫要拦的那类。 */
export const TRACK_CLASS: Record<string, string> = {
  scene: 't-scene',
  family: 't-family',
  theme: 't-theme',
}

export const TRACK_HINT: Record<string, string> = {
  scene: '具象场景：靠画面记',
  family: '词根词族：靠拆词记',
  theme: '抽象主题：靠归类记',
}

export interface SceneGridProps {
  scenes: DeckGroup[]
  /** 当前选中的场景，用于高亮；不传则都不高亮 */
  active?: string | null
  onPick: (key: string) => void
}

/** 这一本的总进度：几个场景全过了、多少词过了。 */
export function sceneTotals(scenes: DeckGroup[]): {
  total: number
  passed: number
  doneScenes: number
} {
  return {
    total: scenes.reduce((n, g) => n + g.count, 0),
    passed: scenes.reduce((n, g) => n + (g.passed ?? 0), 0),
    doneScenes: scenes.filter((g) => g.count > 0 && (g.passed ?? 0) >= g.count).length,
  }
}

export function SceneGrid({ scenes, active, onPick }: SceneGridProps) {
  return (
    <div className="gdr-scenes">
      {scenes.map((g) => {
        const passed = g.passed ?? 0
        const learned = g.learned ?? 0
        const done = g.count > 0 && passed >= g.count
        const pct = (n: number) => (g.count ? (n / g.count) * 100 : 0)
        return (
          <button
            key={g.key}
            className={`gdr-scene-card${done ? ' done' : ''}${active === g.key ? ' active' : ''}`}
            title={g.root ? `词根 ${g.root}` : TRACK_HINT[g.track ?? 'scene']}
            onClick={() => onPick(g.key)}
          >
            <span className="gdr-scene-name">
              {g.label}
              {done && <IconCheck />}
            </span>
            <span className={`gdr-track ${TRACK_CLASS[g.track ?? 'scene']}`}>
              {TRACK_LABEL[g.track ?? 'scene']}
            </span>
            {g.root && <span className="gdr-root">{g.root}</span>}
            <span className="gdr-scene-n">
              {passed}/{g.count} 已学会
            </span>
            {/* 两条进度叠着画：浅色是入册，深色是通过自测 */}
            <span className="gdr-scene-bar">
              <i className="soft" style={{ width: `${pct(learned)}%` }} />
              <i className="hard" style={{ width: `${pct(passed)}%` }} />
            </span>
          </button>
        )
      })}
    </div>
  )
}
