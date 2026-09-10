/* 尺寸选择器（模块 17）。结构抄蓝本 Infinite-Canvas 的 `renderSizePickerControl`
   （static/js/smart-canvas.js:3343-3389）：一个胶囊触发器 + 三档 tab 的弹层。

   | 档 | 内容 | 发给服务端 |
   | --- | --- | --- |
   | 自动 | 一句说明 | `"auto"`——不传 size、不补画布句，由模型自己判断 |
   | 系统参数 | 两列：比例 × 档位 | 该比例在该档位下的像素（`1024x1536`） |
   | 自定义 | 宽 × 高 | 原样 |

   蓝本还有一条 `allowAuto = … && isGptImageAutoSizeModel(model)`：自动档只在
   支持自动尺寸的模型上可用。本项目网关上的 gpt-image 系列都支持，所以不做这层
   门禁——真遇到不支持的模型时上游会照默认尺寸出图，不会报错。 */

import * as React from 'react'
import { ScanLine } from '@/components/NexusIcon'

import { cn } from '@/lib/utils'
import { PopoverPicker } from '@/components/ui/picker'

/** 「明确不指定画幅」。与服务端 `image_prompts.AUTO_SIZE` 同值——
 *  两边各写一个字面量的话，改一次要改两处，而漏改的那一处会静默回落默认。 */
export const AUTO_SIZE = 'auto'

/** 比例表抄蓝本同一份（smart-canvas.js:3355-3359），顺序也一样：
 *  方图在最前，然后横竖成对，最后是极端比例。 */
const RATIOS: { key: string; label: string; hint: string; w: number; h: number }[] = [
  { key: '1:1', label: '1:1', hint: '正方形', w: 1, h: 1 },
  { key: '2:3', label: '2:3', hint: '竖图', w: 2, h: 3 },
  { key: '3:2', label: '3:2', hint: '横图', w: 3, h: 2 },
  { key: '3:4', label: '3:4', hint: '竖图', w: 3, h: 4 },
  { key: '4:3', label: '4:3', hint: '横图', w: 4, h: 3 },
  { key: '9:16', label: '9:16', hint: '竖屏', w: 9, h: 16 },
  { key: '16:9', label: '16:9', hint: '宽屏', w: 16, h: 9 },
  { key: '21:9', label: '21:9', hint: '超宽', w: 21, h: 9 },
  { key: '9:21', label: '9:21', hint: '超竖', w: 9, h: 21 },
]

/** 档位。长边目标像素——服务端的硬约束是 16 的倍数、单边 ≤3840、比例 1:3~3:1 */
const TIERS: { key: string; label: string; edge: number }[] = [
  { key: '1k', label: '1K', edge: 1024 },
  { key: '2k', label: '2K', edge: 2048 },
  { key: '4k', label: '4K', edge: 3840 },
]

const STEP = 16
const MAX_EDGE = 3840

/** 比例 + 档位 → 具体尺寸。与服务端 `validate_size` 同一套硬约束：
 *  16 的倍数、单边不超 3840。算不出合法值就退回 null 由调用方兜底。 */
export function sizeFor(ratioKey: string, tierKey: string): string | null {
  const r = RATIOS.find((x) => x.key === ratioKey)
  const t = TIERS.find((x) => x.key === tierKey)
  if (r === undefined || t === undefined) return null
  const long = Math.min(t.edge, MAX_EDGE)
  const short = Math.round((long * Math.min(r.w, r.h)) / Math.max(r.w, r.h))
  const [w, h] = r.w >= r.h ? [long, short] : [short, long]
  const snap = (n: number): number =>
    Math.max(STEP, Math.min(MAX_EDGE, Math.round(n / STEP) * STEP))
  return `${snap(w)}x${snap(h)}`
}

/** 反查：一个尺寸串是哪个比例 + 哪个档位。用来在弹层里高亮当前选中。
 *  查不到（自定义尺寸）返回 null。 */
export function matchPreset(size: string): { ratio: string; tier: string } | null {
  for (const r of RATIOS) {
    for (const t of TIERS) {
      if (sizeFor(r.key, t.key) === size) return { ratio: r.key, tier: t.key }
    }
  }
  return null
}

type Scope = 'auto' | 'preset' | 'custom'

function scopeOf(size: string): Scope {
  if (size === AUTO_SIZE || size.trim() === '') return 'auto'
  return matchPreset(size) === null ? 'custom' : 'preset'
}

/** 胶囊上显示什么。自动档只显示"自动"两个字（蓝本 `.auto-mode` 会把
 *  前缀标签和分隔点一起隐藏，同样的道理：没有值可分隔时标签是噪音）。 */
export function sizeLabel(size: string): string {
  if (size === AUTO_SIZE || size.trim() === '') return '画幅自动'
  const hit = matchPreset(size)
  return hit === null ? size : `${hit.ratio} · ${hit.tier.toUpperCase()}`
}

export function SizePicker({
  value,
  onChange,
  disabled,
}: {
  value: string
  onChange: (next: string) => void
  disabled?: boolean
}): React.ReactElement {
  const hit = matchPreset(value)
  /* 用户点了哪个 tab 是**他的意图**，不是值的属性。
     纯靠 `scopeOf(value)` 反推会出这种事：点「自定义」时默认填 1024×1024，
     而那恰好等于 `1:1 · 1K`，于是被认成 preset、tab 当场弹回去——
     实测点了自定义却落在系统参数。null = 还没手动切过，跟着值走。 */
  const [pickedScope, setPickedScope] = React.useState<Scope | null>(null)
  const scope = pickedScope ?? scopeOf(value)
  /* 切到"系统参数"时得有个起点。用当前值反查得到的，反查不到就用方图 1K——
     蓝本同款（currentRatio = settings.ratio || 'square'） */
  const [ratio, setRatio] = React.useState(hit?.ratio ?? '1:1')
  const [tier, setTier] = React.useState(hit?.tier ?? '1k')
  /* 自定义档的两个输入框是**本地草稿**：边打字边往上写的话，
     打到一半的 "10" 会被当成宽度 10 发出去（还会被 validate_size 拒） */
  const [customW, setCustomW] = React.useState('')
  const [customH, setCustomH] = React.useState('')

  /** 自己最后一次写出去的值。
   *
   *  用来区分"外部改的"与"自己改的"——只有前者该把手动选的 tab 重置掉。
   *  不区分的话在自定义档填一个恰好等于 preset 的值（1024×1024）会被弹回
   *  系统参数档，与那个刚修掉的 bug 是同一个，只是延后到填完才发作。 */
  const mine = React.useRef<string | null>(null)
  React.useEffect(() => {
    if (mine.current === value) return // 自己写的，tab 不动
    // 从外面换掉了（接了参考图、套了模板）：弹层不能停在与实际值无关的那一页
    setPickedScope(null)
  }, [value])

  React.useEffect(() => {
    if (hit !== null) {
      setRatio(hit.ratio)
      setTier(hit.tier)
      return
    }
    if (scope === 'custom') {
      const [w, h] = value.toLowerCase().split('x')
      setCustomW(w ?? '')
      setCustomH(h ?? '')
    }
  }, [value, scope, hit?.ratio, hit?.tier])

  const pickPreset = (nextRatio: string, nextTier: string): void => {
    setRatio(nextRatio)
    setTier(nextTier)
    const size = sizeFor(nextRatio, nextTier)
    if (size === null) return
    mine.current = size
    onChange(size)
  }

  /** 自定义尺寸哪里不合规。返回 null = 可以用。
   *
   *  与服务端 `validate_size` 同一套判据。**不做静默纠正**：把 1000 改成 1008
   *  之后产物指纹与用户填的值对不上，下次重跑会莫名不命中缓存。 */
  const checkCustom = (w: string, h: string): string | null => {
    const nw = Number(w)
    const nh = Number(h)
    if (!Number.isFinite(nw) || !Number.isFinite(nh) || nw <= 0 || nh <= 0) return null // 还没填完
    if (nw % STEP !== 0 || nh % STEP !== 0) return `宽高要是 ${STEP} 的倍数`
    if (Math.max(nw, nh) > MAX_EDGE) return `单边不能超过 ${MAX_EDGE}`
    const r = nw / nh
    if (r < 1 / 3 || r > 3) return '比例要在 1:3 与 3:1 之间'
    return null
  }
  const customError = scope === 'custom' ? checkCustom(customW, customH) : null

  const commitCustom = (w: string, h: string): void => {
    const nw = Number(w)
    const nh = Number(h)
    if (!Number.isFinite(nw) || !Number.isFinite(nh) || nw <= 0 || nh <= 0) return
    // 不合规就不往上写：写上去只会等到点出图才被服务端拒，那时弹窗早关了
    if (checkCustom(w, h) !== null) return
    const size = `${Math.round(nw)}x${Math.round(nh)}`
    mine.current = size
    onChange(size)
  }

  return (
    <PopoverPicker
      contentClassName="szp"
      trigger={
        <button type="button" className="ui-pill szp-pill" disabled={disabled} title="画幅">
          <ScanLine />
          {scope !== 'auto' && <span className="ui-pill-label">尺寸</span>}
          {scope !== 'auto' && <span className="ui-pill-dot" aria-hidden />}
          <span className="ui-pill-value">{sizeLabel(value)}</span>
        </button>
      }
    >
      <div className="szp-head">
        <span className="szp-title">尺寸选择</span>
        <div className="szp-scope">
          {(
            [
              ['auto', '自动'],
              ['preset', '系统参数'],
              ['custom', '自定义'],
            ] as const
          ).map(([key, text]) => (
            <button
              key={key}
              type="button"
              className={cn('szp-scope-btn', scope === key && 'szp-scope-on')}
              onClick={() => {
                setPickedScope(key)
                if (key === 'auto') {
                  mine.current = AUTO_SIZE
                  onChange(AUTO_SIZE)
                }
                else if (key === 'preset') pickPreset(ratio, tier)
                else if (customW !== '' && customH !== '') commitCustom(customW, customH)
                /* 切到自定义时**不预填**：填什么都是替用户做决定，
                   而且随手填的数很容易撞上某个 preset。空着让他自己填。 */
              }}
            >
              {text}
            </button>
          ))}
        </div>
      </div>

      {/* 「自动」档没有内容——选项本身就说明了一切。
          蓝本这里有一段"使用模型默认尺寸，或由支持自动尺寸的模型自行决定"，
          没抄：一个写着"自动"的档位再配一段解释"自动是什么意思"，
          是在替用户读界面。这是每天用几百次的工具，第二次之后解释全是噪音。 */}

      {scope === 'preset' && (
        <div className="szp-pane szp-preset">
          <div className="szp-list">
            {RATIOS.map((r) => (
              <button
                key={r.key}
                type="button"
                className={cn('szp-option', r.key === ratio && 'szp-option-on')}
                onClick={() => pickPreset(r.key, tier)}
              >
                <span>{r.label}</span>
                <small>{r.hint}</small>
              </button>
            ))}
          </div>
          <div className="szp-list">
            {TIERS.map((t) => (
              <button
                key={t.key}
                type="button"
                className={cn('szp-option', t.key === tier && 'szp-option-on')}
                onClick={() => pickPreset(ratio, t.key)}
              >
                <span>{t.label}</span>
                {/* 显示这一档在当前比例下的真实像素，与蓝本一致。
                    只写 1K/2K/4K 的话用户无从判断到底多大 */}
                <small>{sizeFor(ratio, t.key) ?? '—'}</small>
              </button>
            ))}
          </div>
        </div>
      )}

      {scope === 'custom' && (
        <div className="szp-pane szp-custom">
          <div className="szp-custom-row">
            {/* 约束（16 的倍数、≤3840）由控件自己表达，不写成一段小字：
                `step`/`min`/`max` 让上下箭头与浏览器校验直接按规则走。
                真填错了才出一行红字——错误信息不是 tip，它只在需要时出现。 */}
            <input
              type="number"
              step={STEP}
              min={STEP}
              max={MAX_EDGE}
              value={customW}
              placeholder="宽"
              aria-label="宽度"
              onChange={(e) => setCustomW(e.target.value)}
              onBlur={() => commitCustom(customW, customH)}
            />
            <span>×</span>
            <input
              type="number"
              step={STEP}
              min={STEP}
              max={MAX_EDGE}
              value={customH}
              placeholder="高"
              aria-label="高度"
              onChange={(e) => setCustomH(e.target.value)}
              onBlur={() => commitCustom(customW, customH)}
            />
          </div>
          {customError !== null && <p className="szp-custom-err">{customError}</p>}
        </div>
      )}
    </PopoverPicker>
  )
}
