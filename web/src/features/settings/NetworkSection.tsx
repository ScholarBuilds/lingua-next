import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { toast } from 'sonner'

import { apiConfig, type NetworkPolicy } from '../../lib/api-config'
import { CGroup, LoadingCards, PrefRow, SecHead } from './shared'

function NetworkForm({ initial }: { initial: NetworkPolicy }) {
  const queryClient = useQueryClient()
  const [value, setValue] = useState(initial)
  const [saved, setSaved] = useState(initial)
  const save = useMutation({
    mutationFn: () => apiConfig.saveNetwork(value),
    onSuccess: (next) => {
      setValue(next)
      setSaved(next)
      queryClient.setQueryData(['cfg-network'], next)
      toast.success('网络设置已保存，新连接生效')
    },
  })
  const probe = useMutation({ mutationFn: () => apiConfig.probeNetwork(value) })
  const change = (patch: Partial<NetworkPolicy>) => {
    if (save.isPending) return
    setValue((current) => ({ ...current, ...patch }))
    probe.reset()
    save.reset()
  }
  const dirty = JSON.stringify(value) !== JSON.stringify(saved)
  return (
    <form onSubmit={(event) => { event.preventDefault(); save.mutate() }}>
      <CGroup>应用代理</CGroup>
      <div className="card pref-card">
        <PrefRow name="整个客户端使用代理" desc="模型、语音（含 Edge 免费音色）、图片、翻译、视频下载与客户端外部资源统一使用此地址。关闭后直连，不继承环境代理。">
          <label><input type="checkbox" checked={value.enabled && value.scope === 'all'} onChange={(event) => change({ enabled: event.target.checked, scope: 'all' })} /> 启用全局代理</label>
        </PrefRow>
        <PrefRow name="HTTP 代理地址" desc="使用本机代理软件的 HTTP 或混合端口；此处不会启动代理软件。服务器部署时，127.0.0.1 指服务器本身。">
          <input aria-label="HTTP 代理地址" className="network-address" value={value.address} onChange={(event) => change({ address: event.target.value })} placeholder="http://127.0.0.1:7890" autoComplete="off" spellCheck={false} />
        </PrefRow>
        <PrefRow name="本机连接始终直连" desc="localhost、127.0.0.0/8 和 ::1 不经过代理，本地 API、模型和媒体不受开关影响。"><span>自动绕过</span></PrefRow>
      </div>
      <p>当前路由：{saved.enabled ? saved.scope === 'all' ? '客户端外部请求使用代理' : '保留旧版局部代理；开启上方开关后应用到整个客户端' : '客户端直连'}。</p>
      {value.enabled && value.scope === 'selected' && <button type="button" className="btn btn-outline" onClick={() => change({ enabled: false, scope: 'all' })}>关闭旧版局部代理</button>}
      <p className="muted">只控制 NEXUS，不修改系统代理、TUN/VPN 或外部浏览器。现有语音会话请重新连接；桌面资源路由在保存后同步。服务器模式下控制的是服务器出口。</p>
      <div className="network-actions">
        <button className="btn btn-primary" type="submit" disabled={save.isPending || !dirty}>{save.isPending ? '保存中…' : '保存网络设置'}</button>
        <button className="btn btn-outline" type="button" disabled={probe.isPending} onClick={() => probe.mutate()}>{probe.isPending ? '检查中…' : '检查火山网络'}</button>
        {dirty && <span>有未保存的修改；检查使用当前填写值</span>}
      </div>
      {(save.error || probe.error) && <p role="alert">{(save.error || probe.error)?.message}</p>}
      {probe.data && <p role="status">{probe.data.route === 'proxy' ? '代理' : '直连'} · {probe.data.elapsed_ms}ms · {probe.data.message}</p>}
    </form>
  )
}

export function NetworkSection() {
  const query = useQuery({ queryKey: ['cfg-network'], queryFn: apiConfig.network, refetchOnWindowFocus: false })
  return <>
    <SecHead title="网络与代理" desc="统一管理 NEXUS 的网络出口。网络检查不发送音频、对话或模型密钥；服务鉴权与延迟请到对应供应商测试。" />
    {query.isPending && <LoadingCards />}
    {query.error && <p role="alert">网络设置加载失败：{query.error.message} <button className="btn btn-outline" onClick={() => void query.refetch()}>重试</button></p>}
    {query.data && <NetworkForm initial={query.data} />}
  </>
}
