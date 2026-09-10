export interface LinguaShell {
  openExternal(url: string): void
  saveFile?(target: { url: string; filename: string }): void
  selectDirectory(): Promise<string | null>
}

export const SHELL_MEMBERS = ['openExternal', 'selectDirectory'] as const satisfies readonly (keyof LinguaShell)[]

declare global {
  interface Window {
    linguaShell?: LinguaShell
  }
}

export function hasShell(): boolean {
  return typeof window !== 'undefined' && window.linguaShell !== undefined
}

export function openExternal(url: string): void {
  if (window.linguaShell !== undefined) {
    window.linguaShell.openExternal(url)
    return
  }
  window.open(url, '_blank', 'noopener,noreferrer')
}

export async function selectDirectory(): Promise<string | null> {
  return window.linguaShell?.selectDirectory?.() ?? null
}

export function saveFile(source: Blob | string, filename: string): void {
  const fromBlob = source instanceof Blob
  const url = fromBlob ? URL.createObjectURL(source) : source
  if (!fromBlob && window.linguaShell?.saveFile !== undefined) {
    window.linguaShell.saveFile({ url, filename })
    return
  }
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.append(anchor)
  anchor.click()
  anchor.remove()
  if (fromBlob) window.setTimeout(() => URL.revokeObjectURL(url), 10_000)
}
