/* 高级参数弹窗（模块 16 生图控制台）。类名前缀 imgadv-，全仓 grep 过，独占。

   两条贯穿全文件的规矩：
   1. 每个参数都要写清楚它到底改变了什么，英文枚举不直接摆给用户看；
   2. 不生效的控件一律禁用并说明原因，不让人调一个没有作用的滑块。 */

import type { ReactNode } from 'react'
import {
  FileImage,
  Gauge,
  Images,
  Info,
  Layers,
  Lock,
  RotateCcw,
  ShieldCheck,
  Shrink,
  TriangleAlert,
} from '@/components/NexusIcon'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Separator } from '@/components/ui/separator'
import { Slider } from '@/components/ui/slider'
import { Switch } from '@/components/ui/switch'

import './AdvancedDialog.css'

export interface AdvancedValue {
  quality: string
  count: number
  outputFormat: string | null
  background: string | null
  outputCompression: number | null
  moderation: string | null
}

interface OptionText {
  label: string
  desc: string
}

/* 质量档买的是算力不是像素，这三条描述都按这个口径写 */
const QUALITY_TEXT: Record<string, OptionText> = {
  low: { label: '低算力', desc: '模型少推理几轮，出得最快也最省钱。构图能看，细节和画面里的文字容易糊。' },
  medium: { label: '中算力', desc: '速度与细节的折中。看构图对不对、试提示词，这一档够用。' },
  high: { label: '高算力', desc: '模型多花算力推敲细节，画面里的文字和小物件更稳，同时最慢最贵。' },
}

const FORMAT_TEXT: Record<string, OptionText> = {
  png: { label: 'PNG · 无损', desc: '像素一个不改，体积最大。带 alpha 通道，透明底靠它。' },
  webp: { label: 'WebP · 有损可调', desc: '同样带 alpha 通道，体积比 PNG 小得多。个别老旧软件不认这个格式。' },
  jpeg: { label: 'JPEG · 有损可调', desc: '兼容性最好，哪都能打开。没有 alpha 通道，给不了透明底。' },
}

const BACKGROUND_TEXT: Record<string, OptionText> = {
  auto: { label: '自动', desc: '要不要留透明底交给模型自己判断。' },
  transparent: {
    label: '透明底',
    desc: '出带 alpha 通道的图，贴到任何底色上都不出白边。需要 PNG 或 WebP 承载，JPEG 没有 alpha。',
  },
  opaque: { label: '实底', desc: '强制铺满不透明背景，画面不会有镂空。' },
}

const MODERATION_TEXT: Record<string, OptionText> = {
  auto: { label: '标准 auto', desc: '上游默认的内容策略强度。' },
  low: {
    label: '放宽 low',
    desc: '上游把策略调到它自己允许的最低强度。判定仍然在上游手里，不等于关掉审核。',
  },
}

const KEY_LABEL: Record<string, string> = {
  quality: '质量档',
  n: '出图张数',
  output_format: '输出格式',
  background: '背景',
  output_compression: '压缩率',
  moderation: '审核档',
  input_fidelity: '输入保真度',
  size: '尺寸',
  style: '画风',
}

/* 这六个键由本弹窗管；被应用锁掉的那些改成只读行就地展示，不另开一节 */
const OWNED_KEYS = [
  'quality',
  'n',
  'output_format',
  'background',
  'output_compression',
  'moderation',
]

function lockReason(key: string, value: string): string {
  if (key === 'input_fidelity') {
    return value === 'high'
      ? '人像类应用锁死高保真。低保真档会把脸重画成另一个人，五官、发型、年龄都可能对不上，改图就失去意义了。'
      : '当前应用按这一档标定过效果，改了出图会偏。'
  }
  if (key === 'background' && value === 'transparent') {
    return '这个应用专出可直接叠加的素材，底必须镂空，否则贴到彩色底上会露一圈白边。'
  }
  if (key === 'output_format' && value === 'png') {
    return '透明底靠 alpha 通道存活，锁 PNG 才能无损保住它。'
  }
  if (key === 'quality') return '当前应用按这一档标定过效果，换档会偏离它的预期产出。'
  if (key === 'n') return '当前应用一次固定出这个张数。'
  if (key === 'size') return '当前应用的画面构图按这个尺寸设计，换尺寸会裁掉主体。'
  return '由当前应用锁定，改了会破坏它的出图前提。'
}

function describe(map: Record<string, OptionText>, key: string): OptionText {
  return map[key] ?? { label: key, desc: '上游枚举值，本地没有对应说明。' }
}

/** 恢复默认落到哪儿：中算力（没有就取第一档）、出 1 张、其余四项交回上游 */
function defaultsOf(qualities: string[], current: AdvancedValue): AdvancedValue {
  const quality = qualities.includes('medium') ? 'medium' : (qualities[0] ?? current.quality)
  return {
    quality,
    count: 1,
    outputFormat: null,
    background: null,
    outputCompression: null,
    moderation: null,
  }
}

function Field({
  icon,
  title,
  apiKey,
  why,
  right,
  children,
}: {
  icon: ReactNode
  title: string
  apiKey: string
  why: string
  right?: ReactNode
  children?: ReactNode
}) {
  return (
    <section className="imgadv-field">
      <div className="imgadv-fhead">
        <span className="imgadv-ficon">{icon}</span>
        <span className="imgadv-flabel">{title}</span>
        <code className="imgadv-fkey">{apiKey}</code>
        <span className="imgadv-fgap" />
        {right}
      </div>
      <p className="imgadv-why">{why}</p>
      {children !== undefined && <div className="imgadv-fbody">{children}</div>}
    </section>
  )
}

/** 应用锁死的参数：只读，并写清楚为什么锁 */
function LockedField({ apiKey, value }: { apiKey: string; value: string }) {
  return (
    <section className="imgadv-field imgadv-field-locked">
      <div className="imgadv-fhead">
        <span className="imgadv-ficon">
          <Lock size={14} />
        </span>
        <span className="imgadv-flabel">{KEY_LABEL[apiKey] ?? apiKey}</span>
        <code className="imgadv-fkey">{apiKey}</code>
        <span className="imgadv-fgap" />
        <code className="imgadv-lockval">{value}</code>
      </div>
      <p className="imgadv-why">{lockReason(apiKey, value)}</p>
    </section>
  )
}

/** 「交给上游默认 / 我自己指定」的开关。null 是个真实状态，得让人看见 */
function OverrideSwitch({
  id,
  on,
  onToggle,
}: {
  id: string
  on: boolean
  onToggle: (next: boolean) => void
}) {
  return (
    <label className="imgadv-ovr" htmlFor={id}>
      <span className={on ? 'imgadv-ovr-txt on' : 'imgadv-ovr-txt'}>
        {on ? '自己指定' : '交给上游'}
      </span>
      <Switch id={id} checked={on} onCheckedChange={onToggle} />
    </label>
  )
}

export function AdvancedDialog({
  open,
  value,
  qualities,
  outputFormats,
  backgrounds,
  maxN,
  locked,
  onChange,
  onClose,
}: {
  open: boolean
  value: AdvancedValue
  qualities: string[]
  outputFormats: string[]
  backgrounds: string[]
  maxN: number
  /** 应用锁死的参数，只读展示，不给改 */
  locked: Record<string, string>
  onChange: (next: AdvancedValue) => void
  onClose: () => void
}): JSX.Element | null {
  if (!open) return null

  const patch = (part: Partial<AdvancedValue>): void => onChange({ ...value, ...part })
  const lockedAt = (key: string): string | null =>
    Object.prototype.hasOwnProperty.call(locked, key) ? locked[key] : null

  const topN = Math.max(1, maxN)
  const clampedN = Math.min(Math.max(1, value.count), topN)

  const qualityLock = lockedAt('quality')
  const countLock = lockedAt('n')
  const formatLock = lockedAt('output_format')
  const bgLock = lockedAt('background')
  const compLock = lockedAt('output_compression')
  const modLock = lockedAt('moderation')

  const format = formatLock ?? value.outputFormat
  const background = bgLock ?? value.background
  const compressible = format === 'webp' || format === 'jpeg'

  const compBlockReason =
    format === 'png'
      ? 'PNG 是无损格式，压不压都存原样，这个滑块对它没有任何作用。'
      : format === null
        ? '还没指定输出格式。压缩率只对 WebP / JPEG 生效，先在上面挑一个再回来调。'
        : `${format} 不吃压缩率参数。`

  // 透明底遇上 JPEG：alpha 会被填成实底，白边照旧。给一键改格式，别让人自己猜
  const alphaConflict = background === 'transparent' && format === 'jpeg'
  // 压缩率填了但格式不吃：值会白白跟着请求发出去
  const deadCompression = value.outputCompression !== null && !compressible && compLock === null

  const preset = defaultsOf(qualities, value)
  const resetHint = `回到「${describe(QUALITY_TEXT, preset.quality).label} · 出 1 张 · 其余四项交给上游」`

  // 底部这条只列真正会跟着请求走的键，锁死的也算——它们同样会发出去
  const outgoing: Array<{ text: string; locked: boolean }> = [
    { text: `quality=${qualityLock ?? value.quality}`, locked: qualityLock !== null },
    { text: `n=${countLock ?? clampedN}`, locked: countLock !== null },
  ]
  if (format !== null) outgoing.push({ text: `output_format=${format}`, locked: formatLock !== null })
  if (background !== null) outgoing.push({ text: `background=${background}`, locked: bgLock !== null })
  if (compLock !== null) outgoing.push({ text: `output_compression=${compLock}`, locked: true })
  else if (value.outputCompression !== null && compressible) {
    outgoing.push({ text: `output_compression=${value.outputCompression}`, locked: false })
  }
  if (modLock !== null) outgoing.push({ text: `moderation=${modLock}`, locked: true })
  else if (value.moderation !== null) {
    outgoing.push({ text: `moderation=${value.moderation}`, locked: false })
  }
  for (const [key, val] of Object.entries(locked)) {
    if (!OWNED_KEYS.includes(key)) outgoing.push({ text: `${key}=${val}`, locked: true })
  }

  const extraLocks = Object.entries(locked).filter(([key]) => !OWNED_KEYS.includes(key))

  const reset = (): void => {
    // 锁死的字段不参与恢复：它们本来就不归用户管
    onChange({
      quality: qualityLock ?? preset.quality,
      count: countLock !== null ? value.count : preset.count,
      outputFormat: formatLock !== null ? value.outputFormat : preset.outputFormat,
      background: bgLock !== null ? value.background : preset.background,
      outputCompression:
        compLock !== null ? value.outputCompression : preset.outputCompression,
      moderation: modLock !== null ? value.moderation : preset.moderation,
    })
  }

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) onClose()
      }}
    >
      <DialogContent className="imgadv-dialog">
        <DialogHeader className="imgadv-head">
          <DialogTitle className="imgadv-title">高级参数</DialogTitle>
          <DialogDescription className="imgadv-sub">
            这几项原样透传给上游模型。开关关着的行我们根本不放进请求，上游用它自己的默认值。
          </DialogDescription>
        </DialogHeader>

        <div className="imgadv-body">
          {/* ── 质量档 ── */}
          {qualityLock !== null ? (
            <LockedField apiKey="quality" value={qualityLock} />
          ) : (
            <Field
              icon={<Gauge size={14} />}
              title="质量档"
              apiKey="quality"
              why="这一档买的是算力，不是像素。图有多大由尺寸决定，换质量档不会让图变大或变小，只影响模型愿意花多少推理成本、以及这一次要付多少钱。"
            >
              <Select value={value.quality} onValueChange={(q) => patch({ quality: q })}>
                <SelectTrigger className="imgadv-sel" aria-label="质量档">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {qualities.map((q) => (
                    <SelectItem key={q} value={q}>
                      {describe(QUALITY_TEXT, q).label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="imgadv-desc">{describe(QUALITY_TEXT, value.quality).desc}</p>
            </Field>
          )}

          <Separator className="imgadv-sep" />

          {/* ── 出图张数 ── */}
          {countLock !== null ? (
            <LockedField apiKey="n" value={countLock} />
          ) : (
            <Field
              icon={<Images size={14} />}
              title="出图张数"
              apiKey="n"
              why="一次请求出几张，同一句提示词跑出几个不同结果供挑选。出 3 张就等 3 张的时间，提示词写坏了也是 3 张一起废。"
              right={
                <span className="imgadv-num">
                  {clampedN}
                  <span className="imgadv-num-unit">张</span>
                </span>
              }
            >
              <Slider
                className="imgadv-slider"
                value={[clampedN]}
                min={1}
                max={topN}
                step={1}
                disabled={topN <= 1}
                aria-label="出图张数"
                onValueChange={(next) => patch({ count: next[0] })}
              />
              <div className="imgadv-scale">
                <span>1</span>
                <span>{topN}</span>
              </div>
              {topN <= 1 && (
                <p className="imgadv-note">
                  <Info size={13} />
                  当前应用上限就是 1 张，滑块没有可调空间。
                </p>
              )}
            </Field>
          )}

          <Separator className="imgadv-sep" />

          {/* ── 输出格式 ── */}
          {formatLock !== null ? (
            <LockedField apiKey="output_format" value={formatLock} />
          ) : (
            <Field
              icon={<FileImage size={14} />}
              title="输出格式"
              apiKey="output_format"
              why="决定拿到的文件是什么类型：能不能带透明、体积多大、压缩率这一项还起不起作用，全看它。"
              right={
                <OverrideSwitch
                  id="imgadv-sw-format"
                  on={value.outputFormat !== null}
                  onToggle={(on) =>
                    patch({ outputFormat: on ? (outputFormats[0] ?? 'png') : null })
                  }
                />
              }
            >
              {value.outputFormat === null ? (
                <p className="imgadv-off">不传这个参数，格式由上游定。</p>
              ) : (
                <>
                  <Select
                    value={value.outputFormat}
                    onValueChange={(f) => patch({ outputFormat: f })}
                  >
                    <SelectTrigger className="imgadv-sel" aria-label="输出格式">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {outputFormats.map((f) => (
                        <SelectItem key={f} value={f}>
                          {describe(FORMAT_TEXT, f).label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <p className="imgadv-desc">{describe(FORMAT_TEXT, value.outputFormat).desc}</p>
                </>
              )}
            </Field>
          )}

          <Separator className="imgadv-sep" />

          {/* ── 背景 ── */}
          {bgLock !== null ? (
            <LockedField apiKey="background" value={bgLock} />
          ) : (
            <Field
              icon={<Layers size={14} />}
              title="背景"
              apiKey="background"
              why="管的是画面底下那一层：留成镂空，还是铺满一块实底。做图标、贴纸、要往别的画面上叠的素材，选透明底。"
              right={
                <OverrideSwitch
                  id="imgadv-sw-bg"
                  on={value.background !== null}
                  onToggle={(on) => patch({ background: on ? (backgrounds[0] ?? 'auto') : null })}
                />
              }
            >
              {value.background === null ? (
                <p className="imgadv-off">不传这个参数，背景由上游定。</p>
              ) : (
                <>
                  <Select value={value.background} onValueChange={(b) => patch({ background: b })}>
                    <SelectTrigger className="imgadv-sel" aria-label="背景">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {backgrounds.map((b) => (
                        <SelectItem key={b} value={b}>
                          {describe(BACKGROUND_TEXT, b).label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <p className="imgadv-desc">{describe(BACKGROUND_TEXT, value.background).desc}</p>
                </>
              )}
              {alphaConflict && (
                <p className="imgadv-note warn">
                  <TriangleAlert size={13} />
                  <span>
                    JPEG 没有 alpha 通道，透明底会被填成实底，白边照样在。
                  </span>
                  <button
                    type="button"
                    className="imgadv-fix"
                    onClick={() => patch({ outputFormat: 'png' })}
                  >
                    改用 PNG
                  </button>
                </p>
              )}
            </Field>
          )}

          <Separator className="imgadv-sep" />

          {/* ── 压缩率 ── */}
          {compLock !== null ? (
            <LockedField apiKey="output_compression" value={compLock} />
          ) : (
            <Field
              icon={<Shrink size={14} />}
              title="压缩率"
              apiKey="output_compression"
              why="只对 WebP / JPEG 这两种有损格式生效。数值往下调，文件更小、画质损失更大；PNG 是无损的，这一项对它不起作用。"
              right={
                <OverrideSwitch
                  id="imgadv-sw-comp"
                  on={value.outputCompression !== null}
                  onToggle={(on) => patch({ outputCompression: on ? 80 : null })}
                />
              }
            >
              {value.outputCompression === null ? (
                <p className="imgadv-off">不传这个参数，压缩由上游定。</p>
              ) : (
                <>
                  <div className="imgadv-inline">
                    <Slider
                      className="imgadv-slider"
                      value={[value.outputCompression]}
                      min={0}
                      max={100}
                      step={1}
                      disabled={!compressible}
                      aria-label="压缩率"
                      onValueChange={(next) => patch({ outputCompression: next[0] })}
                    />
                    <span className="imgadv-num">{value.outputCompression}</span>
                  </div>
                  <div className="imgadv-scale">
                    <span>0 · 体积最小</span>
                    <span>100 · 画质最好</span>
                  </div>
                </>
              )}
              {value.outputCompression !== null && !compressible && (
                <p className="imgadv-note warn">
                  <TriangleAlert size={13} />
                  <span>{compBlockReason}</span>
                  {deadCompression && (
                    <button
                      type="button"
                      className="imgadv-fix"
                      onClick={() => patch({ outputCompression: null })}
                    >
                      清掉这一项
                    </button>
                  )}
                </p>
              )}
            </Field>
          )}

          <Separator className="imgadv-sep" />

          {/* ── 审核档 ── */}
          {modLock !== null ? (
            <LockedField apiKey="moderation" value={modLock} />
          ) : (
            <Field
              icon={<ShieldCheck size={14} />}
              title="审核档"
              apiKey="moderation"
              why="这是上游模型自己的内容策略强度，不是我们本地的过滤——本地一条规则都没有，只把这个值原样传过去。被拒还是放行，判定权在上游。"
              right={
                <OverrideSwitch
                  id="imgadv-sw-mod"
                  on={value.moderation !== null}
                  onToggle={(on) => patch({ moderation: on ? 'auto' : null })}
                />
              }
            >
              {value.moderation === null ? (
                <p className="imgadv-off">不传这个参数，策略强度由上游定。</p>
              ) : (
                <>
                  <Select value={value.moderation} onValueChange={(m) => patch({ moderation: m })}>
                    <SelectTrigger className="imgadv-sel" aria-label="审核档">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {Object.keys(MODERATION_TEXT).map((m) => (
                        <SelectItem key={m} value={m}>
                          {MODERATION_TEXT[m].label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <p className="imgadv-desc">{describe(MODERATION_TEXT, value.moderation).desc}</p>
                </>
              )}
            </Field>
          )}

          {/* ── 应用锁死的其余参数 ── */}
          {extraLocks.length > 0 && (
            <>
              <Separator className="imgadv-sep" />
              <div className="imgadv-locksec">
                <div className="imgadv-locksec-head">
                  <Lock size={13} />
                  当前应用锁死的参数
                </div>
                {extraLocks.map(([key, val]) => (
                  <LockedField key={key} apiKey={key} value={val} />
                ))}
              </div>
            </>
          )}
        </div>

        <div className="imgadv-foot">
          <div className="imgadv-outgoing">
            <span className="imgadv-outgoing-cap">这次实际会发出去</span>
            <div className="imgadv-chips">
              {outgoing.map((item) => (
                <code
                  key={item.text}
                  className={item.locked ? 'imgadv-chip locked' : 'imgadv-chip'}
                  title={item.locked ? '由当前应用锁定' : undefined}
                >
                  {item.locked && <Lock size={11} />}
                  {item.text}
                </code>
              ))}
            </div>
          </div>
          <div className="imgadv-acts">
            <span className="imgadv-reset-hint">{resetHint}</span>
            <Button variant="outline" size="sm" className="imgadv-btn" onClick={reset}>
              <RotateCcw size={14} />
              恢复默认
            </Button>
            <Button size="sm" className="imgadv-btn" onClick={onClose}>
              完成
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
