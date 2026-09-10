import { useEffect, useMemo, useRef, useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { Camera, Film, Plus, Scissors, Trash2 } from '@/components/NexusIcon'
import { toast } from 'sonner'

import { Picker } from '@/components/ui/picker'
import { apiStudio } from '../../lib/api-studio'
import type { FrameShot, VideoForFrames } from '../../lib/api-studio'
import { ToolHeader } from './StudioToolShell'
import './studio-tools.css'
import './frame-extractor.css'

const MAX_FRAMES = 12

const SOURCE_LABEL: Record<VideoForFrames['source'], string> = {
  library: '视频库',
  studio: '工坊素材',
}

function normalizedSecond(value: number): number {
  return Math.max(0, Math.round(value * 1000) / 1000)
}

export default function FrameExtractorPage(): JSX.Element {
  const videos = useQuery({ queryKey: ['studio-frame-videos'], queryFn: apiStudio.framesSources })
  // 选中项一律用 ref（source:id）标识：两个片源的 id 各自从 1 开始，
  // 只记数字的话换片源不换文件，抽出来的图看着还挺正常
  const [sourceRef, setSourceRef] = useState<string | null>(null)
  const [current, setCurrent] = useState(0)
  const [manual, setManual] = useState('')
  const [seconds, setSeconds] = useState<number[]>([])
  const [shots, setShots] = useState<FrameShot[]>([])
  const [failed, setFailed] = useState<Array<{ at_s: number; error: string }>>([])
  const videoRef = useRef<HTMLVideoElement | null>(null)

  const options = videos.data?.items ?? []
  useEffect(() => {
    if (sourceRef === null && options[0] !== undefined) setSourceRef(options[0].ref)
  }, [options, sourceRef])
  const selected = useMemo(
    () => options.find((video) => video.ref === sourceRef) ?? null,
    [options, sourceRef],
  )

  const addSecond = (raw: number): void => {
    const value = normalizedSecond(raw)
    if (selected?.duration_s !== null && selected?.duration_s !== undefined && value > selected.duration_s) {
      toast.error(`时间点超过视频时长 ${selected.duration_s}s`)
      return
    }
    setSeconds((old) => {
      if (old.includes(value)) return old
      if (old.length >= MAX_FRAMES) {
        toast.error(`一次最多选择 ${MAX_FRAMES} 帧`)
        return old
      }
      return [...old, value].sort((a, b) => a - b)
    })
  }

  const extract = useMutation({
    mutationFn: () => {
      if (selected === null) throw new Error('先选择视频')
      if (seconds.length === 0) throw new Error('至少添加一个时间点')
      return apiStudio.extractFrames({
        source: selected.source,
        video_id: selected.id,
        at_seconds: seconds,
      })
    },
    onSuccess: (result) => {
      setShots(result.items)
      setFailed(result.failed)
      if (result.items.length > 0) toast.success(`已抽取 ${result.items.length} 帧并存入图片资产库`)
      if (result.failed.length > 0) toast.error(`${result.failed.length} 个时间点抽帧失败`)
    },
    onError: (error) => toast.error(error instanceof Error ? error.message : '抽帧失败'),
  })

  return (
    <main className="page stl-page">
      <ToolHeader
        icon={<Scissors />}
        title="视频抽帧"
        sub="视频库与工坊素材都能当片源，播放或逐帧定位后把当前、首帧、尾帧或手填时间点批量抽成图片资产。一次最多 12 帧，单帧失败不会回滚已经成功的结果。"
      />

      {videos.isLoading ? <div className="stl-blank">正在读取本机视频…</div> : null}
      {videos.isError ? (
        <div className="stl-blank">{videos.error instanceof Error ? videos.error.message : '视频列表加载失败'}</div>
      ) : null}
      {!videos.isLoading && !videos.isError && options.length === 0 ? (
        <div className="stl-blank">
          <span className="stl-blank-icon"><Film /></span>
          <span className="stl-blank-title">还没有可抽帧的本机视频</span>
          <p className="stl-blank-hint">视频库里状态为 ready 或 degraded 的片子会出现在这里；工坊生成或上传的视频素材也算。</p>
        </div>
      ) : null}

      {selected !== null ? (
        <div className="stl-body">
          <section className="stl-main">
            <video
              // key 跟着片源换：只改 src 的话浏览器可能继续放上一部片子的缓冲
              key={selected.ref}
              ref={videoRef}
              className="sfe-video"
              src={selected.stream_url}
              controls
              preload="metadata"
              onTimeUpdate={(event) => setCurrent(normalizedSecond(event.currentTarget.currentTime))}
            />
            <div className="sfe-now">
              <span>当前位置 <strong>{current.toFixed(3)}s</strong></span>
              <button className="btn btn-primary" onClick={() => addSecond(videoRef.current?.currentTime ?? current)}>
                <Camera />添加当前帧
              </button>
            </div>
            {shots.length > 0 ? (
              <div className="sfe-results">
                {shots.map((shot) => (
                  <a key={`${shot.asset_id}-${shot.at_s}`} href={shot.url} target="_blank" rel="noreferrer">
                    <img src={shot.url} alt={`${shot.at_s}s 抽帧`} />
                    <span>{shot.at_s}s · asset #{shot.asset_id}</span>
                  </a>
                ))}
              </div>
            ) : null}
            {failed.length > 0 ? (
              <div className="sfe-failed">
                {failed.map((item) => <p key={`${item.at_s}-${item.error}`}>{item.at_s}s：{item.error}</p>)}
              </div>
            ) : null}
          </section>

          <aside className="stl-side">
            <div className="stl-block">
              <span className="stl-label">视频</span>
              <Picker
                value={selected.ref}
                onChange={(value) => {
                  setSourceRef(value)
                  setSeconds([])
                  setShots([])
                  setFailed([])
                  setCurrent(0)
                }}
                options={options.map((video) => ({
                  value: video.ref,
                  label: `${video.title}${video.duration_s === null ? '' : ` · ${video.duration_s}s`}`,
                  hint: SOURCE_LABEL[video.source],
                }))}
              />
            </div>
            <div className="stl-block">
              <span className="stl-label">快速时间点</span>
              <div className="sfe-actions">
                <button className="btn btn-outline btn-sm" onClick={() => addSecond(0)}>首帧</button>
                <button className="btn btn-outline btn-sm" onClick={() => addSecond(current)}>当前帧</button>
                <button
                  className="btn btn-outline btn-sm"
                  disabled={selected.duration_s === null}
                  onClick={() => addSecond(Math.max(0, (selected.duration_s ?? 0) - 0.05))}
                >尾帧</button>
              </div>
              <div className="sfe-manual">
                <input
                  type="number"
                  min={0}
                  step="0.001"
                  value={manual}
                  placeholder="秒数，例如 12.5"
                  onChange={(event) => setManual(event.target.value)}
                />
                <button
                  className="btn btn-outline btn-sm"
                  disabled={manual.trim() === ''}
                  onClick={() => {
                    addSecond(Number(manual))
                    setManual('')
                  }}
                ><Plus />添加</button>
              </div>
            </div>
            <div className="stl-block">
              <div className="sfe-list-head">
                <span className="stl-label">待抽取 {seconds.length}/{MAX_FRAMES}</span>
                <button className="btn-ghost-sm" disabled={seconds.length === 0} onClick={() => setSeconds([])}>
                  <Trash2 />清空
                </button>
              </div>
              <div className="sfe-chips">
                {seconds.length === 0 ? <span className="stl-hint">添加首帧、当前帧、尾帧或手填秒数。</span> : null}
                {seconds.map((second) => (
                  <button key={second} onClick={() => setSeconds((old) => old.filter((item) => item !== second))}>
                    {second}s ×
                  </button>
                ))}
              </div>
            </div>
            <button
              className="btn btn-primary"
              disabled={seconds.length === 0 || extract.isPending}
              onClick={() => extract.mutate()}
            >
              <Scissors />{extract.isPending ? '正在抽帧…' : `抽取 ${seconds.length} 帧并入库`}
            </button>
          </aside>
        </div>
      ) : null}
    </main>
  )
}
