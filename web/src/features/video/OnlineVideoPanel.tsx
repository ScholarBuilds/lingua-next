import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'

import { Topbar } from '@/components/Topbar'
import { apiVideo } from '@/lib/api-video'
import type { VideoDetailV2 } from '@/lib/api-video'
import { useWorkspaceText } from '@/lib/workspaceStore'

export function OnlineVideoPanel({ video }: { video: VideoDetailV2 }) {
  const navigate = useNavigate()
  const qc = useQueryClient()
  const [note, setNote] = useWorkspaceText('video', `note:${video.id}`)
  const upload = useMutation({
    mutationFn: (file: File) => apiVideo.uploadVideo(file, video.id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['video', String(video.id)] })
      void qc.invalidateQueries({ queryKey: ['videos'] })
    },
  })
  return <div className="main">
    <Topbar title={video.title} back={{ to: '/video', label: '视频库' }} />
    <div className="content"><section className="vm-online-panel">
      <h2>在线学习条目</h2>
      <p>已保存来源，没有下载视频。逐句精学、听写和跟读需要本地媒体与字幕。</p>
      <button className="btn btn-primary" onClick={() => navigate(`/video?tab=youtube&youtube=${encodeURIComponent(video.source_url ?? '')}`)}>在内置 YouTube 观看</button>
      <label>学习笔记<textarea value={note} onChange={e => setNote(e.target.value)} placeholder="记录想法或你选择的学习内容" /></label>
      <h3>关联本地视频</h3>
      <p>请选择你有权使用的 mp4、mkv 或 webm。保留当前来源和笔记，随后按已有流程处理媒体。</p>
      <input type="file" accept=".mp4,.mkv,.webm" aria-label="关联本地视频" disabled={upload.isPending} onChange={e => {
        const file = e.target.files?.[0]
        if (file) upload.mutate(file)
        e.target.value = ''
      }} />
      {upload.isPending && <p role="status">上传中，请勿关闭页面…</p>}
      {upload.error && <p role="alert">{upload.error.message}</p>}
    </section></div>
  </div>
}
