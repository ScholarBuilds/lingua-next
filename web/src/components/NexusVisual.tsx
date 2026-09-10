import type { CSSProperties, HTMLAttributes } from 'react'

export type NexusDomain =
  | 'today'
  | 'read'
  | 'video'
  | 'vocab'
  | 'grammar'
  | 'talk'
  | 'studio'
  | 'mail'
  | 'accounts'
  | 'extensions'
  | 'tasks'
  | 'settings'
  | 'image'
  | 'workflow'
  | 'canvas'
  | 'assets'

const CELLS: Record<NexusDomain, readonly [number, number]> = {
  today: [0, 0], read: [1, 0], video: [2, 0], vocab: [3, 0],
  grammar: [0, 1], talk: [1, 1], studio: [2, 1], mail: [3, 1],
  accounts: [0, 2], extensions: [1, 2], tasks: [2, 2], settings: [3, 2],
  image: [0, 3], workflow: [1, 3], canvas: [2, 3], assets: [3, 3],
}

interface NexusVisualProps extends HTMLAttributes<HTMLSpanElement> {
  name: NexusDomain
}

export function NexusVisual({ name, className = '', style, ...props }: NexusVisualProps) {
  const [column, row] = CELLS[name]
  const position = `${(column * 100) / 3}% ${(row * 100) / 3}%`
  return (
    <span
      {...props}
      className={`nexus-visual nexus-visual-${name}${className ? ` ${className}` : ''}`}
      style={{
        backgroundImage: 'url(/brand/image2/domain-atlas.webp)',
        backgroundPosition: position,
        backgroundSize: '400% 400%',
        ...style,
      } as CSSProperties}
      aria-hidden
    />
  )
}

export function nexusDomainForPath(pathname: string): NexusDomain {
  if (pathname === '/') return 'today'
  if (pathname.startsWith('/read')) return 'read'
  if (pathname.startsWith('/video')) return 'video'
  if (pathname.startsWith('/vocab')) return 'vocab'
  if (pathname.startsWith('/grammar')) return 'grammar'
  if (pathname.startsWith('/talk')) return 'talk'
  if (pathname.startsWith('/mail')) return 'mail'
  if (pathname.startsWith('/accounts')) return 'accounts'
  if (pathname.startsWith('/extensions')) return 'extensions'
  if (pathname.startsWith('/tasks')) return 'tasks'
  if (pathname.startsWith('/settings')) return 'settings'
  if (pathname.startsWith('/image')) return 'image'
  if (pathname.startsWith('/pipeline')) return 'workflow'
  if (pathname.startsWith('/studio/canvas')) return 'canvas'
  if (pathname.startsWith('/studio/assets')) return 'assets'
  return 'studio'
}
