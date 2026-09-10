/* 模型调用账本。

   这个页面只可观测，不承担任何配置职责：供应商凭据、模型部署、调用协议与能力绑定
   全部收到 /settings/models 一处（合同 C1）。这里剩下的是账本表、逐条检视器，
   和一个「测一下」——真调一次已绑定的能力，结果也会以 source=probe 落进同一本账。 */

import { useMutation, useQuery } from '@tanstack/react-query'
import { FlaskConical } from '@/components/NexusIcon'
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { toast } from 'sonner'

import { Picker } from '@/components/ui/picker'
import { apiConfig } from '@/lib/api-config'
import type { LlmProbeResult } from '@/lib/api-config'

import { InvocationLedger } from './InvocationLedger'
import { formatMs } from './invocation-stats'

import './model-lab.css'

function ProbePanel() {
  const bindings = useQuery({ queryKey: ['cfg-bindings'], queryFn: apiConfig.bindings })
  const options = (bindings.data ?? []).filter((row) => row.bound && row.group === 'llm')
  const [picked, setPicked] = useState('')
  const capability = picked !== '' ? picked : (options[0]?.capability ?? '')
  const [result, setResult] = useState<LlmProbeResult | null>(null)
  const probe = useMutation({
    mutationFn: () => apiConfig.llmTest(capability),
    onSuccess: (data) => {
      setResult(data)
      if (data.ok) toast.success(`${capability} 通了`)
      else toast.error(data.error ?? '调用失败')
    },
    onError: (error: Error) => {
      setResult(null)
      toast.error(error.message)
    },
  })

  return (
    <section className="mdl-probe">
      <FlaskConical aria-hidden />
      <div className="mdl-probe-body">
        <div className="mdl-probe-row">
          <strong>测一下</strong>
          <Picker
            size="sm"
            value={capability}
            onChange={setPicked}
            placeholder="选择能力"
            aria-label="要试调的能力"
            title={options.find((row) => row.capability === capability)?.label}
            options={options.map((row) => ({
              value: row.capability,
              label: row.label,
              hint: row.deployment?.upstream_model_id ?? row.target ?? undefined,
            }))}
          />
          <button
            className="btn btn-outline btn-sm"
            disabled={probe.isPending || capability === ''}
            onClick={() => probe.mutate()}
          >
            {probe.isPending ? '调用中…' : '真调一次'}
          </button>
          {options.length === 0 && !bindings.isPending && (
            <span className="mdl-probe-note">
              还没有已绑定的对话能力，先到<Link to="/settings/models">设置 · 模型服务</Link>绑一个。
            </span>
          )}
        </div>
        {result !== null && (
          <p className={result.ok ? 'mdl-probe-ok' : 'mdl-probe-bad'}>
            {result.ok ? (
              <>
                {result.model ?? '—'} · {result.transport ?? '直连'} · {formatMs(result.latency_ms)}
                {result.sample !== null && result.sample !== '' && ` · “${result.sample}”`}
              </>
            ) : (
              <>
                {result.error_type !== null ? `${result.error_type}：` : ''}
                {result.error ?? '调用失败'}
              </>
            )}
          </p>
        )}
      </div>
    </section>
  )
}

export function ModelLabPage() {
  return (
    <main className="page mdl-page">
      <header className="mdl-head">
        <div className="mdl-head-text">
          <h1>模型调用账本</h1>
          <p>
            每次真实调用一行：请求头、流式分块、用量与终态逐步入账，密钥、二进制与超长
            data URL 已在入账前移除。凭据、模型部署与能力绑定在
            <Link to="/settings/models">设置 · 模型服务</Link>里配置。
          </p>
        </div>
        <ProbePanel />
      </header>

      <InvocationLedger />
    </main>
  )
}

export default ModelLabPage
