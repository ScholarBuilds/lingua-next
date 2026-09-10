/* 全项目统一的下拉控件（规范 STD-UI-009）。
 *
 * 三个形态，一个来源：
 *
 * | 形态 | 内核 | 用在哪 | 触发 |
 * | --- | --- | --- | --- |
 * | `Picker` | Radix Select | 表单里的普通下拉，`<select>` 的 drop-in 替代 | 点击 |
 * | `PillPicker` | Radix Select | 密集控件条上的胶囊（生成条、工具条） | 点击 |
 * | `PopoverPicker` | Radix Popover | 内容不是一列选项（分档 tab、两列、输入框） | 悬停 + 点击 |
 * | `ActionPicker` | Radix DropdownMenu | 选完就执行的动作，没有选中态 | 点击 |
 *
 * > [!warning] 为什么不自己写弹层
 * >
 * > 焦点陷阱、Esc、点外面关闭、方向键、碰撞翻转、滚动跟随、`aria-*`——
 * > 手写要么漏一半，要么写成第二套和别处不一致的东西。Radix 这些全带，
 * > 而且本仓早就装了（`components/ui/select.tsx` 等十几个封装在用）。
 *
 * 视觉与交互约定抄的是蓝本 Infinite-Canvas 的 `.smart-control` 体系
 * （`static/css/smart-canvas.css:1103-1161`）：胶囊触发器、弹层浮在控件上方、
 * 分档 tab、两列 preset。尺寸不照抄——蓝本是 10.5px 的密集条，
 * 放进本项目会格格不入，这里走项目自己的字号令牌。
 */

import * as React from 'react'

import { cn } from '@/lib/utils'
import { ChevronDown } from '@/components/NexusIcon'

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'


/** 悬停开合。蓝本的每一个 `.smart-control` 都是**悬停即出**
 *  （`.smart-control:hover .smart-popover { opacity:1 }`，smart-canvas.css:1132），
 *  点一下则固定住（`.pinned`）。密集控件条上这样最快——不用为了看一眼选项而点两次。
 *
 *  三件事缺一不可，少一件就会出现"移过去弹层就没了"：
 *  1. **悬停桥**：触发器与弹层之间有 8px 的 sideOffset，鼠标斜着穿过去会掉出
 *     hover 区。CSS 里用伪元素把这段空隙补上（`.ui-picker-hover::before/after`）。
 *  2. **延迟关闭**：兜住鼠标快速划过时浏览器漏派 enter 事件的情况。
 *  3. **pinned**：点击之后就不再随鼠标离开而关，否则移向弹层里的输入框时
 *     只要路径偏一点就关了。
 *
 *  触屏没有 hover，`pointerType === 'touch'` 时整套让开、交给点击。 */
function useHoverOpen(enabled: boolean): {
  open: boolean
  pinned: boolean
  setOpen: (v: boolean) => void
  togglePin: () => void
  onOpenChange: (v: boolean) => void
  hoverProps: Record<string, unknown>
} {
  const [open, setOpen] = React.useState(false)
  const [pinned, setPinned] = React.useState(false)
  const timer = React.useRef<number | undefined>(undefined)
  const pinnedRef = React.useRef(false)
  pinnedRef.current = pinned

  const cancel = (): void => {
    if (timer.current !== undefined) window.clearTimeout(timer.current)
    timer.current = undefined
  }
  React.useEffect(() => cancel, [])

  const hoverProps = enabled
    ? {
        onPointerEnter: (e: React.PointerEvent) => {
          if (e.pointerType === 'touch') return
          cancel()
          setOpen(true)
        },
        onPointerLeave: (e: React.PointerEvent) => {
          if (e.pointerType === 'touch') return
          cancel()
          timer.current = window.setTimeout(() => {
            if (!pinnedRef.current) setOpen(false)
          }, 140)
        },
      }
    : {}

  return {
    open,
    pinned,
    setOpen,
    togglePin: () => setPinned((v) => !v),
    onOpenChange: (v: boolean) => {
      setOpen(v)
      if (!v) setPinned(false)
    },
    hoverProps,
  }
}

/** 「键盘事件该不该让路」的判据。
 *
 *  原来各处写的是 `input, textarea, select, [contenteditable]`——那份清单
 *  在把原生 `<select>` 换成 Radix 之后**会静默失效**：Radix 的触发器是
 *  `<button role="combobox">`，不是 `<select>`，于是焦点停在下拉上按方向键，
 *  画布会去微移节点而不是切选项，而这不报错、只是"方向键忽然不灵了"。
 *
 *  所以按 **role** 判而不是按标签判：role 是这些部件对外的契约，
 *  换一次实现库也不会变。 */
export const FORM_FOCUS_SELECTOR =
  'input, textarea, select, [contenteditable="true"], ' +
  '[role="combobox"], [role="listbox"], [role="option"], ' +
  '[role="menu"], [role^="menuitem"]'

/** 一个选项。`hint` 是副标题（第二行小字），`group` 用来分组 */
export interface PickerOption {
  value: string
  label: string
  hint?: string
  group?: string
  disabled?: boolean
}

function groupOptions(options: PickerOption[]): [string, PickerOption[]][] {
  const out = new Map<string, PickerOption[]>()
  for (const o of options) {
    const key = o.group ?? ''
    const list = out.get(key)
    if (list === undefined) out.set(key, [o])
    else list.push(o)
  }
  return [...out.entries()]
}

/** 导出只为测试：Select 的内容挂在 Portal 里、且只有展开才渲染，
 *  整体渲染 `Picker` 根本走不到这里——`SelectLabel` 缺 `SelectGroup` 那次整页白屏
 *  就是这么躲过所有测试的。要守住它只能把这一层单拎出来渲染。 */
export function Items({ options }: { options: PickerOption[] }): React.ReactElement {
  const groups = groupOptions(options)
  return (
    <>
      {groups.map(([name, list], gi) => (
        /* 有组名的必须包一层 SelectGroup：Radix 的 SelectLabel 会往上找 SelectGroup 的
           context，找不到就直接抛「`SelectLabel` must be used within `SelectGroup`」，
           被错误边界一吞就是整页白掉——生图控制台就是这么挂的。
           没有组名的那批不包，包了会平白多一个 role="group" 让读屏器报一个空分组。 */
        <React.Fragment key={name || `g${gi}`}>
          {gi > 0 && <SelectSeparator />}
          {name !== '' ? (
            <SelectGroup>
              <SelectLabel>{name}</SelectLabel>
              {list.map((o) => (
                <SelectItem key={o.value} value={o.value} disabled={o.disabled}>
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="truncate">{o.label}</span>
                    {o.hint !== undefined && o.hint !== '' && (
                      <span className="shrink-0 text-xs text-muted-foreground">{o.hint}</span>
                    )}
                  </span>
                </SelectItem>
              ))}
            </SelectGroup>
          ) : null}
          {name === '' && list.map((o) => (
            <SelectItem key={o.value} value={o.value} disabled={o.disabled}>
              {/* 副标题挂在同一行右侧：分两行会让密集控件条上的弹层变得很高 */}
              <span className="flex min-w-0 items-center gap-2">
                <span className="truncate">{o.label}</span>
                {o.hint !== undefined && o.hint !== '' && (
                  <span className="shrink-0 text-xs text-muted-foreground">{o.hint}</span>
                )}
              </span>
            </SelectItem>
          ))}
        </React.Fragment>
      ))}
    </>
  )
}

/** 表单里的普通下拉。一行替换一个 `<select>`。
 *
 *  `value` 用空串表示"未选"并显示 placeholder。空串不能作为 SelectItem 的值，
 *  但可以作为 Root 的受控清空值；始终受控可避免异步选项到达时切换状态。 */
export function Picker({
  value,
  onChange,
  options,
  placeholder,
  disabled,
  className,
  size = 'default',
  'aria-label': ariaLabel,
  title,
}: {
  value: string
  onChange: (next: string) => void
  options: PickerOption[]
  placeholder?: string
  disabled?: boolean
  className?: string
  size?: 'sm' | 'default'
  'aria-label'?: string
  title?: string
}): React.ReactElement {
  return (
    <Select value={value} onValueChange={onChange} disabled={disabled}>
      <SelectTrigger size={size} className={className} aria-label={ariaLabel} title={title}>
        <SelectValue placeholder={placeholder ?? '请选择'} />
      </SelectTrigger>
      <SelectContent>
        <Items options={options} />
      </SelectContent>
    </Select>
  )
}

/** 密集控件条上的胶囊下拉（生成条、工具条）。**悬停即出**。
 *
 *  用 DropdownMenu 而不是 Select：Select 只能点击打开（它要接管整个
 *  listbox 的焦点），而蓝本这一档控件全是悬停出来的。DropdownMenu 的
 *  `RadioGroup` 语义同样是单选，方向键、Home/End、打字定位也都内置，
 *  但它的 `open` 可以受控，配得上悬停。 */
export function PillPicker({
  value,
  onChange,
  options,
  label,
  placeholder,
  icon,
  disabled,
  className,
  title,
  'aria-label': ariaLabel,
}: {
  value: string
  onChange: (next: string) => void
  options: PickerOption[]
  /** 前缀标签（"模型" "质量"）。给了就显示成"标签 · 值"，与蓝本一致 */
  label?: string
  /** value 为空串时显示什么 */
  placeholder?: string
  icon?: React.ReactNode
  disabled?: boolean
  className?: string
  title?: string
  'aria-label'?: string
}): React.ReactElement {
  const current = options.find((o) => o.value === value)
  const hover = useHoverOpen(disabled !== true)

  return (
    <DropdownMenu open={hover.open} onOpenChange={hover.onOpenChange} modal={false}>
      <div
        className={cn('ui-picker', disabled !== true && 'ui-picker-hover', className)}
        {...hover.hoverProps}
      >
        <DropdownMenuTrigger asChild disabled={disabled}>
          <button
            type="button"
            className="ui-pill"
            aria-label={ariaLabel ?? label}
            title={title ?? label}
            disabled={disabled}
            onClick={hover.togglePin}
          >
            {icon}
            {label !== undefined && <span className="ui-pill-label">{label}</span>}
            {label !== undefined && <span className="ui-pill-dot" aria-hidden />}
            {/* `value` 不在 options 里时**显示它自己**而不是留白——留白的话
                调用方传错了值（枚举对不上、异步选项还没到）在界面上表现为
                一个空胶囊，看不出是"没选"还是"坏了"。 */}
            <span className="ui-pill-value">
              {current?.label ?? (value === '' ? (placeholder ?? '未选') : value)}
            </span>
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          side="top"
          align="center"
          sideOffset={8}
          className="ui-picker-menu"
          /* 菜单打开就取焦点，这是 menu 语义（方向键要立刻能用），
             DropdownMenu 也没给 `onOpenAutoFocus` 让你拦。悬停打开时它会把
             焦点从触发器移进来，鼠标移开再还回去——对 hover 流程无碍。 */
          {...hover.hoverProps}
        >
          <DropdownMenuRadioGroup
            value={value}
            onValueChange={(v) => {
              onChange(v)
              hover.setOpen(false)
            }}
          >
            {groupOptions(options).map(([name, list], gi) => (
              <React.Fragment key={name || `g${gi}`}>
                {gi > 0 && <DropdownMenuSeparator />}
                {name !== '' && <DropdownMenuLabel>{name}</DropdownMenuLabel>}
                {list.map((o) => (
                  <DropdownMenuRadioItem key={o.value} value={o.value} disabled={o.disabled}>
                    <span className="ui-opt">
                      <span className="ui-opt-label">{o.label}</span>
                      {o.hint !== undefined && o.hint !== '' && (
                        <span className="ui-opt-hint">{o.hint}</span>
                      )}
                    </span>
                  </DropdownMenuRadioItem>
                ))}
              </React.Fragment>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </div>
    </DropdownMenu>
  )
}

/** 「选完就执行」的动作下拉：移动到分组、批量操作、导出格式……
 *
 *  与 `Picker` 的差别是**没有选中态**——它不是在编辑一个值，而是在挑一个动作。
 *  用 Select 做这种事要靠"选完把 value 重置成空串"的小动作，
 *  那会让屏幕阅读器读出一个不存在的选中项，也让键盘用户选完后焦点无处可去。
 *  菜单才是这件事的正确语义。 */
export function ActionPicker({
  label,
  options,
  onPick,
  disabled,
  className,
  title,
}: {
  /** 触发器上的文字。它是提示不是值——"移动到分组…" */
  label: string
  options: PickerOption[]
  onPick: (value: string) => void
  disabled?: boolean
  className?: string
  title?: string
}): React.ReactElement {
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild disabled={disabled}>
        <button type="button" className={cn('ui-action', className)} disabled={disabled} title={title}>
          {label}
          <ChevronDown className="ui-action-caret" aria-hidden />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="ui-picker-menu">
        {groupOptions(options).map(([name, list], gi) => (
          <React.Fragment key={name || `g${gi}`}>
            {gi > 0 && <DropdownMenuSeparator />}
            {name !== '' && <DropdownMenuLabel>{name}</DropdownMenuLabel>}
            {list.map((o) => (
              <DropdownMenuItem key={o.value} disabled={o.disabled} onSelect={() => onPick(o.value)}>
                <span className="ui-opt">
                  <span className="ui-opt-label">{o.label}</span>
                  {o.hint !== undefined && o.hint !== '' && (
                    <span className="ui-opt-hint">{o.hint}</span>
                  )}
                </span>
              </DropdownMenuItem>
            ))}
          </React.Fragment>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** 内容不是"一列选项"时用它：分档 tab、两列、内嵌输入框。
 *
 *  用 Popover 而不是 Select，因为 Select 的内容必须是 `SelectItem`
 *  （它接管方向键与打字定位，塞输入框进去会互相打架）。
 *
 *  **悬停打开 + 悬停桥**（蓝本 `.smart-control::before` / `.smart-popover::after`）：
 *  触发器与弹层之间有 8px 间隙，鼠标斜着移过去会掉出 hover 区把弹层关掉，
 *  表现为"要点第二次"。两个伪元素把这段空隙补上——蓝本的注释自己写明了这一点。
 *  同时保留点击与键盘：`openDelay` 之外，点一下就固定住（`pinned`）。 */
export function PopoverPicker({
  trigger,
  children,
  align = 'center',
  side = 'top',
  className,
  contentClassName,
  hover: hoverEnabled = true,
}: {
  trigger: React.ReactNode
  children: React.ReactNode
  align?: 'start' | 'center' | 'end'
  side?: 'top' | 'bottom' | 'left' | 'right'
  className?: string
  contentClassName?: string
  /** 关掉就是纯点击打开。触屏与"内容很重"的弹层用得上 */
  hover?: boolean
}): React.ReactElement {
  const hover = useHoverOpen(hoverEnabled)

  return (
    <Popover open={hover.open} onOpenChange={hover.onOpenChange}>
      <div
        className={cn('ui-picker', hoverEnabled && 'ui-picker-hover', className)}
        {...hover.hoverProps}
      >
        <PopoverTrigger asChild onClick={hover.togglePin}>
          {trigger}
        </PopoverTrigger>
        <PopoverContent
          side={side}
          align={align}
          sideOffset={8}
          className={cn('ui-picker-pop', contentClassName)}
          onOpenAutoFocus={(e) => {
            if (!hover.pinned) e.preventDefault()
          }}
          {...hover.hoverProps}
        >
          {children}
        </PopoverContent>
      </div>
    </Popover>
  )
}
