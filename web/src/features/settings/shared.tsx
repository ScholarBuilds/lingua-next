/* 配置中心共用小组件：开关 / 下拉选择 / 分组标题 / 加载与错误态。
   Sel 基于 shadcn Popover + Command（portal 渲染，永不被容器裁切；
   选项超过阈值或允许手输时自带搜索框）。 */

import { CheckIcon } from '@/components/NexusIcon'
import { useState } from 'react'
import type { ReactNode } from 'react'

import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Switch as UiSwitch } from '@/components/ui/switch'

import { IconAlert } from '../../components/icons'
import { SIconChevronDown } from './icons'

/* ---- 开关（shadcn Switch，保持旧 API） ---- */

export function Switch({
  on,
  onChange,
  disabled,
  title,
}: {
  on: boolean
  onChange: (next: boolean) => void
  disabled?: boolean
  title?: string
}) {
  return (
    <UiSwitch checked={on} onCheckedChange={onChange} disabled={disabled} title={title} />
  )
}

/* ---- 下拉选择（portal Combobox，保持旧 Sel API） ---- */

export interface SelItem {
  key: string
  label: ReactNode
  /** 搜索匹配文本（label 非纯文本时提供；缺省用 key） */
  text?: string
  active?: boolean
  onSelect: () => void
}

export interface SelGroup {
  label?: string
  items: SelItem[]
}

/** 超过该数量的选项自动出现搜索框 */
const SEARCH_THRESHOLD = 8

export function Sel({
  display,
  warn = false,
  disabled = false,
  groups,
  manual,
  onOpen,
}: {
  display: ReactNode
  warn?: boolean
  disabled?: boolean
  groups: SelGroup[]
  /** 底部手输行（模型名可手输） */
  manual?: { placeholder: string; onSubmit: (v: string) => void }
  onOpen?: () => void
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')

  const total = groups.reduce((n, g) => n + g.items.length, 0)
  const searchable = manual !== undefined || total > SEARCH_THRESHOLD
  const manualValue = query.trim()

  const submitManual = () => {
    if (manual === undefined || manualValue === '') return
    manual.onSubmit(manualValue)
    setOpen(false)
  }

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (next) {
          onOpen?.()
          setQuery('')
        }
        setOpen(next)
      }}
    >
      <PopoverTrigger asChild>
        <button type="button" className={`sel${warn ? ' warn' : ''}`} disabled={disabled}>
          <span className="sel-display">{display}</span>
          <SIconChevronDown />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-[280px] p-0" align="start">
        <Command shouldFilter={searchable}>
          {searchable && (
            <CommandInput
              placeholder={manual?.placeholder ?? '搜索…'}
              value={query}
              onValueChange={setQuery}
              onKeyDown={(e) => {
                // 手输模式：无匹配项时回车直接提交输入值
                if (e.key === 'Enter' && manual !== undefined && total === 0) submitManual()
              }}
            />
          )}
          <CommandList>
            <CommandEmpty>
              {manual !== undefined && manualValue !== '' ? (
                <button type="button" className="sel-manual-use" onClick={submitManual}>
                  使用「{manualValue}」
                </button>
              ) : (
                '暂无可选项'
              )}
            </CommandEmpty>
            {groups.map((g, i) => (
              <CommandGroup key={g.label ?? i} heading={g.label}>
                {g.items.map((it) => (
                  <CommandItem
                    key={it.key}
                    value={it.key}
                    keywords={[it.text ?? (typeof it.label === 'string' ? it.label : it.key)]}
                    onSelect={() => {
                      it.onSelect()
                      setOpen(false)
                    }}
                  >
                    <span className="sel-item-label">{it.label}</span>
                    {it.active === true && <CheckIcon className="ml-auto size-4 text-primary" />}
                  </CommandItem>
                ))}
              </CommandGroup>
            ))}
            {manual !== undefined && manualValue !== '' && total > 0 && (
              <div className="sel-manual-foot">
                <button type="button" className="sel-manual-use" onClick={submitManual}>
                  使用「{manualValue}」
                </button>
              </div>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

/* ---- 分组标题（原型 .cgroup） ---- */

/** 一行偏好项：左边说明、右边控件。配置中心各分区共用一份，别再各自复制 */
export function PrefRow({
  name,
  desc,
  children,
}: {
  name: string
  desc: string
  children: ReactNode
}) {
  return (
    <div className="pref-row">
      <div className="pref-info">
        <div className="pref-name">{name}</div>
        <div className="pref-desc">{desc}</div>
      </div>
      {children}
    </div>
  )
}

export function CGroup({ children, extra }: { children: ReactNode; extra?: ReactNode }) {
  return (
    <div className="cgroup">
      {children}
      <span className="line" />
      {extra}
    </div>
  )
}

/* ---- 区块头 ---- */

export function SecHead({ title, desc }: { title: string; desc: string }) {
  return (
    <>
      <div className="csec-title">{title}</div>
      <div className="csec-desc">{desc}</div>
    </>
  )
}

/* ---- 加载与错误态 ---- */

export function LoadingCards({ count = 2, height = 68 }: { count?: number; height?: number }) {
  return (
    <div className="stack">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="skeleton" style={{ height }} />
      ))}
    </div>
  )
}

export function ErrorBlock({
  message,
  onRetry,
}: {
  message: string
  onRetry: () => void
}) {
  return (
    <div className="state-block">
      <IconAlert />
      <div>{message}</div>
      <button className="btn btn-outline" onClick={onRetry}>
        重试
      </button>
    </div>
  )
}
