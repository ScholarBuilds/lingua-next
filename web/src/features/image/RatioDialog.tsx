/* 画幅与分辨率选择器（模块 16 FR-432）。

   用户不填像素，只选「画幅 + 分辨率档」，具体尺寸由后端档位表换算。原因写在
   `server/domain/image_sizes.py`：上游不按请求尺寸出图（实测请求 1536x608 返回
   1994x789），让用户精确填一个不被遵守的数字是幻觉。

   这里只展示后端 catalog.sizes 给得出的东西（BR-110）：请求尺寸来自 `sizes`，
   实测尺寸来自 `measured`（没标定就没有，绝不拿请求值冒充实测），实验性标记来自
   `experimental`。没有一个数字是前端算出来糊在 UI 上的。 */

import { Check, FlaskConical, Lock, Ruler, Wand2 } from '@/components/NexusIcon'
import { useEffect, useMemo, useRef, useState } from 'react'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import type { RatioOption, SizeTier } from '@/lib/api-image'

import './RatioDialog.css'

/* 预览矩形用「等面积」缩放：八个框墨量一致，宽的必然扁、窄的必然高，
   胖瘦成为画面里唯一变化的量，横竖一眼可辨。
   换成等长边则 1:1 的面积会比 2.5:1 大一倍多，比较的就成了大小而不是画幅。 */
const PREVIEW_AREA = 5600

/* 上游标注的实验性分辨率门槛，与 server/domain/image_prompts.py 的
   SAFE_MAX_PIXELS 同源。只用于把提示文案写准，判定仍以后端返回的 experimental 为准。 */
const SAFE_EDGE_TEXT = '2560 × 1440'
const SAFE_MP_TEXT = '3.7'

interface PreviewBox {
  w: number
  h: number
}

/** 宽高比 → 等面积预览框的像素尺寸 */
function previewBox(value: number): PreviewBox {
  const ratio = Number.isFinite(value) && value > 0 ? value : 1
  return {
    w: Math.round(Math.sqrt(PREVIEW_AREA * ratio)),
    h: Math.round(Math.sqrt(PREVIEW_AREA / ratio)),
  }
}

function parseSize(size: string | undefined): [number, number] | null {
  if (size === undefined || size === '') return null
  const parts = size.split('x')
  if (parts.length !== 2) return null
  const w = Number(parts[0])
  const h = Number(parts[1])
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return null
  return [w, h]
}

/** "1536x608" → "1536 × 608"。解析不出来就显示占位符，不编数字 */
function showSize(size: string | undefined): string {
  const wh = parseSize(size)
  return wh === null ? '—' : `${wh[0]} × ${wh[1]}`
}

function megaPixels(size: string | undefined): string {
  const wh = parseSize(size)
  return wh === null ? '' : ((wh[0] * wh[1]) / 1_000_000).toFixed(1)
}

interface RatioView {
  option: RatioOption
  /** 当前档位的请求尺寸 */
  requested: string | undefined
  /** 当前档位的实测返回尺寸，未标定为 undefined */
  measured: string | undefined
  experimental: boolean
  box: PreviewBox
}

/** 卡片内容。锁定态与可选态共用一份，避免两处 JSX 各自漂移 */
function RatioCardBody({ view, selected }: { view: RatioView; selected: boolean }): JSX.Element {
  const { option, requested, measured, experimental, box } = view
  return (
    <>
      <span className="rtd-stage">
        <span className="rtd-rect" style={{ width: `${box.w}px`, height: `${box.h}px` }}>
          <span className="rtd-rect-key">{option.key}</span>
        </span>
      </span>

      <span className="rtd-name">
        <span className="rtd-name-text">{option.label}</span>
        {selected ? <Check className="rtd-tick" aria-hidden /> : null}
      </span>

      {measured === undefined ? (
        <span className="rtd-px">
          <span className="rtd-px-main">{showSize(requested)}</span>
          <span className="rtd-px-tag">请求</span>
        </span>
      ) : (
        <span className="rtd-px">
          <span className="rtd-px-main">{showSize(measured)}</span>
          <span className="rtd-chip rtd-chip-ok">实测</span>
          <span className="rtd-px-sub">请求 {showSize(requested)}</span>
        </span>
      )}

      <span className="rtd-flags">
        {experimental ? (
          <span
            className="rtd-chip rtd-chip-exp"
            title={`${showSize(requested)}（${megaPixels(requested)} MP）超过上游标注的 ${SAFE_EDGE_TEXT}（${SAFE_MP_TEXT} MP）`}
          >
            <FlaskConical aria-hidden />
            实验性
          </span>
        ) : null}
      </span>

      <span className="rtd-hint">{option.hint}</span>
    </>
  )
}

export function RatioDialog({
  open,
  ratios,
  tiers,
  tiersEffective = null,
  ratio,
  pickedRatio: aiRatio = null,
  tier,
  locked,
  onPick,
  onClose,
}: {
  open: boolean
  ratios: RatioOption[]
  tiers: SizeTier[]
  /** 标定结论：换档位到底改不改像素。null=没标定过；false=实测证明不起作用 */
  tiersEffective?: boolean | null
  /** null = 不指定，交给立意按画面内容挑 */
  ratio: string | null
  /** 立意最近一次挑中的画幅，只用于在「不指定」那张卡上说清它选了什么 */
  pickedRatio?: string | null
  tier: string
  locked: string | null
  onPick: (ratio: string | null, tier: string) => void
  onClose: () => void
}): JSX.Element | null {
  const [pickedRatio, setPickedRatio] = useState<string | null>(locked ?? ratio)
  const [pickedTier, setPickedTier] = useState<string>(tier)
  const wasOpen = useRef(false)

  // 只在「关 → 开」这一次同步外部状态。挂在依赖数组上逐次重置的话，
  // 父组件每渲染一次传进来的新数组都会把用户刚点的选择冲掉
  useEffect(() => {
    if (open && !wasOpen.current) {
      setPickedRatio(locked ?? ratio)
      setPickedTier(tier)
    }
    wasOpen.current = open
  }, [open, locked, ratio, tier])

  // 档位表还没到、或外部给了个表里没有的档时兜到第一档，避免整屏像素显示成「—」
  const activeTier = tiers.some((t) => t.key === pickedTier)
    ? pickedTier
    : (tiers[0]?.key ?? pickedTier)

  const views = useMemo<RatioView[]>(
    () =>
      ratios.map((option) => ({
        option,
        requested: option.sizes[activeTier],
        measured: option.measured[activeTier],
        experimental: option.experimental[activeTier] === true,
        box: previewBox(option.value),
      })),
    [ratios, activeTier],
  )

  // 锁定时只留那一个画幅；档位表里查不到锁定值时给空列表，下面走缺失分支
  const visible = useMemo(
    () => (locked === null ? views : views.filter((v) => v.option.key === locked)),
    [views, locked],
  )

  const effectiveRatio = locked ?? pickedRatio
  const current = views.find((v) => v.option.key === effectiveRatio) ?? null
  const currentTier = tiers.find((t) => t.key === activeTier) ?? null
  const experimentalCount = visible.filter((v) => v.experimental).length

  function applyPick(): void {
    // effectiveRatio 为 null 就是「不指定」——它是一个正当选择，不是「还没选」
    onPick(effectiveRatio, activeTier)
    onClose()
  }

  if (!open) return null

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) onClose()
      }}
    >
      <DialogContent className="rtd-modal">
        <DialogHeader className="rtd-head">
          <DialogTitle className="rtd-title">
            <Ruler aria-hidden />
            画幅与分辨率
          </DialogTitle>
          <DialogDescription className="rtd-sub">
            下面每个框按真实宽高比缩放、面积相同——只有胖瘦在变，横竖一眼可辨。
          </DialogDescription>
        </DialogHeader>

        <div className="rtd-body">
          <fieldset className="rtd-tier-block">
            <legend className="rtd-legend">分辨率档</legend>
            {/* 标定说档位不起作用就照实说。留着可选是因为换个供应商可能就认了，
                但不能让人对着一个选了没用的控件白挑（不伪造） */}
            {tiersEffective === false && (
              <p className="rtd-inert">
                实测：当前这个网关<b>不认分辨率档</b>——三档返回的像素量一模一样（约 1.6MP），
                只有画幅比例真正生效。档位留着是给将来换供应商用的。
              </p>
            )}
            <div className="rtd-tiers">
              {tiers.map((t) => (
                <label key={t.key} className={`rtd-tier${t.key === activeTier ? ' on' : ''}`}>
                  <input
                    className="rtd-input"
                    type="radio"
                    name="rtd-tier"
                    value={t.key}
                    checked={t.key === activeTier}
                    onChange={() => setPickedTier(t.key)}
                  />
                  <span className="rtd-tier-text">{t.label}</span>
                </label>
              ))}
            </div>
            {currentTier !== null && currentTier.hint !== '' ? (
              <p className="rtd-tier-hint">{currentTier.hint}</p>
            ) : null}
            {experimentalCount > 0 ? (
              <p className="rtd-exp-note">
                <FlaskConical aria-hidden />
                <span>
                  {locked === null
                    ? `本档有 ${experimentalCount} 个画幅超过上游标注的 ${SAFE_EDGE_TEXT}，已标「实验性」。`
                    : `本档超过上游标注的 ${SAFE_EDGE_TEXT}，已标「实验性」。`}
                  照常能出图，只是上游没保证这个尺寸下的质量。
                </span>
              </p>
            ) : null}
          </fieldset>

          <fieldset className="rtd-ratio-block">
            <legend className="rtd-legend">画幅</legend>

            {locked !== null ? (
              <p className="rtd-lock-note">
                <Lock aria-hidden />
                <span>
                  画幅锁定为 <b>{locked}</b>：它由展示这张图的界面决定，不是个人偏好，
                  换了就放不进那个位置。分辨率档仍可自由选。
                </span>
              </p>
            ) : null}

            {locked === null && (
              <button
                type="button"
                className={`rtd-auto${pickedRatio === null ? ' on' : ''}`}
                aria-current={pickedRatio === null ? 'true' : undefined}
                onClick={() => setPickedRatio(null)}
              >
                <Wand2 className="rtd-auto-icon" aria-hidden />
                <span className="rtd-auto-text">
                  <b>不指定，让 AI 按想法挑</b>
                  <em>
                    画幅是画面的一部分：手机整屏就是竖的、横幅就是宽的、头像就是方的。
                    写提示词那一步会顺手把它定了。
                    {aiRatio ? ` 上次挑的是 ${aiRatio}。` : ''}
                  </em>
                </span>
                {pickedRatio === null && <Check className="rtd-auto-check" aria-hidden />}
              </button>
            )}

            {visible.length === 0 ? (
              <p className="rtd-empty">
                {locked === null
                  ? '后端没有返回可选画幅。'
                  : `后端档位表里没有 ${locked} 这个画幅，无法展示预览与像素。`}
              </p>
            ) : (
              <div className={`rtd-grid${locked === null ? '' : ' rtd-grid-solo'}`}>
                {visible.map((v) => {
                  const selected = v.option.key === effectiveRatio
                  if (locked !== null) {
                    return (
                      <div key={v.option.key} className="rtd-card on rtd-card-static">
                        <RatioCardBody view={v} selected={false} />
                      </div>
                    )
                  }
                  return (
                    <label key={v.option.key} className={`rtd-card${selected ? ' on' : ''}`}>
                      <input
                        className="rtd-input"
                        type="radio"
                        name="rtd-ratio"
                        value={v.option.key}
                        checked={selected}
                        onChange={() => setPickedRatio(v.option.key)}
                      />
                      <RatioCardBody view={v} selected={selected} />
                    </label>
                  )
                })}
              </div>
            )}
          </fieldset>
        </div>

        <div className="rtd-foot">
          <div className="rtd-summary">
            {current === null ? (
              <span className="rtd-summary-empty">
                {effectiveRatio === null
                  ? '还没选画幅——保持现状则按应用的默认画幅出图。'
                  : `${effectiveRatio} · ${currentTier?.label ?? activeTier} · 该画幅不在后端档位表里，像素未知`}
              </span>
            ) : (
              <>
                <b className="rtd-summary-name">{current.option.label}</b>
                <span className="rtd-num">{current.option.key}</span>
                <span className="rtd-dot" aria-hidden />
                <span>{currentTier?.label ?? activeTier}</span>
                <span className="rtd-dot" aria-hidden />
                <span className="rtd-num">请求 {showSize(current.requested)}</span>
                {current.measured === undefined ? null : (
                  <>
                    <span className="rtd-dot" aria-hidden />
                    <span className="rtd-num rtd-num-ok">实测 {showSize(current.measured)}</span>
                  </>
                )}
                {current.experimental ? (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button type="button" className="rtd-chip rtd-chip-exp rtd-chip-btn">
                        <FlaskConical aria-hidden />
                        实验性
                      </button>
                    </TooltipTrigger>
                    <TooltipContent className="rtd-tip">
                      {`${showSize(current.requested)}（${megaPixels(current.requested)} MP）超过上游标注的 ${SAFE_EDGE_TEXT}（${SAFE_MP_TEXT} MP）。不拦你下单，上游只是没保证这个尺寸下的质量。`}
                    </TooltipContent>
                  </Tooltip>
                ) : null}
              </>
            )}
          </div>

          <div className="rtd-actions">
            <Button variant="ghost" size="sm" onClick={onClose}>
              取消
            </Button>
            <Button size="sm" onClick={applyPick}>
              使用这个尺寸
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
