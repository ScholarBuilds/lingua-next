/* 带即时提示的图标按钮（FR-349）。

   原生 title 要悬停一两秒才浮出来，图标密集的操作条上等于没有——
   用户根本不知道那排图标各是干什么的。radix Tooltip 的 delayDuration 为 0，
   指过去就出，且 aria-label 一并给上，读屏也能用。 */

import type { ReactNode } from 'react'

import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

interface IconActionProps {
  /** 同时用作提示文案与 aria-label */
  label: string
  children: ReactNode
  onClick: (e: React.MouseEvent<HTMLButtonElement>) => void
  active?: boolean
  disabled?: boolean
  className?: string
  side?: 'top' | 'right' | 'bottom' | 'left'
}

export function IconAction({
  label,
  children,
  onClick,
  active = false,
  disabled = false,
  className = 'icon-btn',
  side = 'top',
}: IconActionProps) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          className={`${className}${active ? ' active' : ''}`}
          aria-label={label}
          disabled={disabled}
          onClick={onClick}
        >
          {children}
        </button>
      </TooltipTrigger>
      <TooltipContent side={side}>{label}</TooltipContent>
    </Tooltip>
  )
}
