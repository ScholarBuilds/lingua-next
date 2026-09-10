export interface LinguaShell {
  openExternal(url: string): void
  selectDirectory(): Promise<string | null>
  saveFile?(target: { url: string; filename: string }): void
}

export const SHELL_MEMBERS: ReadonlyArray<keyof LinguaShell> = ['openExternal', 'selectDirectory']
