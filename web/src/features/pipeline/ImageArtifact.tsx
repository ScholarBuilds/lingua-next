/* 生图节点的产物展示（模块 16 FR-413）。

   首版只画了张缩略图，于是出现一个荒唐的局面：**你正盯着「封面配图」这个节点，
   却看不到它实际用的提示词**——提示词明明就在 payload 里躺着，只有展开
   「原始数据」看转义过的 JSON 才找得到。

   这里把产物拆成三层，按「人最想先看到什么」排：

   1. 图本身，够大到能判断好不好看（132px 宽的缩略图判断不了封面）
   2. **画了什么**：`brief` 是 AI 把场景想成的具体画面，本来就是人话，直接列出来
   3. 完整提示词，折叠；配一个「填进提示词框」，改起来不用手抄

   尺寸/体积等元数据不从 payload 读，而是回查资产接口——payload 里的
   `size` 是**请求尺寸**，实测上游会按自己的档位放大（要 1536x608 给 1994x789），
   拿它当实际尺寸展示是错的。 */

import { useQuery } from '@tanstack/react-query'

import { Overlay } from '../../components/Overlay'
import { useState } from 'react'

import { apiImage } from '@/lib/api-image'

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

/** brief 里的字段 → 中文行名。顺序即展示顺序 */
const BRIEF_ROWS: Array<[string, string]> = [
  ['focal', '主体'],
  ['supporting', '陪衬'],
  ['setting', '环境'],
  ['mood', '情绪'],
  ['palette', '配色'],
  ['avoid', '避开'],
]

function briefText(value: unknown): string {
  if (Array.isArray(value)) return value.map(String).join(' · ')
  return typeof value === 'string' ? value : ''
}

function AssetTile({ id, applied }: { id: number; applied: boolean }) {
  const [big, setBig] = useState(false)
  const asset = useQuery({
    queryKey: ['img-asset', id],
    queryFn: () => apiImage.asset(id),
    staleTime: 5 * 60_000,
    retry: false,
  })

  return (
    <div className="ia-tile">
      <button className="ia-shot" onClick={() => setBig(true)} title="点开看原图">
        <img src={`/api/images/assets/${id}/display?v=${id}`} alt="" loading="lazy" />
      </button>
      <div className="ia-facts">
        {applied && <span className="chip ok">已设为封面</span>}
        {asset.data && (
          <>
            <span>
              {asset.data.width}×{asset.data.height}
            </span>
            <span>{fmtBytes(asset.data.bytes)}</span>
            {asset.data.quality && <span>{asset.data.quality} 档</span>}
            {/* 请求尺寸与实际不一致时说清楚，否则看着像参数没生效 */}
            {asset.data.size_req &&
              asset.data.size_req !== `${asset.data.width}x${asset.data.height}` && (
                <span className="ia-dim" title="上游按自己的档位放大，比例保持不变">
                  请求 {asset.data.size_req}
                </span>
              )}
          </>
        )}
      </div>

      {big && (
        <Overlay onClose={() => setBig(false)} card="av-img-card">
            <div className="overlay-head">
              <div className="overlay-title">
                生成图 #{id}
                {asset.data && ` · ${asset.data.width}×${asset.data.height}`}
              </div>
              <button className="icon-btn" onClick={() => setBig(false)} title="关闭">
                ✕
              </button>
            </div>
            <img src={`/api/images/assets/${id}/full?v=${id}`} alt="" />
          </Overlay>
      )}
    </div>
  )
}

export function ImageArtifact({
  ids,
  applied,
  brief,
  prompt,
  onUsePrompt,
}: {
  ids: number[]
  applied?: number
  brief?: Record<string, unknown> | null
  prompt?: string
  onUsePrompt?: (prompt: string) => void
}) {
  const [showPrompt, setShowPrompt] = useState(false)
  const rows = BRIEF_ROWS.map(([key, label]) => [label, briefText(brief?.[key])] as const).filter(
    ([, text]) => text !== '',
  )

  return (
    <div className="ia">
      <div className="ia-row">
        {ids.map((id) => (
          <AssetTile key={id} id={id} applied={id === applied} />
        ))}
      </div>

      {rows.length > 0 && (
        <div className="ia-brief">
          {/* 内容是英文的：它就是发给模型的原话，翻译一遍反而与实际用的词对不上 */}
          <div className="ia-brief-head">
            画了什么<em>AI 定的画面，英文即发给模型的原话</em>
          </div>
          <dl>
            {rows.map(([label, text]) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd>{text}</dd>
              </div>
            ))}
          </dl>
        </div>
      )}

      {prompt !== undefined && prompt !== '' && (
        <div className="ia-prompt">
          <div className="ia-prompt-bar">
            <button className="av-raw-toggle" onClick={() => setShowPrompt((v) => !v)}>
              {showPrompt ? '收起' : '完整提示词'}
            </button>
            {onUsePrompt && (
              <button
                className="btn-ghost-sm"
                title="填进下面的提示词框，改完直接重跑"
                onClick={() => onUsePrompt(prompt)}
              >
                填进提示词框
              </button>
            )}
          </div>
          {showPrompt && <pre className="av-prompt">{prompt}</pre>}
        </div>
      )}
    </div>
  )
}
