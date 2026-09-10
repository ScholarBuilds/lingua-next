/* 细节增强（模块 17 FR-474）。类名前缀 stl-（与角度控制共用 studio-tools.css）。

   一句话：拿一张已入库的图当底，按服务端给的强度档重画一遍，前后拖着看。

   两条硬边界：
   - **提示词不在前端**。强度档的 `prompt` 全部来自 `apiStudio.catalog()`，载不出来
     就不给增强——宁可停在这儿，也不本地硬编码一份出来救场（那份将来必然与服务端
     不同步，且没法测）。
   - **不叫超分**。这条通路上没有超分模型，增强是重绘不是放大像素（BR-150 / BR-110）。
     `enhance_note` 常驻在参数区，结果出来后再用真实尺寸印证一次。

   页头与下载助手已搬到 StudioToolShell：留在这里的话，角度控制页 import 它们就得
   把整个增强页拖进自己的 chunk。 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { useQuery } from '@tanstack/react-query'
import { toast } from 'sonner'
import { ArrowLeftRight, Download, ImagePlus, RefreshCw, Sparkles } from '@/components/NexusIcon'

import type { ImageAsset } from '../../lib/api-image'
import { runImageEditTask } from '../../lib/image-edit-task'
import { apiStudio } from '../../lib/api-studio'
import { AssetPicker } from './AssetPicker'
import { ToolHeader, downloadAsset } from './StudioToolShell'
import { useInitialImageAsset } from './useInitialImageAsset'
// AssetPicker 的样式（scv-picker 那一组）住在 canvas.css，用它就得带上它
import './canvas.css'
import './studio-tools.css'

const QUALITIES: Array<[string, string]> = [
  ['low', '低'],
  ['medium', '中'],
  ['high', '高'],
]

/** 前后对比滑块：同一容器叠两张图，上层按手柄位置裁切。
 *  鼠标与触摸都走 Pointer Events 一条路，不各写一套。 */
function CompareSlider({ before, after }: { before: ImageAsset; after: ImageAsset }): JSX.Element {
  const [pos, setPos] = useState(50)
  const stageRef = useRef<HTMLDivElement | null>(null)
  const dragging = useRef(false)

  const moveTo = useCallback((clientX: number) => {
    const el = stageRef.current
    if (el === null) return
    const rect = el.getBoundingClientRect()
    // 几何量为 0 时（内嵌浏览器面板里 body 都量成 0）除下去只会得到 NaN
    if (rect.width === 0) return
    const next = ((clientX - rect.left) / rect.width) * 100
    setPos(Math.min(100, Math.max(0, next)))
  }, [])

  const nudge = (delta: number): void => {
    setPos((prev) => Math.min(100, Math.max(0, prev + delta)))
  }

  return (
    <div
      ref={stageRef}
      className="stl-stage"
      style={{ '--stl-ar': before.width / Math.max(1, before.height) } as CSSProperties}
      onPointerDown={(e) => {
        dragging.current = true
        e.currentTarget.setPointerCapture(e.pointerId)
        moveTo(e.clientX)
      }}
      onPointerMove={(e) => {
        if (dragging.current) moveTo(e.clientX)
      }}
      onPointerUp={(e) => {
        dragging.current = false
        if (e.currentTarget.hasPointerCapture(e.pointerId)) {
          e.currentTarget.releasePointerCapture(e.pointerId)
        }
      }}
      onPointerCancel={() => {
        dragging.current = false
      }}
    >
      <img className="stl-layer" src={before.full_url} alt="原图" draggable={false} />
      <img
        className="stl-layer"
        src={after.full_url}
        alt="增强后"
        draggable={false}
        style={{ clipPath: `inset(0 0 0 ${pos}%)` }}
      />
      <span className="stl-tag stl-tag-a">原图</span>
      <span className="stl-tag stl-tag-b">增强后</span>
      <div
        className="stl-handle"
        style={{ left: `${pos}%` }}
        role="slider"
        aria-label="前后对比位置"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(pos)}
        tabIndex={0}
        onKeyDown={(e) => {
          const step = e.shiftKey ? 10 : 2
          if (e.key === 'ArrowLeft') nudge(-step)
          else if (e.key === 'ArrowRight') nudge(step)
          else if (e.key === 'Home') setPos(0)
          else if (e.key === 'End') setPos(100)
          else return
          e.preventDefault()
        }}
      >
        <span className="stl-grip">
          <ArrowLeftRight />
        </span>
      </div>
    </div>
  )
}

/** 尺寸对比。像素量相近时顺带印证 note 的说法——空口说「不放大」不如给两个数 */
function SizeCompare({ before, after }: { before: ImageAsset; after: ImageAsset }): JSX.Element {
  const oldPixels = before.width * before.height
  const newPixels = after.width * after.height
  const delta = oldPixels === 0 ? 0 : (newPixels - oldPixels) / oldPixels
  const close = Math.abs(delta) <= 0.05
  const mp = (n: number): string => (n / 1_000_000).toFixed(2)
  const pct = `${delta >= 0 ? '+' : ''}${(delta * 100).toFixed(1)}%`
  return (
    <div className="stl-sizes">
      <span className="stl-sizes-main">
        {before.width}×{before.height}（{mp(oldPixels)} MP） → {after.width}×{after.height}（
        {mp(newPixels)} MP），像素量 {pct}
      </span>
      <span className="stl-sizes-note">
        {close
          ? '像素量基本没变，正好印证上面那句：这是重绘式增强，改的是细节与清晰度，不放大像素。'
          : '像素量变了，但这是上游按自己的档位取整返回的尺寸，不是超分——这条通路上没有超分模型。'}
      </span>
    </div>
  )
}

export default function EnhancePage(): JSX.Element {
  const [source, setSource] = useState<ImageAsset | null>(null)
  const [result, setResult] = useState<ImageAsset | null>(null)
  const [picking, setPicking] = useState(false)
  const [presetKey, setPresetKey] = useState<string | null>(null)
  const [quality, setQuality] = useState('medium')
  const [view, setView] = useState<'overlay' | 'side'>('overlay')
  const [busySince, setBusySince] = useState<number | null>(null)
  const [elapsed, setElapsed] = useState(0)

  const catalog = useQuery({ queryKey: ['studio-catalog'], queryFn: () => apiStudio.catalog() })
  const presets = catalog.data?.enhance_presets ?? []
  // 用户没选过就取第一档；选过的档在换目录时可能不存在了，同样回落
  const preset = presets.find((p) => p.key === presetKey) ?? presets[0] ?? null
  const busy = busySince !== null

  useEffect(() => {
    if (busySince === null) {
      setElapsed(0)
      return
    }
    const id = window.setInterval(
      () => setElapsed(Math.round((Date.now() - busySince) / 1000)),
      250,
    )
    return () => window.clearInterval(id)
  }, [busySince])

  const run = useCallback(async () => {
    if (source === null || preset === null || busySince !== null) return
    setBusySince(Date.now())
    try {
      const form = new FormData()
      form.set('prompt', preset.prompt)
      form.set('app_key', 'enhance_detail')
      form.set('alias', 'image-free')
      form.set('quality', quality)
      form.set('n', '1')
      // 已入库的图按资产 id 直引，服务端从存储直读，不下载再上传（BR-144）。
      // 不传 size：跟随原图比例，传了反而会被上游按档位取整改掉
      form.set('ref_asset_ids', String(source.id))
      const items = await runImageEditTask(form, {
        toolId: 'enhance',
        sourceRoute: '/studio/enhance',
        sourceContext: { asset_id: source.id },
      })
      const first = items[0]
      if (first === undefined) throw new Error('上游没有返回图片')
      setResult(first)
      setView('overlay')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '增强失败')
    } finally {
      setBusySince(null)
    }
  }, [source, preset, quality, busySince])

  const pick = (asset: ImageAsset): void => {
    setSource(asset)
    setResult(null)
  }
  useInitialImageAsset(pick)

  const catalogError =
    catalog.isError && (catalog.error instanceof Error ? catalog.error.message : '未知错误')

  return (
    <main className="page stl-page">
      <ToolHeader
        icon={<Sparkles />}
        title="细节增强"
        sub="以选中的图为底重画一遍，把细节与清晰度做上去。不是超分：像素量不变，出图完了会用真实尺寸给你核对。"
        hasImage={source !== null}
        onPickImage={() => setPicking(true)}
      />

      {source === null ? (
        <div className="stl-blank">
          <span className="stl-blank-icon">
            <Sparkles />
          </span>
          <span className="stl-blank-title">先选一张要增强的图</span>
          <p className="stl-blank-hint">
            资产库里挑一张，或直接上传本地图片。增强会以它为底重画，原图留在资产库不动。
          </p>
          <button className="btn btn-primary btn-lg" onClick={() => setPicking(true)}>
            <ImagePlus />
            选一张图
          </button>
        </div>
      ) : (
        <div className="stl-body">
          <section className="stl-main">
            {result !== null && (
              <div className="stl-bar">
                <div className="seg" role="group" aria-label="对比视图">
                  <button
                    className={view === 'overlay' ? 'active' : ''}
                    onClick={() => setView('overlay')}
                  >
                    叠加对比
                  </button>
                  <button
                    className={view === 'side' ? 'active' : ''}
                    onClick={() => setView('side')}
                  >
                    并排
                  </button>
                </div>
                <span className="stl-bar-space" />
                <button className="btn btn-outline btn-sm" disabled={busy} onClick={() => void run()}>
                  <RefreshCw />
                  再来一次
                </button>
                <button className="btn btn-outline btn-sm" onClick={() => setPicking(true)}>
                  <ImagePlus />
                  换一张图
                </button>
                <button
                  className="btn btn-outline btn-sm"
                  onClick={() => {
                    void downloadAsset(result).catch((e: unknown) =>
                      toast.error(e instanceof Error ? e.message : '下载失败'),
                    )
                  }}
                >
                  <Download />
                  下载
                </button>
              </div>
            )}

            {result !== null && view === 'overlay' ? (
              <CompareSlider before={source} after={result} />
            ) : (
              <div className="stl-pair">
                <div className="stl-cell">
                  <span className="stl-cell-label">
                    原图 · {source.width}×{source.height}
                  </span>
                  <div className="stl-cell-box">
                    <img src={source.full_url} alt="原图" />
                  </div>
                </div>
                <div className="stl-cell">
                  <span className="stl-cell-label">
                    {result === null ? '增强结果' : `增强后 · ${result.width}×${result.height}`}
                  </span>
                  {result === null ? (
                    <div className="stl-holder">
                      <Sparkles />
                      <span>
                        {busy ? `增强中… 已跑 ${elapsed}s` : '选好强度档，点右边的「增强」'}
                      </span>
                    </div>
                  ) : (
                    <div className="stl-cell-box">
                      <img src={result.full_url} alt="增强后" />
                    </div>
                  )}
                </div>
              </div>
            )}

            {result !== null && <SizeCompare before={source} after={result} />}
          </section>

          <aside className="stl-side">
            <div className="stl-block">
              <span className="stl-label">强度档</span>
              {catalog.isLoading && <p className="stl-hint">载入强度档…</p>}
              {catalogError !== false && (
                <p className="stl-err">
                  强度档载不出来：{catalogError}。增强指令归服务端所有，前端不本地兜底一份，
                  所以这会儿没法增强——先把 /studio/catalog 修好。
                </p>
              )}
              {presets.length > 0 && (
                <div className="stl-picks" role="group" aria-label="强度档">
                  {presets.map((p) => (
                    <button
                      key={p.key}
                      className={preset !== null && p.key === preset.key ? 'stl-pick-on' : ''}
                      onClick={() => setPresetKey(p.key)}
                    >
                      {p.label}
                    </button>
                  ))}
                </div>
              )}
              {preset !== null && <p className="stl-hint">{preset.hint}</p>}
            </div>

            {catalog.data !== undefined && catalog.data.enhance_note !== '' && (
              <p className="stl-note">{catalog.data.enhance_note}</p>
            )}

            <div className="stl-block">
              <span className="stl-label">输出质量</span>
              <div className="seg" role="group" aria-label="输出质量">
                {QUALITIES.map(([key, label]) => (
                  <button
                    key={key}
                    className={quality === key ? 'active' : ''}
                    onClick={() => setQuality(key)}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <p className="stl-hint">
                质量档管上游渲染多细，强度档管指令说要增强到什么程度，两回事，可以叠着调。
              </p>
            </div>

            <button
              className="btn btn-primary btn-lg"
              disabled={preset === null || busy}
              onClick={() => void run()}
            >
              <Sparkles />
              {busy ? `增强中… ${elapsed}s` : '增强'}
            </button>

            <p className="stl-hint">
              原图 #{source.id} · {source.width}×{source.height} ·{' '}
              {(source.bytes / 1024).toFixed(0)} KB
            </p>
          </aside>
        </div>
      )}

      {picking && <AssetPicker onClose={() => setPicking(false)} onPick={pick} />}
    </main>
  )
}
