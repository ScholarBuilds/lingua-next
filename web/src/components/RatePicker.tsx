import { Popover, PopoverContent, PopoverTrigger } from './ui/popover'
import { useState } from 'react'
import { useFullscreenElement } from './FullscreenPortal'
import './voicePicker.css'

export const SPEECH_RATES = [0.75, 0.9, 1, 1.1, 1.25, 1.5]

export function RatePicker({ value, onChange, disabled = false, label = '语速' }: {
  value: number; onChange: (rate: number) => void; disabled?: boolean; label?: string
}) {
  const [open, setOpen] = useState(false)
  const fullscreen = useFullscreenElement()
  return <Popover open={open} onOpenChange={setOpen}>
    <PopoverTrigger asChild><button className="btn-ghost-sm" disabled={disabled} aria-label={`${label} ${value} 倍`}>
      {value.toFixed(value * 10 % 1 === 0 ? 1 : 2)}×
    </button></PopoverTrigger>
    <PopoverContent className="voice-rate-popup" align="end" portalContainer={fullscreen}>
      <strong>{label}</strong><p>选择合适的节奏</p>
      <div role="group" aria-label={label}>{SPEECH_RATES.map((rate) =>
        <button key={rate} className="btn" aria-pressed={rate === value} onClick={() => { onChange(rate); setOpen(false) }}>
          {rate}×{rate === 1 ? ' · 正常' : ''}
        </button>,
      )}</div>
    </PopoverContent>
  </Popover>
}
