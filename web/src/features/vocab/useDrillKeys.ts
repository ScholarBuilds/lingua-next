import { useEffect } from 'react'
import { overlayDepth } from '../../components/Overlay'
import { FORM_FOCUS_SELECTOR } from '../../components/ui/picker'

export function useDrillKeys(actions: Record<string, (() => void) | undefined>, enabled = true) {
  useEffect(() => {
    if (!enabled) return
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat || event.isComposing || event.metaKey || event.ctrlKey || event.altKey || overlayDepth() > 0) return
      if (event.shiftKey && event.key !== '?') return
      if (event.target instanceof Element && event.target.closest(FORM_FOCUS_SELECTOR)) return
      const action = actions[event.key.toLowerCase()]
      if (!action) return
      event.preventDefault()
      action()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [actions, enabled])
}
