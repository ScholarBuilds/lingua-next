import { useState } from 'react'
import type { DragEvent } from 'react'

import { IconUpload } from '../../components/icons'

interface ImportCardProps {
  uploading: boolean
  onPick: () => void
  onDropFiles: (files: File[]) => void
}

export function ImportCard({ uploading, onPick, onDropFiles }: ImportCardProps) {
  const [dragging, setDragging] = useState(false)

  const handleDrop = (e: DragEvent) => {
    e.preventDefault()
    setDragging(false)
    onDropFiles(Array.from(e.dataTransfer.files))
  }

  return (
    <button
      className={`import-card${dragging ? ' dragging' : ''}`}
      onClick={onPick}
      disabled={uploading}
      onDragOver={(e) => {
        e.preventDefault()
        setDragging(true)
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={handleDrop}
    >
      {uploading ? <span className="spinner" /> : <IconUpload />}
      <b>{uploading ? '上传中…' : '导入书籍'}</b>
      <span>支持 epub / pdf / txt / md</span>
    </button>
  )
}
