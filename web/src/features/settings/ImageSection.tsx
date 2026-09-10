/* 生图服务（模块 16 FR-418）：原生图片供应商凭据 + 通用 BindingTable 的生图分组 +
   端到端「试出一张图」+ 存储统计。

   生图能力不挂「测一下」：那条探针打的是 chat/completions，生图别名走过去必炸；
   真实验证是显式的出图按钮——一次要等十几秒，不能挂在一个看起来无害的测试按钮上自动跑。

   绑定的凭据范围是既有的 LLM 凭据：实测「gpt 中转」的模型列表里就有 gpt-image-1/1.5/2，
   生图模型与聊天模型住在同一个 OpenAI 兼容端点后面，逼用户再录一遍同一把 key 没有道理。 */

import { useMutation, useQuery } from '@tanstack/react-query'
import { useState } from 'react'

import { apiConfig } from '../../lib/api-config'
import type { Credential } from '../../lib/api-config'
import { apiImage } from '../../lib/api-image'
import { BindingTable } from './BindingTable'
import {
  AddCredButton,
  CredCard,
  CredOverlay,
  RecommendedProviderCards,
} from './credentials'
import { fmtMs } from './meta'
import { ErrorBlock, LoadingCards, SecHead, Sel } from './shared'

const DEFAULT_PROBE_CAP = 'image-free'

export function ImageSection() {
  const imageCredsQuery = useQuery({
    queryKey: ['cfg-creds', 'image'],
    queryFn: () => apiConfig.credentials('image'),
  })
  const typesQuery = useQuery({
    queryKey: ['cfg-provider-types'],
    queryFn: apiConfig.providerTypes,
    staleTime: 300_000,
  })
  const bindingsQuery = useQuery({ queryKey: ['cfg-bindings'], queryFn: apiConfig.bindings })
  const statsQuery = useQuery({ queryKey: ['img-stats'], queryFn: apiImage.stats })
  const [probeChoice, setProbeChoice] = useState<string | null>(null)
  const [overlay, setOverlay] = useState<'closed' | 'add' | Credential>('closed')
  const [presetType, setPresetType] = useState<string | null>(null)

  const imageCaps = (bindingsQuery.data ?? []).filter((row) => row.group === 'image')
  const probeCap =
    probeChoice ?? imageCaps.find((row) => row.capability === DEFAULT_PROBE_CAP)?.capability
      ?? imageCaps[0]?.capability
      ?? DEFAULT_PROBE_CAP
  const probe = useMutation({ mutationFn: () => apiImage.test(probeCap) })

  if (imageCredsQuery.isLoading) {
    return <LoadingCards count={3} />
  }
  if (imageCredsQuery.isError) {
    return (
      <ErrorBlock
        message={imageCredsQuery.error.message}
        onRetry={() => void imageCredsQuery.refetch()}
      />
    )
  }

  const nativeImageCreds = imageCredsQuery.data ?? []
  const imageTypes = (typesQuery.data ?? []).filter((type) => type.kind === 'image')

  return (
    <>
      <SecHead
        title="生图服务"
        desc="接入供应商、浏览模型，再配置用途。目录检查不生成图片；“生成测试图”会产生供应商用量。OpenAI 兼容模型复用模型服务中的凭据。"
      />

      <div className="pcard-list">
        {nativeImageCreds.map((credential) => (
          <CredCard
            key={credential.id}
            cred={credential}
            unitLabel="图片模型"
            refreshLabel="刷新模型"
            showTest
            onEdit={() => setOverlay(credential)}
          />
        ))}
      </div>
      <RecommendedProviderCards
        types={imageTypes}
        configuredTypes={new Set(nativeImageCreds.map((c) => c.provider_type))}
        onSelect={(providerType) => {
          setPresetType(providerType)
          setOverlay('add')
        }}
      />
      <AddCredButton
        text="添加图片供应商（Google Gemini…）"
        onClick={() => {
          setPresetType(null)
          setOverlay('add')
        }}
      />

      <SecHead
        title="生图服务"
        desc="把生图能力绑到具体的模型部署。OpenAI 兼容凭据与上方的 Gemini 原生图片凭据都可选。"
      />
      <div className="tier-lead">
        这里能选到的模型，来自「模型服务 · ② 模型部署」登记过的那些。下拉里找不到想要的生图
        模型，先去那一层登记一条（不少中转站的模型列表不返回生图模型，要手工补）。
      </div>

      <BindingTable groups={['image']} />

      <SecHead
        title="端到端验证"
        desc="真的调一次模型出一张小图。它比凭据「测试」慢得多，所以单独放在这里手动触发。"
      />
      <div className="card bind">
        <div className="bind-row">
          <Sel
            display={imageCaps.find((row) => row.capability === probeCap)?.label ?? probeCap}
            groups={[
              {
                items: imageCaps.map((row) => ({
                  key: row.capability,
                  label: `${row.label}（${row.capability}）`,
                  active: row.capability === probeCap,
                  onSelect: () => setProbeChoice(row.capability),
                })),
              },
            ]}
          />
          <button
            className="btn btn-outline"
            disabled={probe.isPending}
            onClick={() => probe.mutate()}
          >
            {probe.isPending ? '出图中…（十几秒）' : '试出一张图'}
          </button>
        </div>
        {probe.isError && <div className="form-err">{probe.error.message}</div>}
        {probe.data !== undefined &&
          (probe.data.ok ? (
            <div className="bind-row" style={{ alignItems: 'center' }}>
              <span className="chip ok">✓ {fmtMs(probe.data.latency_ms ?? 0)}</span>
              {probe.data.asset && (
                <img
                  src={probe.data.asset.thumb_url}
                  alt=""
                  style={{ height: 64, borderRadius: 8 }}
                />
              )}
            </div>
          ) : (
            <div className="form-err">
              [{probe.data.kind}] {probe.data.detail}
            </div>
          ))}
      </div>

      {statsQuery.data && (
        <>
          <SecHead title="存储" desc="生成图占用的磁盘。候选图是生成出来还没被采用的那些。" />
          <div className="card bind">
            <div className="bind-head">
              <span className="bind-name">
                {statsQuery.data.count} 张 · {statsQuery.data.mb} MB
              </span>
              <span className="bind-desc">其中候选图 {statsQuery.data.candidates} 张</span>
            </div>
          </div>
        </>
      )}

      {overlay !== 'closed' && (
        <CredOverlay
          kind="image"
          types={imageTypes}
          existing={overlay === 'add' ? undefined : overlay}
          initialProviderType={overlay === 'add' ? presetType ?? undefined : undefined}
          onClose={() => {
            setOverlay('closed')
            setPresetType(null)
          }}
        />
      )}
    </>
  )
}
