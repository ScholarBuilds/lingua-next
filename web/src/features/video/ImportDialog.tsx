/* 批量导入 Dialog（对照 design/mockups/video-library.html 覆盖层）：
   粘贴 URL（POST /videos/batch）· 精选频道（URL 预填清单）· 本地上传。 */

import { useMutation } from '@tanstack/react-query'
import { useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import type { ChangeEvent, DragEvent } from 'react'

import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'

import { IconUpload } from '../../components/icons'
import { apiVideo } from '../../lib/api-video'
import type { BatchAddResult } from '../../lib/api-video'
import { VIconExternal, VIconWarnTri } from './icons'
import { openExternal } from '@/lib/shell'

type Tab = 'url' | 'chan' | 'file'

interface CuratedChannel {
  name: string
  url: string
  chips: string[]
  meta: string
  grad: string
  initial: string
}

/* 精选英语学习频道（真实频道主页地址）。后端按单条视频链接加工，
   「拉取」先把频道地址预填进 URL 清单，配合「打开频道」挑选具体视频。 */
const CHANNELS: CuratedChannel[] = [
  {
    name: 'English with Lucy',
    url: 'https://www.youtube.com/@EnglishwithLucy/videos',
    chips: ['英音', '生活'],
    meta: '发音教学 · 更新稳定',
    grad: 'linear-gradient(150deg,#C98A5B,#7E4526)',
    initial: 'L',
  },
  {
    name: 'Speak English With Vanessa',
    url: 'https://www.youtube.com/@SpeakEnglishWithVanessa/videos',
    chips: ['美音', '生活'],
    meta: '日常口语 · 语速适中',
    grad: 'linear-gradient(150deg,#56A97F,#2E6B4F)',
    initial: 'V',
  },
  {
    name: 'Easy English',
    url: 'https://www.youtube.com/@EasyEnglishVideos/videos',
    chips: ['英音', '街访'],
    meta: '真实街头语料 · 多口音',
    grad: 'linear-gradient(150deg,#5B7FD8,#2C4685)',
    initial: 'E',
  },
  {
    name: "Luke's English Podcast",
    url: 'https://www.youtube.com/@LukesEnglishPodcast/videos',
    chips: ['英音', '播客'],
    meta: '长篇播客 · 高阶输入',
    grad: 'linear-gradient(150deg,#7E6BC9,#45358C)',
    initial: 'P',
  },
  {
    name: "Rachel's English",
    url: 'https://www.youtube.com/@rachelsenglish/videos',
    chips: ['美音', '发音'],
    meta: '美音发音矫正',
    grad: 'linear-gradient(150deg,#D98BA6,#93436A)',
    initial: 'R',
  },
  {
    name: 'TED-Ed',
    url: 'https://www.youtube.com/@TEDEd/videos',
    chips: ['美音', '科普'],
    meta: '动画科普 · 进阶挑战',
    grad: 'linear-gradient(150deg,#3E5EA9,#1B2B5C)',
    initial: 'T',
  },
]

const MAX_URLS = 20

interface ImportDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** 库内已有 source_url，本地先行去重 */
  existingUrls: Set<string>
  onImported: () => void
  onGoCredentials: () => void
}

export function ImportDialog({
  open,
  onOpenChange,
  existingUrls,
  onImported,
  onGoCredentials,
}: ImportDialogProps) {
  const [tab, setTab] = useState<Tab>('url')
  const [raw, setRaw] = useState('')
  const [dragging, setDragging] = useState(false)
  const [uploading, setUploading] = useState(0)
  const [results, setResults] = useState<BatchAddResult[] | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  /* 每次「关 → 开」都从头开始（STD-UI-005）。

     这个弹窗常驻挂载，关掉只是 Dialog 收起来，状态原样留着。不清的话，导入完一批
     再打开，看到的是**上一批的导入结果**和还留在框里的那串 URL——像是这次就导过了。
     用 ref 抓边沿而不是挂在 [open] 上重置：那样关闭动画播到一半内容就被清空了。 */
  const wasOpen = useRef(false)
  useEffect(() => {
    if (open && !wasOpen.current) {
      setTab('url')
      setRaw('')
      setDragging(false)
      setUploading(0)
      setResults(null)
    }
    wasOpen.current = open
  }, [open])

  const parsed = useMemo(() => {
    const lines = raw
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l !== '')
    const seen = new Set<string>()
    const valid: string[] = []
    let dup = 0
    let invalid = 0
    for (const line of lines) {
      if (!/^https?:\/\//.test(line)) {
        invalid += 1
        continue
      }
      if (seen.has(line) || existingUrls.has(line)) {
        dup += 1
        continue
      }
      seen.add(line)
      valid.push(line)
    }
    return { valid: valid.slice(0, MAX_URLS), dup, invalid, overflow: Math.max(0, valid.length - MAX_URLS) }
  }, [raw, existingUrls])

  const batch = useMutation({
    mutationFn: (urls: string[]) => apiVideo.batchAdd(urls),
    onSuccess: (res) => {
      const added = res.filter((r) => r.id !== undefined && r.existed !== true).length
      const existed = res.filter((r) => r.existed === true).length
      const errs = res.filter((r) => r.error !== undefined)
      toast.success(
        `已提交 ${added} 条加工${existed > 0 ? ` · ${existed} 条已在库中` : ''}${errs.length > 0 ? ` · ${errs.length} 条无效` : ''}`,
      )
      setResults(errs.length > 0 ? errs : null)
      setRaw('')
      onImported()
      if (errs.length === 0) onOpenChange(false)
    },
    onError: (err) =>
      toast.error(`导入失败：${err instanceof Error ? err.message : '未知错误'}`),
  })

  const uploadFiles = async (files: File[]) => {
    const ok = files.filter((f) => /\.(mp4|mkv|webm)$/i.test(f.name))
    if (ok.length === 0) {
      toast.error('仅支持 mp4 / mkv / webm')
      return
    }
    setUploading(ok.length)
    let done = 0
    for (const f of ok) {
      try {
        await apiVideo.uploadVideo(f)
        done += 1
      } catch (err) {
        toast.error(`${f.name} 上传失败：${err instanceof Error ? err.message : '未知错误'}`)
      }
      setUploading(ok.length - done)
    }
    setUploading(0)
    if (done > 0) {
      toast.success(`已上传 ${done} 个视频，开始转写加工`)
      onImported()
      onOpenChange(false)
    }
  }

  const onDrop = (e: DragEvent) => {
    e.preventDefault()
    setDragging(false)
    void uploadFiles([...e.dataTransfer.files])
  }

  const onPick = (e: ChangeEvent<HTMLInputElement>) => {
    void uploadFiles([...(e.target.files ?? [])])
    e.target.value = ''
  }

  const pull = (ch: CuratedChannel) => {
    setTab('url')
    setRaw((r) => (r.trim() === '' ? ch.url : `${r.trimEnd()}\n${ch.url}`))
    toast.info('已填入频道地址；建议打开频道页复制具体视频链接（每行一条）')
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="gap-0 bg-card p-0 sm:max-w-[640px]">
        <DialogHeader className="flex-row items-center gap-3 space-y-0 px-5 pt-4">
          <DialogTitle className="text-[17px] font-bold">批量导入视频</DialogTitle>
          <div className="seg vm-mtabs">
            <button className={tab === 'url' ? 'active' : ''} onClick={() => setTab('url')}>
              粘贴 URL
            </button>
            <button className={tab === 'chan' ? 'active' : ''} onClick={() => setTab('chan')}>
              精选频道
            </button>
            <button className={tab === 'file' ? 'active' : ''} onClick={() => setTab('file')}>
              本地上传
            </button>
          </div>
        </DialogHeader>

        <div className="max-h-[52vh] overflow-y-auto px-5 py-4">
          {tab === 'url' && (
            <>
              <textarea
                className="vm-url-area"
                spellCheck={false}
                placeholder={'https://www.youtube.com/watch?v=…\n每行一个链接'}
                value={raw}
                onChange={(e) => {
                  setRaw(e.target.value)
                  setResults(null)
                }}
              />
              <div className="vm-url-fb">
                {parsed.valid.length > 0 && (
                  <span className="chip ok">
                    ✓ 识别 {parsed.valid.length} 个视频 · 已去重 {parsed.dup}
                  </span>
                )}
                {parsed.invalid > 0 && <span className="chip err">{parsed.invalid} 行非链接已忽略</span>}
                <span>每行一个链接，最多 {MAX_URLS} 条 · 排队加工（并发 2，可随时取消）</span>
              </div>
              {results !== null && (
                <div className="vm-batch-result">
                  {results.map((r) => (
                    <div key={r.url}>
                      <span style={{ color: 'var(--err)' }}>✕</span> {r.url} — {r.error}
                    </div>
                  ))}
                </div>
              )}
            </>
          )}

          {tab === 'chan' && (
            <div>
              {CHANNELS.map((ch) => (
                <div className="vm-chan" key={ch.name}>
                  <div className="vm-chan-ava" style={{ background: ch.grad }}>
                    {ch.initial}
                  </div>
                  <div className="vm-chan-info">
                    <div className="vm-chan-name">
                      {ch.name}
                      {ch.chips.map((c, i) => (
                        <span key={c} className={`chip${i === 0 ? ' accent' : ''}`}>
                          {c}
                        </span>
                      ))}
                    </div>
                    <div className="vm-chan-meta">{ch.meta}</div>
                  </div>
                  <div className="vm-chan-act">
                    <button
                      className="btn btn-sm"
                      title="新标签页打开频道，挑选视频链接"
                      onClick={() => openExternal(ch.url)}
                    >
                      <VIconExternal />
                      打开频道
                    </button>
                    <button className="btn btn-soft btn-sm" onClick={() => pull(ch)}>
                      拉取
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}

          {tab === 'file' && (
            <div
              className={`vm-drop${dragging ? ' dragging' : ''}`}
              onClick={() => fileRef.current?.click()}
              onDragOver={(e) => {
                e.preventDefault()
                setDragging(true)
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={onDrop}
            >
              <IconUpload />
              <b>{uploading > 0 ? `上传中，剩余 ${uploading} 个…` : '拖入视频文件，或点击选择'}</b>
              <span>mp4 / mkv / webm · 无字幕将自动转写（whisper 词级对齐）</span>
              <input
                ref={fileRef}
                type="file"
                accept=".mp4,.mkv,.webm"
                multiple
                hidden
                onChange={onPick}
              />
            </div>
          )}
        </div>

        <div className="flex items-center gap-2 border-t border-border px-5 py-3.5">
          <div className="vm-mhint">
            <VIconWarnTri />
            下载 YouTube 需配置 Cookies 凭证 →{' '}
            <a
              href="/settings"
              onClick={(e) => {
                e.preventDefault()
                onGoCredentials()
              }}
            >
              设置 · 视频源
            </a>
          </div>
          <div style={{ flex: 1 }} />
          <button className="btn" onClick={() => onOpenChange(false)}>
            取消
          </button>
          {tab !== 'file' && (
            <button
              className="btn btn-primary"
              disabled={parsed.valid.length === 0 || batch.isPending}
              onClick={() => batch.mutate(parsed.valid)}
            >
              <IconUpload />
              {batch.isPending ? '提交中…' : `开始导入 · ${parsed.valid.length} 条`}
            </button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
