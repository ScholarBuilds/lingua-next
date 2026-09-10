/* 宫格工具（模块 17 · FR-481）。类名前缀 ssm-，样式在 studio-small.css。

   画布编辑器里的宫格切分/拼接原本只有「先建一张画布、把图放上去、开节点菜单」才够得着。
   这两件事本身跟画布没有半点关系——切一张九宫格用不着无限画布，所以提成独立工具页，
   选张图就能用。

   两档都是纯前端：像素在浏览器里搬完再走 `/images/local` 入库（source=local，
   BR-118），血缘照样落到原图上（BR-140）。

   > 几何助手（loadImage / fitScale / composeGrid 等）与 CanvasEditor.tsx 里的是同一套。
   > 那份是模块私有的，抽成共享模块要改 CanvasEditor.tsx——本轮文件归属不含它，
   > 所以这里先各存一份，抽取记为余项。两处的常量与算法保持逐字一致，改动要同步。 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Combine, Download, Grid3x3, ImagePlus, Scissors } from '@/components/NexusIcon'

import { apiImage } from '../../lib/api-image'
import type { ImageAsset } from '../../lib/api-image'
import { AssetPicker } from './AssetPicker'
import { downloadAsset } from './StudioToolShell'
import { useInitialImageAsset } from './useInitialImageAsset'
// AssetPicker 的样式（scv-picker 那一组）住在 canvas.css，用它就得带上它
import './canvas.css'
// 页壳与两栏骨架（stl-page/stl-blank/stl-body/stl-side…）与增强、角度两页同源
import './studio-tools.css'
import './studio-small.css'

/** 单张产物的长边上限。几千万像素的画布会把浏览器卡死，切之前先压到这个数 */
const MAX_EDGE = 2048
/** 拼接成品的长边上限。单张已按 MAX_EDGE 压过一轮，网格再套同一个数会把 2×2 压得太狠 */
const MAX_JOIN_EDGE = 4096
/** 拼接成品的总面积上限。iOS Safari 的画布上限就在这一档，超了整张空白且**不报错** */
const MAX_JOIN_AREA = 16_000_000

const SPLIT_PRESETS: Array<{ key: string; label: string; cols: number; rows: number }> = [
  { key: '2x2', label: '2 × 2', cols: 2, rows: 2 },
  { key: '3x3', label: '3 × 3', cols: 3, rows: 3 },
  { key: '2x1', label: '2 × 1', cols: 2, rows: 1 },
  { key: '1x2', label: '1 × 2', cols: 1, rows: 2 },
]

/* ==================== 通用助手 ==================== */

function clamp(value: number, lo: number, hi: number): number {
  if (hi < lo) return lo
  if (value < lo) return lo
  return value > hi ? hi : value
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const el = new window.Image()
    // crossOrigin 必须在 src 之前设：晚一步浏览器已按无凭证模式发出请求，
    // 图能显示但画布被判定为污染，导出时才炸
    el.crossOrigin = 'anonymous'
    el.onload = () => resolve(el)
    el.onerror = () => reject(new Error('图片加载失败：地址取不到，或对方站点没放行跨域读取'))
    el.src = src
  })
}

function newCanvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(w))
  canvas.height = Math.max(1, Math.round(h))
  const ctx = canvas.getContext('2d')
  if (ctx === null) throw new Error('浏览器没有给出 2D 画布上下文，无法导出图片')
  return [canvas, ctx]
}

function toPng(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    // 画布被污染时 toBlob 同步抛 SecurityError，在 executor 里抛出即转成 reject
    canvas.toBlob((blob) => {
      if (blob === null) {
        reject(new Error('浏览器没能把画布编码成 PNG'))
        return
      }
      resolve(blob)
    }, 'image/png')
  })
}

/** 长边超过 limit 时给出缩放比，否则 1 */
function fitScale(w: number, h: number, limit = MAX_EDGE): number {
  const long = Math.max(w, h)
  return long > limit ? limit / long : 1
}

/** 拼接成品的缩放比：长边与总面积两条线，取更紧的那条 */
function joinScale(w: number, h: number): number {
  const byEdge = fitScale(w, h, MAX_JOIN_EDGE)
  const area = w * byEdge * (h * byEdge)
  return byEdge * (area > MAX_JOIN_AREA ? Math.sqrt(MAX_JOIN_AREA / area) : 1)
}

function readError(err: unknown, fallback: string): string {
  if (err instanceof DOMException && err.name === 'SecurityError') {
    return '这张图来自其他站点且没放行跨域读取（CORS），浏览器禁止从画布里取像素。先把它存进资产库再来处理。'
  }
  return err instanceof Error ? err.message : fallback
}

/** 存一张纯前端产物。source=local（BR-118） */
async function saveLocal(blob: Blob, op: string, parentId: number, note: string): Promise<ImageAsset> {
  const form = new FormData()
  form.set('image', blob, `${op}.png`)
  form.set('op', op)
  form.set('parent_id', String(parentId))
  form.set('note', note)
  return apiImage.saveLocal(form)
}

/** 组件卸载后别再往 state 里写：请求可能飞在半路，用户已经切走了 */
function useAlive(): { current: boolean } {
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])
  return alive
}

function useBoxSize(): [(el: HTMLDivElement | null) => void, { w: number; h: number }] {
  const [el, setEl] = useState<HTMLDivElement | null>(null)
  const [size, setSize] = useState({ w: 720, h: 420 })
  useEffect(() => {
    if (el === null) return
    const observer = new ResizeObserver(() => {
      if (el.clientWidth > 0 && el.clientHeight > 0) {
        setSize({ w: el.clientWidth, h: el.clientHeight })
      }
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [el])
  return [setEl, size]
}

/** 画面在舞台里的摆放：缩放比与左上偏移，全部由容器实测尺寸反推 */
function layout(
  box: { w: number; h: number },
  natW: number,
  natH: number,
  pad: number,
): { w: number; h: number; x: number; y: number } {
  if (natW <= 0 || natH <= 0) return { w: 0, h: 0, x: 0, y: 0 }
  const scale = Math.max(0.02, Math.min((box.w - pad * 2) / natW, (box.h - pad * 2) / natH, 1))
  const w = natW * scale
  const h = natH * scale
  return { w, h, x: (box.w - w) / 2, y: (box.h - h) / 2 }
}

/** 第 i 条分割线的像素位置。用 round 分摊余数，各格最多差 1 像素 */
function edgeAt(index: number, count: number, total: number): number {
  return Math.round((index * total) / count)
}

function ShotGrid({ items }: { items: ImageAsset[] }): JSX.Element {
  return (
    <div className="ssm-shots">
      {items.map((s) => (
        <figure className="ssm-shot" key={s.id}>
          <img src={s.thumb_url} alt="" loading="lazy" />
          <figcaption>
            <span className="ssm-shot-id">
              {s.id} · {s.width}×{s.height}
            </span>
            <button
              className="btn-ghost-sm"
              aria-label={`下载 asset ${s.id}`}
              onClick={() => {
                void downloadAsset(s).catch((e: unknown) =>
                  toast.error(e instanceof Error ? e.message : '下载失败'),
                )
              }}
            >
              <Download />
            </button>
          </figcaption>
        </figure>
      ))}
    </div>
  )
}

function NumBox({
  label,
  value,
  disabled,
  onChange,
}: {
  label: string
  value: number
  disabled: boolean
  onChange: (v: number) => void
}): JSX.Element {
  return (
    <label className="ssm-numbox">
      {label}
      <input
        className="ssm-num"
        type="number"
        min={1}
        max={5}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(clamp(Math.round(Number(e.target.value) || 1), 1, 5))}
      />
    </label>
  )
}

/* ==================== 切分 ==================== */

function SplitTool({ initialAsset }: { initialAsset: ImageAsset | null }): JSX.Element {
  const [asset, setAsset] = useState<ImageAsset | null>(initialAsset)
  const [picking, setPicking] = useState(false)
  const [img, setImg] = useState<HTMLImageElement | null>(null)
  const [loadErr, setLoadErr] = useState<string | null>(null)
  const [cols, setCols] = useState(2)
  const [rows, setRows] = useState(2)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<string | null>(null)
  const [results, setResults] = useState<ImageAsset[]>([])
  const [setBox, box] = useBoxSize()
  const alive = useAlive()
  const queryClient = useQueryClient()

  useEffect(() => {
    if (initialAsset === null) return
    setAsset(initialAsset)
    setResults([])
  }, [initialAsset])

  const src = asset?.full_url ?? null
  useEffect(() => {
    if (src === null) return
    let live = true
    setImg(null)
    setLoadErr(null)
    void loadImage(src).then(
      (el) => {
        if (live) setImg(el)
      },
      (e: unknown) => {
        if (live) setLoadErr(readError(e, '图片加载失败'))
      },
    )
    return () => {
      live = false
    }
  }, [src])

  const natW = img?.naturalWidth ?? asset?.width ?? 0
  const natH = img?.naturalHeight ?? asset?.height ?? 0
  const view = layout(box, natW, natH, 22)
  const total = cols * rows
  const cellW = cols > 0 ? Math.round(natW / cols) : 0
  const cellH = rows > 0 ? Math.round(natH / rows) : 0
  const shrink = fitScale(cellW, cellH)

  const submit = async (): Promise<void> => {
    if (img === null || asset === null || busy) return
    setBusy(true)
    const saved: ImageAsset[] = []
    try {
      for (let r = 0; r < rows; r += 1) {
        for (let c = 0; c < cols; c += 1) {
          const x = edgeAt(c, cols, img.naturalWidth)
          const y = edgeAt(r, rows, img.naturalHeight)
          const w = edgeAt(c + 1, cols, img.naturalWidth) - x
          const h = edgeAt(r + 1, rows, img.naturalHeight) - y
          const k = fitScale(w, h)
          const [canvas, ctx] = newCanvas(w * k, h * k)
          ctx.imageSmoothingQuality = 'high'
          ctx.drawImage(img, x, y, w, h, 0, 0, canvas.width, canvas.height)
          setStatus(`正在切第 ${saved.length + 1}/${total} 张…`)
          saved.push(
            await saveLocal(
              await toPng(canvas),
              'split',
              asset.id,
              `宫格切分 ${cols}×${rows}，第 ${r + 1} 行第 ${c + 1} 列`,
            ),
          )
        }
      }
      if (!alive.current) return
      setResults(saved)
      // 切出来的图要能立刻在拼接那档挑到，否则得刷新页面才看得见
      void queryClient.invalidateQueries({ queryKey: ['ssm-join-pool'] })
      toast.success(`切成 ${saved.length} 张并存进资产库`)
    } catch (e) {
      if (!alive.current) return
      const detail = readError(e, '切分失败')
      // 已经存进去的那几张是真进了资产库，照实报出来，也照样列出来
      toast.error(
        saved.length > 0
          ? `切到第 ${saved.length + 1} 张时失败：${detail}（前 ${saved.length} 张已入库）`
          : detail,
      )
      if (saved.length > 0) setResults(saved)
    } finally {
      if (alive.current) {
        setBusy(false)
        setStatus(null)
      }
    }
  }

  if (asset === null) {
    return (
      <>
        <div className="stl-blank">
          <span className="stl-blank-icon">
            <Scissors />
          </span>
          <span className="stl-blank-title">先选一张要切的图</span>
          <p className="stl-blank-hint">
            资产库里挑一张，或直接上传本地图片。切出来的每一格都单独入库，血缘指向原图。
          </p>
          <button className="btn btn-primary btn-lg" onClick={() => setPicking(true)}>
            <ImagePlus />
            选一张图
          </button>
        </div>
        {picking ? (
          <AssetPicker
            onClose={() => setPicking(false)}
            onPick={(a) => {
              setAsset(a)
              setResults([])
            }}
          />
        ) : null}
      </>
    )
  }

  return (
    <>
      <div className="stl-body">
        <section className="stl-main">
          <div className="ssm-stage stl-wide" ref={setBox}>
            {loadErr !== null ? <p className="ssm-msg ssm-msg-bad">{loadErr}</p> : null}
            {loadErr === null && img === null ? <p className="ssm-msg">图片加载中…</p> : null}
            {img !== null ? (
              <div
                className="ssm-plate"
                style={{ left: view.x, top: view.y, width: view.w, height: view.h }}
              >
                <img src={img.src} alt="" draggable={false} />
                {Array.from({ length: cols - 1 }, (_, i) => (
                  <span
                    key={`v${i}`}
                    className="ssm-line"
                    style={{ left: edgeAt(i + 1, cols, view.w), top: 0, width: 1, height: '100%' }}
                  />
                ))}
                {Array.from({ length: rows - 1 }, (_, i) => (
                  <span
                    key={`h${i}`}
                    className="ssm-line"
                    style={{ top: edgeAt(i + 1, rows, view.h), left: 0, height: 1, width: '100%' }}
                  />
                ))}
              </div>
            ) : null}
          </div>

          {results.length > 0 ? (
            <div className="stl-wide">
              <p className="stl-hint ssm-tip">切好的 {results.length} 张，全部已入资产库：</p>
              <ShotGrid items={results} />
            </div>
          ) : null}
        </section>

        <aside className="stl-side">
          <div className="stl-block">
            <span className="stl-label">这张图</span>
            <p className="ssm-nums">
              asset {asset.id}
              <br />
              {natW}×{natH}
            </p>
            <button className="btn btn-outline btn-sm" onClick={() => setPicking(true)}>
              <ImagePlus />
              换一张图
            </button>
          </div>

          <div className="stl-block">
            <span className="stl-label">常用</span>
            <div className="ssm-chips">
              {SPLIT_PRESETS.map((p) => (
                <button
                  key={p.key}
                  className={cols === p.cols && rows === p.rows ? 'ssm-chip ssm-chip-on' : 'ssm-chip'}
                  disabled={busy}
                  onClick={() => {
                    setCols(p.cols)
                    setRows(p.rows)
                  }}
                >
                  {p.label}
                </button>
              ))}
            </div>
            <p className="stl-hint">标的是「列 × 行」。</p>
          </div>

          <div className="stl-block">
            <span className="stl-label">自定义</span>
            <div className="ssm-numrow">
              <NumBox label="列" value={cols} disabled={busy} onChange={setCols} />
              <NumBox label="行" value={rows} disabled={busy} onChange={setRows} />
            </div>
            <p className="stl-hint">各 1~5。</p>
          </div>

          <div className="stl-block">
            <span className="stl-label">切出来是什么</span>
            <p className="ssm-nums">
              每格约 {cellW}×{cellH}
              <br />共 {total} 张
            </p>
            <p className="stl-hint">
              除不尽的余数分摊到各格，最多差 1 像素。导出为 PNG（无损）。
              {shrink < 1
                ? `单格长边超过 ${MAX_EDGE}px，会按长边 ${MAX_EDGE} 等比缩小后再入库。`
                : ''}
            </p>
            {total === 1 ? (
              <p className="stl-hint">1 列 1 行等于没切，存出来只是原图的一份 PNG 副本。</p>
            ) : null}
          </div>

          <div className="stl-block">
            <p className="stl-hint">{status ?? `${total} 张逐张入库，血缘都指向 asset ${asset.id}`}</p>
            <button className="btn btn-primary" disabled={busy || img === null} onClick={() => void submit()}>
              <Scissors />
              {busy ? '处理中…' : `切成 ${total} 张`}
            </button>
          </div>
        </aside>
      </div>

      {picking ? (
        <AssetPicker
          onClose={() => setPicking(false)}
          onPick={(a) => {
            setAsset(a)
            setResults([])
          }}
        />
      ) : null}
    </>
  )
}

/* ==================== 拼接 ==================== */

/** 把若干张图排成网格画到一张画布上。
 *  每格取所有图里最大的那个尺寸，图在格内居中不放大——不同尺寸的图混排才不会被拉变形 */
function composeGrid(
  canvas: HTMLCanvasElement,
  imgs: HTMLImageElement[],
  cols: number,
  gap: number,
  white: boolean,
): { w: number; h: number; scaled: boolean } {
  const sized = imgs.map((img) => {
    const k = fitScale(img.naturalWidth, img.naturalHeight)
    return { img, w: img.naturalWidth * k, h: img.naturalHeight * k }
  })
  const cellW = Math.max(...sized.map((s) => s.w))
  const cellH = Math.max(...sized.map((s) => s.h))
  const rows = Math.ceil(sized.length / cols)
  const totalW = cols * cellW + (cols - 1) * gap
  const totalH = rows * cellH + (rows - 1) * gap
  const k = joinScale(totalW, totalH)

  canvas.width = Math.max(1, Math.round(totalW * k))
  canvas.height = Math.max(1, Math.round(totalH * k))
  const ctx = canvas.getContext('2d')
  if (ctx === null) throw new Error('浏览器没有给出 2D 画布上下文，无法合成')
  ctx.clearRect(0, 0, canvas.width, canvas.height)
  ctx.imageSmoothingQuality = 'high'
  if (white) {
    // 这里写死的是图像数据不是界面颜色，所以不走 var(--token)
    ctx.fillStyle = '#FFFFFF'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
  }
  sized.forEach((s, i) => {
    const col = i % cols
    const row = Math.floor(i / cols)
    const cx = col * (cellW + gap) * k
    const cy = row * (cellH + gap) * k
    ctx.drawImage(
      s.img,
      cx + (cellW * k - s.w * k) / 2,
      cy + (cellH * k - s.h * k) / 2,
      s.w * k,
      s.h * k,
    )
  })
  return { w: canvas.width, h: canvas.height, scaled: k < 1 }
}

function JoinTool(): JSX.Element {
  const [picked, setPicked] = useState<number[]>([])
  const [cols, setCols] = useState(2)
  const [gap, setGap] = useState(8)
  const [white, setWhite] = useState(true)
  const [cacheTick, setCacheTick] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [out, setOut] = useState<{ w: number; h: number; scaled: boolean } | null>(null)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<ImageAsset | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const cacheRef = useRef(new Map<number, HTMLImageElement>())
  const alive = useAlive()

  const pool = useQuery({
    queryKey: ['ssm-join-pool'],
    queryFn: () => apiImage.assets({ limit: 120 }),
  })

  const items = useMemo(() => pool.data?.items ?? [], [pool.data])
  const poolRef = useRef<ImageAsset[]>([])
  poolRef.current = items

  // 依赖用 id 串而不是数组本身：每次渲染都会造新数组，用数组当依赖会无限重载
  const pickedKey = picked.join(',')

  useEffect(() => {
    const ids = pickedKey === '' ? [] : pickedKey.split(',').map(Number)
    const missing = ids.filter((id) => !cacheRef.current.has(id))
    if (missing.length === 0) return
    let live = true
    void (async () => {
      for (const id of missing) {
        const a = poolRef.current.find((x) => x.id === id)
        if (a === undefined) continue
        try {
          const el = await loadImage(a.full_url)
          if (!live) return
          cacheRef.current.set(id, el)
          setCacheTick((t) => t + 1)
        } catch (e) {
          if (live) setError(readError(e, '图片加载失败'))
          return
        }
      }
    })()
    return () => {
      live = false
    }
  }, [pickedKey])

  const chosen = picked
    .map((id) => items.find((a) => a.id === id))
    .filter((a): a is ImageAsset => a !== undefined)
  const loaded = chosen.length > 0 && chosen.every((a) => cacheRef.current.has(a.id))
  const maxCols = Math.max(1, chosen.length)
  const usedCols = Math.min(cols, maxCols)

  // 预览就是最终产物本身：画一遍拿去看，确认时直接把这张画布编码上传，
  // 不会出现「预览一套、存下来另一套」
  useEffect(() => {
    const canvas = canvasRef.current
    if (canvas === null) return
    const ids = pickedKey === '' ? [] : pickedKey.split(',').map(Number)
    const frames = ids
      .map((id) => cacheRef.current.get(id))
      .filter((el): el is HTMLImageElement => el !== undefined)
    if (frames.length === 0 || frames.length !== ids.length) return
    try {
      setOut(composeGrid(canvas, frames, Math.min(cols, frames.length), gap, white))
      setError(null)
    } catch (e) {
      setError(readError(e, '合成失败'))
    }
  }, [pickedKey, cacheTick, cols, gap, white])

  const toggle = (id: number): void => {
    setResult(null)
    setPicked((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]))
  }

  const submit = async (): Promise<void> => {
    const canvas = canvasRef.current
    if (canvas === null || busy || chosen.length < 2) return
    setBusy(true)
    try {
      const note = `宫格拼接：资产 ${chosen.map((a) => a.id).join(' + ')}，${usedCols} 列，间距 ${gap}，${white ? '白底' : '透明底'}`
      // parent_id 指向第一张选中的图。拼接有多个来源，另外几张的 id 写进 note 里存住
      const row = await saveLocal(await toPng(canvas), 'join', chosen[0].id, note)
      if (!alive.current) return
      setResult(row)
      toast.success(`拼好并存进资产库（asset ${row.id}）`)
    } catch (e) {
      if (alive.current) toast.error(readError(e, '拼接失败'))
    } finally {
      if (alive.current) setBusy(false)
    }
  }

  return (
    <div className="stl-body">
      <section className="stl-main">
        <div className="ssm-stage ssm-stage-center stl-wide">
          {error !== null ? <p className="ssm-msg ssm-msg-bad">{error}</p> : null}
          {error === null && chosen.length === 0 ? (
            <p className="ssm-msg">在右边挑两张以上，这里就是拼好的样子。</p>
          ) : null}
          {error === null && chosen.length > 0 && !loaded ? <p className="ssm-msg">图片加载中…</p> : null}
          {/* 用条件渲染而不是 hidden 属性：`.ssm-canvas` 的 display:block 是作者样式，
              会盖过 UA 给 [hidden] 的 display:none，画布照样显形 */}
          {error === null && loaded ? <canvas ref={canvasRef} className="ssm-canvas" /> : null}
        </div>

        {result !== null ? (
          <div className="stl-wide">
            <p className="stl-hint ssm-tip">拼好的成品已入资产库：</p>
            <ShotGrid items={[result]} />
          </div>
        ) : null}
      </section>

      <aside className="stl-side">
        <div className="stl-block">
          <span className="stl-label">挑图（点击加入，再点移出）</span>
          {pool.isLoading ? <p className="stl-hint">载入资产…</p> : null}
          {pool.isError ? (
            <p className="stl-err">
              资产列表加载失败：{pool.error instanceof Error ? pool.error.message : '未知错误'}
            </p>
          ) : null}
          {pool.data !== undefined && items.length === 0 ? (
            <p className="stl-hint">资产库还是空的，先去生图或到素材库上传几张。</p>
          ) : null}
          {items.length > 0 ? (
            <div className="ssm-pool">
              {items.map((a) => {
                const at = picked.indexOf(a.id)
                return (
                  <button
                    key={a.id}
                    className={at >= 0 ? 'ssm-cell ssm-cell-on' : 'ssm-cell'}
                    title={`asset ${a.id} · ${a.width}×${a.height}`}
                    disabled={busy}
                    onClick={() => toggle(a.id)}
                  >
                    <img src={a.thumb_url} alt="" loading="lazy" />
                    {at >= 0 ? <span className="ssm-cell-idx">{at + 1}</span> : null}
                  </button>
                )
              })}
            </div>
          ) : null}
          <p className="stl-hint">格子上的数字是排布顺序，按点击先后从左到右、从上到下摆。</p>
        </div>

        <div className="stl-block">
          <span className="stl-label">排布</span>
          <div className="ssm-chips">
            {[1, 2, 3, 4, 5].map((n) => (
              <button
                key={n}
                className={usedCols === n ? 'ssm-chip ssm-chip-on' : 'ssm-chip'}
                disabled={busy || n > maxCols}
                onClick={() => setCols(n)}
              >
                {n} 列
              </button>
            ))}
          </div>
          <p className="stl-hint">
            {chosen.length > 0
              ? `${chosen.length} 张排成 ${usedCols} 列 × ${Math.ceil(chosen.length / usedCols)} 行。`
              : '还没选图。'}
          </p>
        </div>

        <div className="stl-block">
          {/* 数值不进 .stl-label：那个类是 uppercase，px 会变成刺眼的 PX */}
          <span className="stl-label">间距</span>
          <input
            className="ssm-range"
            type="range"
            min={0}
            max={64}
            step={2}
            value={gap}
            disabled={busy}
            aria-label="图与图之间的间距"
            onChange={(e) => setGap(Number(e.target.value))}
          />
          <p className="ssm-nums">{gap} px</p>
        </div>

        <div className="stl-block">
          <span className="stl-label">底色</span>
          <div className="seg">
            <button className={white ? 'active' : ''} disabled={busy} onClick={() => setWhite(true)}>
              白底
            </button>
            <button className={white ? '' : 'active'} disabled={busy} onClick={() => setWhite(false)}>
              透明
            </button>
          </div>
          <p className="stl-hint">透明底只有间距与留白处是透明的，图本身不抠。</p>
        </div>

        <div className="stl-block">
          <span className="stl-label">成品</span>
          <p className="ssm-nums">{out === null ? '—' : `${out.w}×${out.h}`}</p>
          <p className="stl-hint">
            单张长边超 {MAX_EDGE}px 先各自缩，网格再按长边 {MAX_JOIN_EDGE}px 且总面积{' '}
            {(MAX_JOIN_AREA / 1_000_000).toFixed(0)} 百万像素封顶——iOS Safari 的画布上限就在这一档，
            超了整张空白而且不报错。
            {out !== null && out.scaled ? '这一张已经触到上限，按等比缩过。' : ''}
          </p>
          <p className="stl-hint">
            {chosen.length < 2 ? '至少选两张才能拼。' : `血缘指向第一张（asset ${chosen[0].id}），其余的 id 写在备注里。`}
          </p>
          <button
            className="btn btn-primary"
            disabled={busy || chosen.length < 2 || !loaded || error !== null}
            onClick={() => void submit()}
          >
            <Combine />
            {busy ? '入库中…' : '拼接并入库'}
          </button>
        </div>
      </aside>
    </div>
  )
}

/* ==================== 页面 ==================== */

type Mode = 'split' | 'join'

export default function GridToolPage(): JSX.Element {
  const [mode, setMode] = useState<Mode>('split')
  const [initialAsset, setInitialAsset] = useState<ImageAsset | null>(null)
  useInitialImageAsset((asset) => {
    setInitialAsset(asset)
    setMode('split')
  })

  return (
    <main className="page stl-page">
      <header className="stl-head">
        <span className="stl-head-icon">
          <Grid3x3 />
        </span>
        <div className="stl-head-text">
          <h1>宫格工具</h1>
          <p className="stl-head-sub">
            一张图切成宫格，或把多张图拼成一张。不用先建画布，选好图就能做。
          </p>
        </div>
        <div className="stl-head-acts">
          <div className="seg">
            <button className={mode === 'split' ? 'active' : ''} onClick={() => setMode('split')}>
              切分
            </button>
            <button className={mode === 'join' ? 'active' : ''} onClick={() => setMode('join')}>
              拼接
            </button>
          </div>
        </div>
      </header>

      <p className="ssm-cost stl-wide">
        像素在浏览器里搬完再存进资产库，即时出结果，可以反复试。
      </p>

      {/* 两档都常驻挂载、用样式切换：切走再切回来时选中的图与参数还在，
          条件渲染会把它们连同已加载的图片一起丢掉 */}
      <div className={mode === 'split' ? 'ssm-pane' : 'ssm-pane ssm-pane-off'}>
        <SplitTool initialAsset={initialAsset} />
      </div>
      <div className={mode === 'join' ? 'ssm-pane' : 'ssm-pane ssm-pane-off'}>
        <JoinTool />
      </div>
    </main>
  )
}
