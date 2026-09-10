import { ArrowLeft, Search, Settings2 } from './NexusIcon'
import { NexusVisual } from './NexusVisual'
import type { NexusDomain } from './NexusVisual'

export type BrandIconName =
  | 'accounts'
  | 'collapse'
  | 'extensions'
  | 'grammar'
  | 'mail'
  | 'read'
  | 'search'
  | 'settings'
  | 'studio'
  | 'talk'
  | 'tasks'
  | 'theme'
  | 'today'
  | 'video'
  | 'vocab'

interface BrandIconProps {
  name: BrandIconName
  className?: string
}

export function BrandIcon({ name, className = '' }: BrandIconProps) {
  const iconClass = `brand-icon${className ? ` ${className}` : ''}`
  if (name === 'search') return <Search className={iconClass} />
  if (name === 'collapse') return <ArrowLeft className={`${iconClass} brand-icon-collapse`} />
  if (name === 'theme' || name === 'settings') return <Settings2 className={iconClass} />
  return <NexusVisual name={name as NexusDomain} className={iconClass} />
}
