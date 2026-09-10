/* 结果查看器（模块 16 FR-434 / FR-435）。类名前缀 ivw-，独占。

   出图之后要看清、要能顺手接着改，所以浮层分两半：左边一张大图（滚轮缩放、
   拖动平移、双击在「适应」与「1:1」之间切）配同批次缩略图条，右边是这张图的
   全部事实与下一步动作。

   **打开默认是「适应」——整张图必须完整可见**。这条踩过一次：舞台是
   `display: grid` 却没定义行列，隐式行按 `auto` 撑到内容高，图片上的
   `max-height: 100%` 于是对着「和图片一样高的网格区域」算，等于没生效——
   实测舞台 934x858、图片渲染成 768x1660，竖着有 802px 在视口外，而当时
   `MIN_SCALE = 1` 又不让缩小，图就再也拉不回来了。

   编辑链画成面包屑（BR-117）：一张图改过五轮之后，「当前这张从哪来、中间经过
   哪些操作」不画出来就说不清，而这正是要不要回退到某一环的依据。lineage 还在
   路上时给骨架占位——空白会被读成「这图没有来历」，那是假信息。 */

import type { PointerEvent as ReactPointerEvent } from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'

import { Overlay } from '@/components/Overlay'
import type { ImageApp, ImageAsset } from '@/lib/api-image'

import './ResultViewer.css'

/* 缩放倍率以「适应」为 1。允许缩到 0.2 是因为「看不全」比「看不清」更要命——
   宁可让人先缩到能一眼看完整张，再放大去抠细节。 */
const MIN_SCALE = 0.2
const MAX_SCALE = 8
const ZOOM_STEP = 1.25

/** 送进「对话编辑」的应用：照着这张图重画，比例风格都还能改 */
const CHAT_EDIT_APP = 'image_to_image'

const SOURCE_LABELS: Record<string, string> = {
  workbench: '控制台生成',
  edit: '编辑产出',
  local: '本地修图',
  pipeline: '管线自动',
}

interface View {
  scale: number
  x: number
  y: number
}

/** scale=1 就是「适应」：图片本身由 CSS 缩到刚好放得下 */
const RESET: View = { scale: 1, x: 0, y: 0 }

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

/** 平移范围按「图片放大后超出舞台的部分」算，拖到底就停，不让图飘出视野 */
function clampView(view: View, stage: HTMLDivElement | null, img: HTMLImageElement | null): View {
  if (stage === null || img === null) return view
  const maxX = Math.max(0, (img.offsetWidth * view.scale - stage.clientWidth) / 2)
  const maxY = Math.max(0, (img.offsetHeight * view.scale - stage.clientHeight) / 2)
  return { scale: view.scale, x: clamp(view.x, -maxX, maxX), y: clamp(view.y, -maxY, maxY) }
}

function fmtTime(iso: string): string {
  const t = new Date(iso)
  if (Number.isNaN(t.getTime())) return iso
  return t.toLocaleString('zh-CN', { hour12: false })
}

function fmtBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${Math.round(bytes / 1024)} KB`
}

function fmtMime(mime: string): string {
  const sub = mime.split('/')[1]
  return sub === undefined ? mime : sub.toUpperCase()
}

/** 耗时藏在 usage 里，字段名各路径不统一，取到才显示，取不到就不显示 */
function latencyOf(usage: Record<string, unknown> | null): number | null {
  if (usage === null) return null
  for (const key of ['latency_ms', 'elapsed_ms', 'duration_ms']) {
    const value = usage[key]
    if (typeof value === 'number' && Number.isFinite(value)) return value
  }
  return null
}

export function ResultViewer({
  asset,
  siblings,
  lineage,
  editApps,
  onPick,
  onSendTo,
  onRerun,
  onClose,
}: {
  asset: ImageAsset
  siblings: ImageAsset[]
  lineage: { chain: ImageAsset[]; children: ImageAsset[] } | null
  editApps: ImageApp[]
  onPick: (asset: ImageAsset) => void
  onSendTo: (appKey: string, asset: ImageAsset) => void
  onRerun: (asset: ImageAsset) => void
  onClose: () => void
}): JSX.Element {
  const stageRef = useRef<HTMLDivElement>(null)
  const imgRef = useRef<HTMLImageElement>(null)
  const drag = useRef<{ id: number; sx: number; sy: number; ox: number; oy: number } | null>(null)

  const [view, setView] = useState<View>(RESET)
  const [dragging, setDragging] = useState(false)
  const [hiRes, setHiRes] = useState(false)
  const [promptOpen, setPromptOpen] = useState(false)
  /** 「适应」态下图片实际渲染多宽。倍率要换算成人看得懂的百分比全靠它 */
  const [fitW, setFitW] = useState(0)

  // 换图就复位，否则上一张放大到 400% 的视野会原样套到下一张上
  useEffect(() => {
    setView(RESET)
    setHiRes(false)
    setPromptOpen(false)
  }, [asset.id])

  /* 量「适应」态的渲染宽度。不用 ResizeObserver：它在自动化里一次都不回调
     （本仓记过的坑），而这个量拿不到，百分比与 1:1 就全是错的。
     图片加载完、换图、换清晰度、窗口变化各量一次，足够了。 */
  const measure = useCallback(() => {
    const img = imgRef.current
    // offsetWidth 是**排版**宽度，transform 不参与，所以它恒等于「适应」态的尺寸，
    // 不用管当前缩到了多少
    if (img !== null && img.offsetWidth > 0) setFitW(img.offsetWidth)
  }, [])

  useEffect(() => {
    const onResize = () => {
      const img = imgRef.current
      if (img !== null && img.offsetWidth > 0) setFitW(img.offsetWidth)
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  /** 1 图片像素 = 1 屏幕像素时的倍率。fitW 还没量到就先按 1，不瞎猜 */
  const oneToOne = fitW > 0 && asset.width > 0 ? asset.width / fitW : 1
  /** 相对原图真实像素的缩放，就是用户心里的那个「百分比」 */
  const percent = Math.round((view.scale / oneToOne) * 100)
  // 上限至少要够得着 1:1，否则大图永远看不到原始像素
  const maxScale = Math.max(MAX_SCALE, oneToOne * 2)

  // 图放大到超出舞台才谈得上拖动。按「scale > 1」判会漏掉窄图放大后仍没超出的情况
  const stage = stageRef.current
  const img = imgRef.current
  const pannable =
    stage !== null &&
    img !== null &&
    (img.offsetWidth * view.scale > stage.clientWidth + 1 ||
      img.offsetHeight * view.scale > stage.clientHeight + 1)

  // 展示图是宽 768 的 webp，显示得比它还宽就糊了，这时才后台换原图；
  // 先加载完再切，避免闪一下空白
  const shownWidth = fitW * view.scale
  useEffect(() => {
    if (hiRes || shownWidth <= 768) return
    const probe = new Image()
    probe.onload = () => setHiRes(true)
    probe.src = asset.full_url
    return () => {
      probe.onload = null
    }
  }, [hiRes, shownWidth, asset.full_url])

  // React 把 wheel 注册成被动监听，onWheel 里 preventDefault 会被忽略并告警，只能自己挂
  useEffect(() => {
    const stage = stageRef.current
    if (stage === null) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const rect = stage.getBoundingClientRect()
      const cx = e.clientX - rect.left - rect.width / 2
      const cy = e.clientY - rect.top - rect.height / 2
      setView((prev) => {
        const scale = clamp(prev.scale * Math.exp(-e.deltaY / 400), MIN_SCALE, maxScale)
        const k = scale / prev.scale
        // 以光标为锚点缩放：光标下那个像素保持不动
        const next = { scale, x: cx - (cx - prev.x) * k, y: cy - (cy - prev.y) * k }
        return clampView(next, stage, imgRef.current)
      })
    }
    stage.addEventListener('wheel', onWheel, { passive: false })
    return () => stage.removeEventListener('wheel', onWheel)
  }, [maxScale])

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!pannable || e.button !== 0) return
    e.currentTarget.setPointerCapture(e.pointerId)
    drag.current = { id: e.pointerId, sx: e.clientX, sy: e.clientY, ox: view.x, oy: view.y }
    setDragging(true)
  }

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current
    if (d === null || d.id !== e.pointerId) return
    const moved = { scale: view.scale, x: d.ox + (e.clientX - d.sx), y: d.oy + (e.clientY - d.sy) }
    setView(clampView(moved, stageRef.current, imgRef.current))
  }

  const endDrag = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (drag.current === null) return
    drag.current = null
    setDragging(false)
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId)
    }
  }

  /** 缩放到指定倍率，位置跟着重新夹一遍——缩回去的时候图要自己归位 */
  const zoomTo = (next: number) => {
    setView((prev) =>
      clampView(
        { scale: clamp(next, MIN_SCALE, maxScale), x: prev.x, y: prev.y },
        stageRef.current,
        imgRef.current,
      ),
    )
  }
  const atFit = Math.abs(view.scale - 1) < 0.01 && view.x === 0 && view.y === 0
  const atActual = Math.abs(view.scale - oneToOne) < 0.01
  // 双击在「适应」与「1:1」之间来回切：看整体和抠细节是看图时唯一反复切换的两档
  const toggleZoom = () => (atActual ? setView(RESET) : zoomTo(oneToOne))

  const copyPrompt = useCallback(() => {
    void navigator.clipboard.writeText(asset.prompt).then(
      () => toast.success('提示词已复制'),
      () => toast.error('复制失败'),
    )
  }, [asset.prompt])

  // op 的中文名从注册表数据来，前端不另抄一份应用表
  const opLabels = useMemo(() => {
    const map = new Map<string, string>()
    for (const app of editApps) map.set(app.key, app.label)
    return map
  }, [editApps])

  const opLabel = (node: ImageAsset): string => {
    if (node.op === null) return '原图'
    return opLabels.get(node.op) ?? node.op
  }

  // 缩略图条要能看见自己在第几张；调用方传来的 siblings 未必含当前这张
  const strip = useMemo(() => {
    if (siblings.length === 0) return []
    return siblings.some((s) => s.id === asset.id) ? siblings : [asset, ...siblings]
  }, [siblings, asset])

  const advanced = editApps.filter((a) => a.engine !== 'local')
  const basics = editApps.filter((a) => a.engine === 'local')
  const chatEdit = editApps.find((a) => a.key === CHAT_EDIT_APP)

  const meta: Array<[string, string]> = [['尺寸', `${asset.width} × ${asset.height}`]]
  if (asset.size_req !== null && asset.size_req !== `${asset.width}x${asset.height}`) {
    meta.push(['请求尺寸', asset.size_req])
  }
  if (asset.model !== null) meta.push(['模型', asset.model])
  if (asset.quality !== null) meta.push(['质量档', asset.quality])
  const latency = latencyOf(asset.usage)
  if (latency !== null) meta.push(['耗时', `${(latency / 1000).toFixed(1)} 秒`])
  meta.push(['来源', SOURCE_LABELS[asset.source] ?? asset.source])
  if (asset.run_id !== null) meta.push(['管线运行', `#${asset.run_id}`])
  if (asset.step !== null) meta.push(['管线节点', asset.step])
  meta.push(['文件', `${fmtBytes(asset.bytes)} · ${fmtMime(asset.mime)}`])
  if (asset.created_at !== null) meta.push(['创建时间', fmtTime(asset.created_at)])

  const chain = lineage?.chain ?? []
  const children = lineage?.children ?? []

  return (
    <Overlay onClose={onClose} card="ivw-card" labelledBy="ivw-title">
      <div className="ivw">
        <div className="ivw-main">
          <div
            ref={stageRef}
            className={
              'ivw-stage' +
              (view.scale > 1 ? ' ivw-zoomed' : '') +
              (dragging ? ' ivw-dragging' : '')
            }
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
            onDoubleClick={toggleZoom}
          >
            <img
              ref={imgRef}
              className="ivw-canvas"
              src={hiRes ? asset.full_url : asset.url}
              alt={asset.prompt.slice(0, 80)}
              draggable={false}
              onLoad={measure}
              style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})` }}
            />
            <div className="ivw-tools" onPointerDown={(e) => e.stopPropagation()}>
              <button
                className="ivw-znob"
                onClick={() => zoomTo(view.scale / ZOOM_STEP)}
                disabled={view.scale <= MIN_SCALE + 0.001}
                aria-label="缩小"
              >
                −
              </button>
              <span className="ivw-zoom">{percent}%</span>
              <button
                className="ivw-znob"
                onClick={() => zoomTo(view.scale * ZOOM_STEP)}
                disabled={view.scale >= maxScale - 0.001}
                aria-label="放大"
              >
                +
              </button>
              <button className="btn btn-ghost-sm" onClick={() => setView(RESET)} disabled={atFit}>
                适应
              </button>
              <button className="btn btn-ghost-sm" onClick={() => zoomTo(oneToOne)} disabled={atActual}>
                1:1
              </button>
            </div>
            <p className="ivw-hint">
              滚轮缩放 · 按住拖动 · 双击在适应与 1:1 之间切
              {fitW > 0 && ` · 适应态相当于 ${Math.round((1 / oneToOne) * 100)}%`}
            </p>
          </div>

          {strip.length > 0 && (
            <div className="ivw-strip">
              {strip.map((s) => (
                <button
                  key={s.id}
                  className={`ivw-strip-item${s.id === asset.id ? ' ivw-on' : ''}`}
                  onClick={() => onPick(s)}
                  title={`#${s.id}`}
                >
                  <img src={s.thumb_url} alt="" loading="lazy" />
                </button>
              ))}
            </div>
          )}
        </div>

        <aside className="ivw-side">
          <div className="ivw-side-head">
            <b id="ivw-title">图 #{asset.id}</b>
            {asset.alias !== null && <span className="chip">{asset.alias}</span>}
            <span className="ivw-spacer" />
            <button className="icon-btn" onClick={onClose} title="关闭">
              ✕
            </button>
          </div>

          <div className="ivw-side-body">
            <section className="ivw-sec">
              <div className="ivw-sec-head">
                <span className="ivw-sec-title">生成描述词</span>
                <button className="btn btn-ghost-sm" onClick={copyPrompt}>
                  复制
                </button>
                {asset.prompt.length > 120 && (
                  <button className="btn btn-ghost-sm" onClick={() => setPromptOpen((v) => !v)}>
                    {promptOpen ? '收起' : '展开'}
                  </button>
                )}
              </div>
              {asset.prompt === '' ? (
                <p className="ivw-empty">这张图没有留下提示词</p>
              ) : (
                <p className={`ivw-prompt${promptOpen ? ' ivw-open' : ''}`}>{asset.prompt}</p>
              )}
            </section>

            <section className="ivw-sec">
              <span className="ivw-sec-title">这张图</span>
              <dl className="ivw-meta">
                {meta.map(([k, v]) => (
                  <div key={k} className="ivw-meta-row">
                    <dt>{k}</dt>
                    <dd>{v}</dd>
                  </div>
                ))}
              </dl>
            </section>

            <section className="ivw-sec">
              <span className="ivw-sec-title">编辑链</span>
              {lineage === null ? (
                <div className="ivw-skel">
                  <i />
                  <i />
                  <i />
                </div>
              ) : chain.length === 0 ? (
                <p className="ivw-empty">这是一张根图，还没被改过</p>
              ) : (
                <ol className="ivw-chain">
                  {chain.map((node, i) => (
                    <li key={node.id} className="ivw-chain-item">
                      {i > 0 && <span className="ivw-chain-arrow">›</span>}
                      <button
                        className={`ivw-chain-node${node.id === asset.id ? ' ivw-on' : ''}`}
                        onClick={() => onPick(node)}
                        title={node.created_at === null ? `#${node.id}` : fmtTime(node.created_at)}
                      >
                        <img src={node.thumb_url} alt="" loading="lazy" />
                        <span className="ivw-chain-op">{opLabel(node)}</span>
                      </button>
                    </li>
                  ))}
                </ol>
              )}
              {children.length > 0 && (
                <div className="ivw-kids">
                  <span className="ivw-kids-label">
                    {children.length > 1 ? `还有 ${children.length} 个分支` : '衍生'}
                  </span>
                  {children.map((kid) => (
                    <button
                      key={kid.id}
                      className="ivw-chain-node"
                      onClick={() => onPick(kid)}
                      title={`#${kid.id}`}
                    >
                      <img src={kid.thumb_url} alt="" loading="lazy" />
                      <span className="ivw-chain-op">{opLabel(kid)}</span>
                    </button>
                  ))}
                </div>
              )}
            </section>

            <div className="ivw-acts">
              <button className="btn btn-primary" onClick={() => onRerun(asset)}>
                再来一张
              </button>
              {chatEdit !== undefined && (
                <button
                  className="btn btn-outline"
                  onClick={() => onSendTo(chatEdit.key, asset)}
                  title={chatEdit.hint}
                >
                  对话编辑
                </button>
              )}
            </div>

            {advanced.length > 0 && (
              <section className="ivw-sec">
                <span className="ivw-sec-title">进阶编辑</span>
                <div className="ivw-apps">
                  {advanced.map((app) => (
                    <button
                      key={app.key}
                      className="ivw-app"
                      onClick={() => onSendTo(app.key, asset)}
                      title={app.hint}
                    >
                      <b>{app.label}</b>
                      {app.badge !== null && <em className="ivw-app-badge">{app.badge}</em>}
                    </button>
                  ))}
                </div>
              </section>
            )}

            {basics.length > 0 && (
              <section className="ivw-sec">
                <span className="ivw-sec-title">基础修图</span>
                <div className="ivw-apps">
                  {basics.map((app) => (
                    <button
                      key={app.key}
                      className="ivw-app"
                      onClick={() => onSendTo(app.key, asset)}
                      title={app.hint}
                    >
                      <b>{app.label}</b>
                      <em className="ivw-app-badge ivw-free">浏览器内</em>
                    </button>
                  ))}
                </div>
              </section>
            )}

            <a className="btn btn-outline ivw-download" href={asset.full_url} download>
              下载原图
            </a>
          </div>
        </aside>
      </div>
    </Overlay>
  )
}
