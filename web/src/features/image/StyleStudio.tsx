/* 画风选择器（模块 16 FR-442）。类名前缀 sst-，独占。

   一百多个风格里绝大多数从 twri/sdxl_prompt_styler（MIT）导入，本仓自制的只有
   「封面专用」那五个。两批的适用范围不一样，所以分类栏、卡片、详情条三处都把
   出处标出来——别让人拿封面调校过的风格去画横幅。

   没有示例图就不摆示例图。卡片给的是中文名、一句话说明，加上从 render 里抽出来的
   英文关键词：这三样都是后端真实存在的字段。凭空生成的"预览图"看着好看，跟这个
   风格实际画出来的东西没有任何关系（BR-110）。 */

import {
  Ban,
  Brush,
  Camera,
  Check,
  Frame,
  Gamepad2,
  Hammer,
  Layers,
  Loader2,
  Palette,
  Pencil,
  Plus,
  Rocket,
  Search,
  Shapes,
  ShoppingBag,
  Sparkles,
  Trash2,
  TriangleAlert,
  X,
} from '@/components/NexusIcon'
import type { LucideIcon } from '@/components/NexusIcon'
// 与 DOM 的 KeyboardEvent 同名，起个别名免得把 radix 的原生事件也当成 react 合成事件
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { apiImage } from '@/lib/api-image'
import type { CustomStyle, StyleLibrary, StylePreset } from '@/lib/api-image'

import { NO_STYLE } from './consoleStore'
import './StyleStudio.css'

/** 自定义风格的合成分类。后端不返回这一档——它们按各自的 category 散在别处，
    但用户要找"我攒的那些"时得有个确定的去处 */
const CUSTOM_TAB = '__custom'

/** 「不指定画风」不进分类栏，而是常驻在网格上方。
    它不是一百多个风格里的一个，是「一个都不要」——塞进某一类里既找不到，
    也会让那一类的计数变得莫名其妙。后端因此把它排除在 categories 之外，
    但保留在 styles 里（前端按 key 反查名字要查得到）。 */

const CATEGORY_ICON: Record<string, LucideIcon> = {
  cover: Frame,
  general: Layers,
  photo: Camera,
  art: Brush,
  concept: Rocket,
  game: Gamepad2,
  craft: Hammer,
  commerce: ShoppingBag,
  misc: Shapes,
  [CUSTOM_TAB]: Sparkles,
}

/** 后端 categories 只返回有内容的分类，编辑表单要的 allowed_categories 只有 key。
    查不到名字时用这张兜底表，实在没有就露 key，不编一个好听的出来 */
const CATEGORY_FALLBACK: Record<string, string> = {
  cover: '封面专用',
  general: '通用',
  photo: '摄影',
  art: '绘画',
  concept: '概念与科幻',
  game: '游戏',
  craft: '手作质感',
  commerce: '广告电商',
  misc: '其它',
}

const KEY_PATTERN = /^[a-z][a-z0-9-]{1,47}$/

/** 提交给增改接口的请求体。与 apiImage.createStyle / updateStyle 的入参同形 */
type StyleBody = Omit<CustomStyle, 'builtin' | 'source' | 'updated_at'>

function iconOf(category: string): LucideIcon {
  return CATEGORY_ICON[category] ?? Palette
}

/** 抽 3~5 个关键词当卡片上的"这风格画出来什么样"。render 本身就是逗号分隔的
    英文描述词，取前几段即可，不做任何改写 */
function keywordsOf(render: string, max = 4): string[] {
  return render
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part !== '')
    .slice(0, max)
}

/** 出处压成一枚短标签；完整字符串挂在 title 上，详情条里也原样给 */
function sourceTag(source: string, mine: boolean): { text: string; kind: string } {
  if (mine) return { text: '自定义', kind: 'mine' }
  if (source.includes('sdxl_prompt_styler')) return { text: 'MIT 开源库导入', kind: 'import' }
  return { text: source === '' ? '自制' : source, kind: 'own' }
}

/** radix 的 Esc 监听挂在 document 上，本仓 `components/Overlay` 的浮层栈挂在 window 上，
    两者都会收到同一次 Esc——本弹窗开在别的浮层之上时，一次按键会连着关掉两层
    （STD-UI-002 记过这个坑）。在 document 这一层截住冒泡：radix 照常关自己，
    window 上的浮层栈收不到，下面那层保持不动。 */
function stopEscape(e: KeyboardEvent): void {
  e.stopPropagation()
}

/** 服务端说了什么就显示什么。ApiImageError.message 装的就是响应体里的 detail */
function reasonOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function toPreset(row: CustomStyle): StylePreset {
  return {
    key: row.key,
    label: row.label,
    hint: row.hint,
    builtin: false,
    category: row.category,
    render: row.render,
    avoid: row.avoid,
    tags: [],
    source: row.source,
  }
}

/* ==================== 选择器本体 ==================== */

export function StyleStudio({
  open,
  value,
  library,
  onPick,
  onClose,
  onChanged,
}: {
  open: boolean
  value: string
  library: StyleLibrary | undefined
  onPick: (key: string) => void
  onClose: () => void
  /** 自定义风格增删改之后调，外部负责重新拉取 */
  onChanged: () => void
}): JSX.Element | null {
  const [cat, setCat] = useState('')
  const [text, setText] = useState('')
  const [active, setActive] = useState(0)
  /** undefined=编辑器没开；null=新建；有值=在改这一条 */
  const [editing, setEditing] = useState<CustomStyle | null | undefined>(undefined)

  const inputRef = useRef<HTMLInputElement>(null)
  const cardRefs = useRef(new Map<string, HTMLButtonElement>())

  const needle = text.trim().toLowerCase()
  const searching = needle !== ''

  const all = useMemo(() => library?.styles ?? [], [library])
  const none = useMemo(() => all.find((s) => s.key === NO_STYLE), [all])
  // 网格与搜索都不含 none：它由上方那张常驻卡片承担，出现两次只会让人以为有两个
  const styles = useMemo(() => all.filter((s) => s.key !== NO_STYLE), [all])
  const custom = useMemo(() => library?.custom ?? [], [library])

  const customMap = useMemo(() => new Map(custom.map((row) => [row.key, row])), [custom])

  /** 左栏：后端分类 + 合成的「我的自定义」 */
  const tabs = useMemo(() => {
    const base = (library?.categories ?? []).map((c) => ({
      key: c.key,
      label: c.label,
      count: c.count,
    }))
    return [...base, { key: CUSTOM_TAB, label: '我的自定义', count: custom.length }]
  }, [library, custom])

  /* 每次「关 → 开」都把浏览状态同步回当前风格（STD-UI-005）。

     只在首次同步是不够的：弹窗关掉之后组件仍然挂载，`cat` / 搜索词 / 编辑表单都
     原样留着。上次翻到「我的自定义」（0 条）再打开，看到的就是一片空白，而当前
     用的那个风格在哪一类完全无从得知——实测就是这个现象。

     用 ref 抓边沿而不是挂依赖数组：父组件每渲染一次传进来的都是新数组，
     挂依赖会把用户刚点的分类反复冲掉。 */
  const wasOpen = useRef(false)
  useEffect(() => {
    if (open && !wasOpen.current && tabs.length > 0) {
      const hit = styles.find((s) => s.key === value)
      setCat(hit?.category ?? tabs[0].key)
      setText('')
      setEditing(undefined)
    }
    wasOpen.current = open
  }, [open, tabs, styles, value])

  // 数据晚到（首帧 library 还是 undefined）时补一次，否则左栏会一直空着
  useEffect(() => {
    if (!open || cat !== '' || tabs.length === 0) return
    const hit = styles.find((s) => s.key === value)
    setCat(hit?.category ?? tabs[0].key)
  }, [open, cat, tabs, styles, value])

  const visible = useMemo(() => {
    if (searching) {
      // 跨分类搜：中文名、一句话说明、标签、英文描述词，外加标识本身
      return styles.filter(
        (s) =>
          s.label.toLowerCase().includes(needle) ||
          s.hint.toLowerCase().includes(needle) ||
          s.key.includes(needle) ||
          s.render.toLowerCase().includes(needle) ||
          s.tags.some((t) => t.toLowerCase().includes(needle)),
      )
    }
    if (cat === CUSTOM_TAB) return custom.map(toPreset)
    return styles.filter((s) => s.category === cat)
  }, [styles, custom, cat, needle, searching])

  /** 搜索时每一类的命中数，用来把没命中的分类压暗 */
  const matched = useMemo(() => {
    const counts = new Map<string, number>()
    if (!searching) return counts
    for (const s of visible) {
      counts.set(s.category, (counts.get(s.category) ?? 0) + 1)
      if (customMap.has(s.key)) counts.set(CUSTOM_TAB, (counts.get(CUSTOM_TAB) ?? 0) + 1)
    }
    return counts
  }, [visible, searching, customMap])

  // 列表一变就把高亮落回当前选中项，落不到就回到第一个
  useEffect(() => {
    const i = visible.findIndex((s) => s.key === value)
    setActive(i >= 0 ? i : 0)
  }, [visible, value])

  useEffect(() => {
    const hit = visible[active]
    if (!hit) return
    // smooth 在内嵌浏览器面板里会被整个吞掉，一律 auto
    cardRefs.current.get(hit.key)?.scrollIntoView({ block: 'nearest', behavior: 'auto' })
  }, [active, visible])

  if (!open) return null

  function onKeyDown(e: ReactKeyboardEvent<HTMLDivElement>) {
    if (visible.length === 0) return
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      const step = e.key === 'ArrowDown' ? 1 : -1
      setActive((i) => (i + step + visible.length) % visible.length)
      return
    }
    if (e.key !== 'Enter') return
    // 焦点在按钮上时 Enter 归它自己，别抢
    if ((e.target as HTMLElement).tagName === 'BUTTON') return
    e.preventDefault()
    const hit = visible[active]
    if (hit) onPick(hit.key)
  }

  const detail = visible[active]
  const allowed = library?.allowed_categories ?? []
  const labelOfCat = (key: string) =>
    tabs.find((t) => t.key === key)?.label ?? CATEGORY_FALLBACK[key] ?? key

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose()
      }}
    >
      <DialogContent
        className="sst-dialog"
        showCloseButton={false}
        aria-describedby={undefined}
        onOpenAutoFocus={(e) => {
          e.preventDefault()
          inputRef.current?.focus()
        }}
        onEscapeKeyDown={stopEscape}
      >
        <div className="sst" onKeyDown={onKeyDown}>
          <header className="sst-head">
            <DialogTitle className="sst-title">选择画风</DialogTitle>
            {library && (
              <span className="sst-count">
                {styles.length} 个 · 导入 {library.imported_count}
              </span>
            )}
            <div className="sst-search">
              <Search />
              <input
                ref={inputRef}
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder="搜中文名、说明或英文描述词"
                aria-label="搜索画风"
              />
              {searching && (
                <button className="sst-clear" onClick={() => setText('')} aria-label="清空搜索">
                  <X />
                </button>
              )}
            </div>
            <Button size="sm" variant="outline" onClick={() => setEditing(null)}>
              <Plus />
              新建画风
            </Button>
            <button className="icon-btn" onClick={onClose} aria-label="关闭">
              <X />
            </button>
          </header>

          {library === undefined ? (
            <div className="sst-loading">
              <Loader2 className="sst-spin" />
              正在读取画风库…
            </div>
          ) : (
            <div className="sst-body">
              <nav className="sst-rail" aria-label="画风分类">
                {tabs.map((t) => {
                  const Icon = iconOf(t.key)
                  const on = !searching && t.key === cat
                  const hit = matched.get(t.key) ?? 0
                  return (
                    <button
                      key={t.key}
                      className={`sst-tab${on ? ' on' : ''}${searching && hit === 0 ? ' dim' : ''}`}
                      aria-current={on ? 'true' : undefined}
                      onClick={() => {
                        setText('')
                        setCat(t.key)
                      }}
                    >
                      <Icon />
                      <span className="sst-tab-name">{t.label}</span>
                      <span className="sst-tab-n">{searching ? hit : t.count}</span>
                    </button>
                  )
                })}
              </nav>

              <div className="sst-main">
                <div className="sst-scroll">
                  {!searching && cat === 'cover' && (
                    <p className="sst-notice">
                      <TriangleAlert />
                      这 5 个是照着卡片封面的真实显示尺寸调过的（留白、主体占比、禁字），
                      换到横幅、头像等别的用途未必合适。
                    </p>
                  )}
                  {!searching && cat === CUSTOM_TAB && (
                    <p className="sst-notice mine">
                      <Sparkles />
                      自己攒的风格，可以改也可以删。它们同时按各自的分类出现在上面几档里。
                    </p>
                  )}

                  {none && (
                    <button
                      className={`sst-pin${value === NO_STYLE ? ' on' : ''}`}
                      aria-current={value === NO_STYLE ? 'true' : undefined}
                      onClick={() => onPick(NO_STYLE)}
                    >
                      <Ban className="sst-pin-icon" />
                      <span className="sst-pin-text">
                        <b>{none.label}</b>
                        <em>{none.hint}</em>
                      </span>
                      {value === NO_STYLE && <Check className="sst-pin-check" />}
                    </button>
                  )}

                  {visible.length === 0 ? (
                    <div className="sst-empty">
                      {searching ? (
                        <p>没有匹配「{text.trim()}」的画风</p>
                      ) : cat === CUSTOM_TAB ? (
                        <>
                          <p>还没有自定义画风</p>
                          <Button size="sm" onClick={() => setEditing(null)}>
                            <Plus />
                            新建一个
                          </Button>
                        </>
                      ) : (
                        <p>这一类下暂时没有画风</p>
                      )}
                    </div>
                  ) : (
                    <div className="sst-grid">
                      {visible.map((s, i) => {
                        const mine = customMap.get(s.key)
                        const tag = sourceTag(s.source, mine !== undefined)
                        const picked = s.key === value
                        const classes = [
                          'sst-card',
                          picked ? 'on' : '',
                          i === active ? 'active' : '',
                        ]
                          .filter(Boolean)
                          .join(' ')
                        return (
                          <div className="sst-cell" key={s.key}>
                            <button
                              ref={(el) => {
                                if (el) cardRefs.current.set(s.key, el)
                                else cardRefs.current.delete(s.key)
                              }}
                              className={classes}
                              aria-current={picked ? 'true' : undefined}
                              onMouseEnter={() => setActive(i)}
                              onClick={() => onPick(s.key)}
                            >
                              <span className="sst-card-top">
                                <span className="sst-card-name">{s.label}</span>
                                {picked && <Check className="sst-card-check" />}
                              </span>
                              <span className="sst-card-hint">{s.hint || '（没写说明）'}</span>
                              <span className="sst-keys" title={s.render}>
                                {keywordsOf(s.render).map((word) => (
                                  <em className="sst-key" key={word}>
                                    {word}
                                  </em>
                                ))}
                              </span>
                              <span className="sst-card-foot">
                                {s.category === 'cover' && (
                                  <span className="sst-flag cover">封面调校</span>
                                )}
                                <span className={`sst-flag ${tag.kind}`} title={s.source}>
                                  {tag.text}
                                </span>
                              </span>
                            </button>
                            {mine && (
                              <button
                                className="sst-edit"
                                aria-label={`编辑「${s.label}」`}
                                title="编辑这个自定义画风"
                                onClick={() => setEditing(mine)}
                              >
                                <Pencil />
                              </button>
                            )}
                          </div>
                        )
                      })}
                    </div>
                  )}
                </div>

                {detail && (
                  <div className="sst-detail">
                    <div className="sst-detail-top">
                      <b>{detail.label}</b>
                      <code>{detail.key}</code>
                      <span className="sst-detail-cat">{labelOfCat(detail.category)}</span>
                      <span className="sst-detail-src" title={detail.source}>
                        出处：{detail.source === '' ? '自制' : detail.source}
                      </span>
                    </div>
                    <p className="sst-detail-render">{detail.render}</p>
                    {detail.avoid.length > 0 && (
                      <p className="sst-detail-avoid">避免：{detail.avoid.join(' · ')}</p>
                    )}
                  </div>
                )}
              </div>
            </div>
          )}

          <footer className="sst-foot">
            <span>
              <b className="sst-kbd">↑</b>
              <b className="sst-kbd">↓</b> 移动
            </span>
            <span>
              <b className="sst-kbd">Enter</b> 选中
            </span>
            <span>
              <b className="sst-kbd">Esc</b> 关闭
            </span>
            <span className="sst-foot-note">卡片上的英文是这个风格真正注入的描述词，没有示例图</span>
            <Button size="sm" variant="outline" onClick={onClose}>
              完成
            </Button>
          </footer>
        </div>
      </DialogContent>

      {editing !== undefined && (
        <StyleEditor
          key={editing?.key ?? '__new'}
          draft={editing}
          allowed={allowed}
          labelOfCat={labelOfCat}
          onClose={() => setEditing(undefined)}
          onSaved={() => {
            setEditing(undefined)
            onChanged()
          }}
        />
      )}
    </Dialog>
  )
}

/* ==================== 自定义风格编辑器 ==================== */

function StyleEditor({
  draft,
  allowed,
  labelOfCat,
  onClose,
  onSaved,
}: {
  /** null=新建 */
  draft: CustomStyle | null
  allowed: string[]
  labelOfCat: (key: string) => string
  onClose: () => void
  onSaved: () => void
}): JSX.Element {
  const [key, setKey] = useState(draft?.key ?? '')
  const [label, setLabel] = useState(draft?.label ?? '')
  const [hint, setHint] = useState(draft?.hint ?? '')
  const [category, setCategory] = useState(draft?.category ?? allowed[0] ?? 'misc')
  const [render, setRender] = useState(draft?.render ?? '')
  const [palette, setPalette] = useState(draft?.palette ?? '')
  const [lighting, setLighting] = useState(draft?.lighting ?? '')
  const [texture, setTexture] = useState(draft?.texture ?? '')
  const [avoid, setAvoid] = useState<string[]>(draft?.avoid ?? [])
  const [avoidText, setAvoidText] = useState('')
  const [busy, setBusy] = useState(false)
  const [confirming, setConfirming] = useState(false)

  const editingExisting = draft !== null
  const cleanKey = key.trim().toLowerCase()
  const keyBad = cleanKey !== '' && !KEY_PATTERN.test(cleanKey)
  const ready = cleanKey !== '' && label.trim() !== '' && render.trim() !== '' && !keyBad

  /** 把输入框里还没落袋的避免词收进列表。逗号、中文逗号、换行都算分隔 */
  function foldAvoid(raw: string): string[] {
    const parts = raw
      .split(/[,，\n]/)
      .map((s) => s.trim())
      .filter((s) => s !== '')
    if (parts.length === 0) return avoid
    const merged = [...avoid]
    for (const part of parts) if (!merged.includes(part)) merged.push(part)
    if (merged.length > 40) {
      toast.error('避免词最多 40 条')
      return merged.slice(0, 40)
    }
    return merged
  }

  function addAvoid() {
    setAvoid(foldAvoid(avoidText))
    setAvoidText('')
  }

  async function submit() {
    const body: StyleBody = {
      key: cleanKey,
      label: label.trim(),
      hint: hint.trim(),
      category,
      render: render.trim(),
      palette: palette.trim(),
      lighting: lighting.trim(),
      texture: texture.trim(),
      avoid: foldAvoid(avoidText),
    }
    setBusy(true)
    try {
      if (draft) await apiImage.updateStyle(draft.key, body)
      else await apiImage.createStyle(body)
      toast.success(draft ? `已保存「${body.label}」` : `已新建「${body.label}」`)
      onSaved()
    } catch (err) {
      toast.error(reasonOf(err))
    } finally {
      setBusy(false)
    }
  }

  async function remove() {
    if (!draft) return
    setBusy(true)
    try {
      await apiImage.deleteStyle(draft.key)
      toast.success(`已删除「${draft.label}」`)
      onSaved()
    } catch (err) {
      toast.error(reasonOf(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next && !busy) onClose()
      }}
    >
      <DialogContent
        className="sst-editor"
        showCloseButton={false}
        aria-describedby={undefined}
        onEscapeKeyDown={stopEscape}
      >
        <header className="sst-head">
          <DialogTitle className="sst-title">
            {editingExisting ? '编辑自定义画风' : '新建自定义画风'}
          </DialogTitle>
          {draft?.updated_at && (
            <span className="sst-count">
              上次修改 {new Date(draft.updated_at).toLocaleString('zh-CN')}
            </span>
          )}
          <span className="sst-grow" />
          <button className="icon-btn" onClick={onClose} aria-label="关闭" disabled={busy}>
            <X />
          </button>
        </header>

        <div className="sst-form">
          <label className="sst-field">
            <span className="sst-lab">
              标识 key
              {editingExisting && <em className="sst-lock">建后不可改</em>}
            </span>
            <Input
              value={key}
              onChange={(e) => setKey(e.target.value)}
              disabled={editingExisting || busy}
              placeholder="ink-wash-mountain"
              spellCheck={false}
              className="sst-mono"
            />
            <span className={`sst-tip${keyBad ? ' bad' : ''}`}>
              小写字母开头，只能用小写字母、数字、短横线，2~48 位。出过的图靠它对得上，建好就不能再改。
            </span>
          </label>

          <div className="sst-row">
            <label className="sst-field">
              <span className="sst-lab">名字</span>
              <Input
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                disabled={busy}
                maxLength={24}
                placeholder="水墨远山"
              />
            </label>
            <label className="sst-field sst-narrow">
              <span className="sst-lab">分类</span>
              <Select
                value={category}
                onValueChange={setCategory}
                disabled={busy || allowed.length === 0}
              >
                <SelectTrigger className="sst-select">
                  <SelectValue placeholder="选一个分类" />
                </SelectTrigger>
                <SelectContent>
                  {allowed.map((k) => (
                    <SelectItem key={k} value={k}>
                      {labelOfCat(k)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </label>
          </div>

          <label className="sst-field">
            <span className="sst-lab">一句话说明</span>
            <Input
              value={hint}
              onChange={(e) => setHint(e.target.value)}
              disabled={busy}
              maxLength={160}
              placeholder="适合什么题材、画出来大概什么感觉"
            />
          </label>

          <label className="sst-field">
            <span className="sst-lab">
              画面描述 render<em className="sst-req">必填</em>
            </span>
            <Textarea
              value={render}
              onChange={(e) => setRender(e.target.value)}
              disabled={busy}
              rows={4}
              spellCheck={false}
              className="sst-mono sst-area"
              placeholder="ink wash painting, wet brush edges, layered mountains fading into mist"
            />
            <span className="sst-tip">
              这个风格的主体，用英文逗号分隔的描述词。选择器卡片上的关键词就是从这里抽的。
            </span>
          </label>

          <div className="sst-row">
            <label className="sst-field">
              <span className="sst-lab">配色 palette</span>
              <Input
                value={palette}
                onChange={(e) => setPalette(e.target.value)}
                disabled={busy}
                spellCheck={false}
                className="sst-mono"
                placeholder="ink black and rice paper cream"
              />
            </label>
            <label className="sst-field">
              <span className="sst-lab">光线 lighting</span>
              <Input
                value={lighting}
                onChange={(e) => setLighting(e.target.value)}
                disabled={busy}
                spellCheck={false}
                className="sst-mono"
                placeholder="flat diffused light"
              />
            </label>
          </div>

          <label className="sst-field">
            <span className="sst-lab">质感 texture</span>
            <Input
              value={texture}
              onChange={(e) => setTexture(e.target.value)}
              disabled={busy}
              spellCheck={false}
              className="sst-mono"
              placeholder="xuan paper fiber texture"
            />
          </label>

          <div className="sst-field">
            <span className="sst-lab">避免词 avoid</span>
            <div className="sst-tags">
              {avoid.map((word) => (
                <span className="sst-tagchip" key={word}>
                  {word}
                  <button
                    onClick={() => setAvoid((list) => list.filter((w) => w !== word))}
                    aria-label={`删掉避免词 ${word}`}
                    disabled={busy}
                  >
                    <X />
                  </button>
                </span>
              ))}
              <input
                className="sst-taginput"
                value={avoidText}
                onChange={(e) => setAvoidText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ',') {
                    e.preventDefault()
                    addAvoid()
                    return
                  }
                  if (e.key === 'Backspace' && avoidText === '' && avoid.length > 0) {
                    setAvoid((list) => list.slice(0, -1))
                  }
                }}
                onBlur={addAvoid}
                disabled={busy}
                spellCheck={false}
                placeholder={avoid.length === 0 ? '输入后回车添加，如 photorealistic' : ''}
                aria-label="添加避免词"
              />
            </div>
            <span className="sst-tip">这些词会追加到全局红线之后，一起进负面约束。</span>
          </div>
        </div>

        <footer className="sst-editor-foot">
          {confirming ? (
            <div className="sst-confirm">
              <p>
                删掉「{draft?.label}」？<b>已经用这个风格出过的图不受影响</b>
                ——资产上存的是当初渲染好的完整提示词，不是对风格的引用，删掉只影响之后的出图。
                如果当前选中的就是它，记得回去重新挑一个。
              </p>
              <div className="sst-confirm-act">
                <Button size="sm" variant="outline" onClick={() => setConfirming(false)} disabled={busy}>
                  取消
                </Button>
                <Button size="sm" variant="destructive" onClick={remove} disabled={busy}>
                  {busy ? <Loader2 className="sst-spin" /> : <Trash2 />}
                  确认删除
                </Button>
              </div>
            </div>
          ) : (
            <>
              {editingExisting && (
                <Button
                  size="sm"
                  variant="ghost"
                  className="sst-del"
                  onClick={() => setConfirming(true)}
                  disabled={busy}
                >
                  <Trash2 />
                  删除
                </Button>
              )}
              <span className="sst-grow" />
              <Button size="sm" variant="outline" onClick={onClose} disabled={busy}>
                取消
              </Button>
              <Button size="sm" onClick={submit} disabled={busy || !ready}>
                {busy && <Loader2 className="sst-spin" />}
                {editingExisting ? '保存' : '创建'}
              </Button>
            </>
          )}
        </footer>
      </DialogContent>
    </Dialog>
  )
}
