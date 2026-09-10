import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('linguaShell', {
  openExternal: (url: string): void => {
    void ipcRenderer.invoke('shell:open-external', url)
  },
  selectDirectory: (): Promise<string | null> => ipcRenderer.invoke('shell:select-directory'),
})
