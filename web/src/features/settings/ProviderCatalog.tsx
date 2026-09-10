import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { apiConfig, type Credential, type ServiceProbeResult } from '../../lib/api-config'
import { apiImage } from '../../lib/api-image'
import { ServiceProbeButton } from './ServiceProbeButton'
import { VoicePicker } from '../../components/VoicePicker'

const PAGE_SIZE = 20

export function ProviderCatalog({ credential, onClose }: { credential: Credential; onClose: () => void }) {
  if (credential.kind === 'tts' || credential.kind === 'realtime') {
    return <VoicePicker title="音色目录" credential={credential} mode={credential.kind} onClose={onClose} />
  }
  return <ModelCatalog credential={credential} onClose={onClose} />
}

function ModelCatalog({ credential, onClose }: { credential: Credential; onClose: () => void }) {
  const client = useQueryClient()
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(0)
  const [items, setItems] = useState(credential.models)
  const list = useRef<HTMLDivElement>(null)
  const deployments = useQuery({ queryKey: ['catalog-deployments', credential.id],
    queryFn: () => apiConfig.modelDeployments({ credential_id: credential.id }), enabled: true })
  const enable = useMutation({ mutationFn: (id: number) => apiConfig.updateModelDeployment(id, { enabled: true }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['catalog-deployments', credential.id] })
      void client.invalidateQueries({ queryKey: ['cfg-model-deployments'] })
      void client.invalidateQueries({ queryKey: ['cfg-bindings'] })
    } })
  const refresh = useMutation({ mutationFn: () => apiConfig.refreshModels(credential.id), onSuccess: (result) => {
    setItems(result.items)
    setPage(0)
    void client.invalidateQueries({ queryKey: ['cfg-creds'] })
    void client.invalidateQueries({ queryKey: ['catalog-deployments', credential.id] })
    void client.invalidateQueries({ queryKey: ['cfg-model-deployments'] })
    void client.invalidateQueries({ queryKey: ['cfg-bindings'] })
  } })
  const entries = useMemo(() => items.flatMap((item) => {
      if (typeof item === 'string') return [{ id: item, label: item, locale: '', gender: '' }]
      if (item && typeof item === 'object' && 'id' in item && typeof item.id === 'string') {
        return [{ id: item.id, label: 'label' in item && typeof item.label === 'string' ? item.label : item.id, locale: '', gender: '' }]
      }
      return []
    }),
  [items])
  const filtered = entries.filter((entry) => `${entry.id} ${entry.label} ${entry.locale} ${entry.gender}`.toLowerCase().includes(search.toLowerCase()))
  const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))
  const currentPage = Math.min(page, pages - 1)
  useEffect(() => { if (list.current) list.current.scrollTop = 0 }, [currentPage, search])

  return <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
    <DialogContent className="provider-catalog" onEscapeKeyDown={(event) => event.stopPropagation()}>
      <DialogHeader><DialogTitle>{credential.name} · 模型目录</DialogTitle></DialogHeader>
      <p className="muted">先刷新目录，再测试具体模型。测试不修改用途绑定；生成图片会按供应商规则计费。</p>
      <div className="catalog-toolbar">
        <input aria-label="搜索目录" placeholder="搜索模型名称" value={search} onChange={(event) => { setSearch(event.target.value); setPage(0) }} />
        <button className="btn btn-outline" disabled={refresh.isPending} onClick={() => refresh.mutate()}>{refresh.isPending ? '拉取中…' : '从供应商刷新'}</button>
      </div>
      {refresh.error && <p role="alert">{refresh.error.message}</p>}
      {deployments.error && <p role="alert">模型部署加载失败：{deployments.error.message}</p>}
      {enable.error && <p role="alert">启用失败：{enable.error.message}</p>}
      <div className="catalog-list" ref={list}>
        {filtered.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE).map((entry) => {
          const deployment = deployments.data?.find((item) => item.upstream_model_id === entry.id)
          const image = deployment?.media_types.includes('image')
          const supported = deployment && (image || deployment.media_types.includes('chat'))
          const run = async (): Promise<ServiceProbeResult> => {
            if (!deployment) throw new Error('请先刷新目录登记模型')
            if (image) {
              const result = await apiImage.test('image-free', deployment.id)
              return { ok: result.ok, latency_ms: result.latency_ms ?? 0, detail: result.ok ? '图片生成完成，已保存到图库' : result.detail ?? '生图失败' }
            }
            const result = await apiConfig.llmTest('catalog-probe', deployment.id)
            return { ok: result.ok, latency_ms: result.latency_ms, detail: result.error ?? result.sample ?? '模型返回有效内容' }
          }
          return <div className="catalog-entry" key={entry.id}>
            <div><strong>{entry.label}</strong><span>{deployment?.media_types.join(' / ') ?? '未登记'}</span><code>{entry.id}</code></div>
            <div className="catalog-entry-actions">{deployment && !deployment.enabled && <button className="btn-ghost-sm" disabled={enable.isPending || !credential.enabled}
              onClick={() => enable.mutate(deployment.id)}>已停用 · 启用模型</button>}
            {supported ? <ServiceProbeButton disabled={!credential.enabled || deployment?.enabled === false} run={run} label={image ? '生成测试图（计费）' : '测试模型'} /> : <span className="muted">请在对应创作工具中测试{deployment?.media_types.join(' / ')}</span>}</div>
          </div>
        })}
        {!filtered.length && <p className="catalog-empty">{items.length ? '没有匹配的结果' : '目录尚未拉取，点击“从供应商刷新”获取可用项目。'}</p>}
      </div>
      <div className="catalog-footer"><span>{filtered.length} 项 · 第 {currentPage + 1} / {pages} 页</span><div>
        <button className="btn btn-outline" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>上一页</button>
        <button className="btn btn-outline" disabled={currentPage + 1 >= pages} onClick={() => setPage(currentPage + 1)}>下一页</button>
      </div></div>
    </DialogContent>
  </Dialog>
}
