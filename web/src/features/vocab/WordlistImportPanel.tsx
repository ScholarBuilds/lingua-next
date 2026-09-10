import { useMutation } from '@tanstack/react-query'

import { Overlay } from '../../components/Overlay'
import { useRef, useState } from 'react'
import type { ChangeEvent, FormEvent } from 'react'

import { IconClose, IconUpload } from '../../components/icons'
import { apiM5 } from '../../lib/api-m5'
import type { WordlistFormat, WordlistImportPreview } from '../../lib/api-m5'

const FORMATS: Array<{ value: WordlistFormat; label: string }> = [
  { value: 'csv', label: 'CSV' },
  { value: 'tsv', label: 'TSV' },
  { value: 'json', label: 'JSON' },
]

/** 按内容首个非空行猜格式：JSON 起始符 > 制表符 > 逗号缺省 */
export function guessFormat(content: string): WordlistFormat {
  const first = content
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l !== '')
  if (!first) return 'csv'
  if (first.startsWith('[') || first.startsWith('{')) return 'json'
  if (first.includes('\t')) return 'tsv'
  return 'csv'
}

interface WordlistImportPanelProps {
  onClose: () => void
  /** 确认导入成功后回调（key 形如 custom:3） */
  onDone: (result: { key: string; name: string }) => void
}

export function WordlistImportPanel({ onClose, onDone }: WordlistImportPanelProps) {
  const [name, setName] = useState('')
  const [format, setFormat] = useState<WordlistFormat>('csv')
  const [formatTouched, setFormatTouched] = useState(false)
  const [content, setContent] = useState('')
  const [fileName, setFileName] = useState<string | null>(null)
  const [invalid, setInvalid] = useState<string | null>(null)
  const [preview, setPreview] = useState<WordlistImportPreview | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  const previewMutation = useMutation({
    mutationFn: apiM5.previewWordlistImport,
    onSuccess: setPreview,
  })

  const confirmMutation = useMutation({
    mutationFn: apiM5.confirmWordlistImport,
    onSuccess: (result) => onDone({ key: result.key, name: name.trim() }),
  })

  const applyContent = (text: string) => {
    setContent(text)
    setPreview(null)
    if (!formatTouched) setFormat(guessFormat(text))
  }

  const handleFile = (e: ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0]
    e.target.value = ''
    if (!f) return
    void f.text().then((text) => {
      setFileName(f.name)
      applyContent(text)
      // 文件名可当默认词表名
      if (name.trim() === '') setName(f.name.replace(/\.[^.]+$/, ''))
    })
  }

  const submitPreview = (e: FormEvent) => {
    e.preventDefault()
    setInvalid(null)
    if (name.trim() === '') {
      setInvalid('请填写词表名称')
      return
    }
    if (content.trim() === '') {
      setInvalid('请粘贴词表内容或选择文件')
      return
    }
    previewMutation.mutate({ name: name.trim(), format, content })
  }

  const confirmImport = () => {
    if (preview) confirmMutation.mutate(preview.token)
  }

  return (
    <Overlay onClose={onClose} card="wide">
        <div className="overlay-head">
          <div className="overlay-title">导入词表</div>
          <button className="icon-btn" title="关闭 (Esc)" onClick={onClose}>
            <IconClose />
          </button>
        </div>

        <form className="sce-form" onSubmit={submitPreview}>
          <div className="form-row">
            <div className="field">
              <label htmlFor="wl-name">词表名称</label>
              <input
                id="wl-name"
                className="field-input"
                type="text"
                placeholder="如：GRE 核心 3000"
                value={name}
                autoFocus
                onChange={(e) => setName(e.target.value)}
              />
            </div>
            <div className="field">
              <label>格式（按内容自动识别，可手动改）</label>
              <div className="seg">
                {FORMATS.map((f) => (
                  <button
                    key={f.value}
                    type="button"
                    className={format === f.value ? 'active' : undefined}
                    onClick={() => {
                      setFormat(f.value)
                      setFormatTouched(true)
                      setPreview(null)
                    }}
                  >
                    {f.label}
                  </button>
                ))}
              </div>
            </div>
          </div>

          <div className="field">
            <label htmlFor="wl-content">词表内容</label>
            <textarea
              id="wl-content"
              className="field-textarea"
              placeholder={
                'CSV：word,translation 每行一条\nTSV：word<Tab>translation\nJSON：[{"word":"...","translation":"..."}]'
              }
              value={content}
              onChange={(e) => applyContent(e.target.value)}
            />
            <div className="imp-file-row">
              <button
                type="button"
                className="btn btn-outline btn-sm"
                onClick={() => fileRef.current?.click()}
              >
                <IconUpload />
                选择文件读入
              </button>
              {fileName && <span className="imp-file-name">{fileName}</span>}
              <input
                ref={fileRef}
                type="file"
                accept=".csv,.tsv,.txt,.json"
                hidden
                onChange={handleFile}
              />
            </div>
          </div>

          {invalid && <div className="form-err">{invalid}</div>}
          {previewMutation.isError && (
            <div className="form-err">解析失败：{previewMutation.error.message}</div>
          )}

          {!preview && (
            <div className="overlay-foot">
              <button type="button" className="btn" onClick={onClose}>
                取消
              </button>
              <button
                type="submit"
                className={`btn btn-primary${previewMutation.isPending ? ' loading' : ''}`}
                disabled={previewMutation.isPending}
              >
                {previewMutation.isPending && <span className="spinner" />}
                {previewMutation.isPending ? '解析中…' : '解析预览'}
              </button>
            </div>
          )}
        </form>

        {preview && (
          <div className="imp-preview">
            <div className="imp-stats">
              <div className="imp-stat new">
                <b>{preview.new.toLocaleString()}</b>
                <span>新增</span>
              </div>
              <div className="imp-stat dup">
                <b>{preview.dup.toLocaleString()}</b>
                <span>重复（跳过）</span>
              </div>
              <div className="imp-stat invalid">
                <b>{preview.invalid.length.toLocaleString()}</b>
                <span>无效行</span>
              </div>
            </div>

            {preview.invalid.length > 0 && (
              <div className="imp-invalid">
                {preview.invalid.slice(0, 5).map((row) => (
                  <div key={row.line}>
                    第 <b>{row.line}</b> 行：{row.reason}
                  </div>
                ))}
                {preview.invalid.length > 5 && (
                  <div>…另有 {preview.invalid.length - 5} 行无效，已省略</div>
                )}
              </div>
            )}

            {preview.sample.length > 0 && (
              <>
                <div className="imp-table-wrap">
                  <table className="imp-table">
                    <thead>
                      <tr>
                        <th>单词</th>
                        <th>释义</th>
                      </tr>
                    </thead>
                    <tbody>
                      {preview.sample.map((row, i) => (
                        <tr key={`${row.word}-${i}`}>
                          <td className="word">{row.word}</td>
                          <td className="trans">{row.translation ?? '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="imp-sample-hint">样例前 {preview.sample.length} 行，导入后释义缺失的词条会回落词典释义</div>
              </>
            )}

            {confirmMutation.isError && (
              <div className="form-err">导入失败：{confirmMutation.error.message}</div>
            )}

            <div className="overlay-foot">
              <button type="button" className="btn" onClick={() => setPreview(null)}>
                返回修改
              </button>
              <button
                type="button"
                className={`btn btn-primary${confirmMutation.isPending ? ' loading' : ''}`}
                disabled={confirmMutation.isPending}
                onClick={confirmImport}
              >
                {confirmMutation.isPending && <span className="spinner" />}
                {confirmMutation.isPending ? '导入中…' : `确认导入 ${preview.new} 词`}
              </button>
            </div>
          </div>
        )}
      </Overlay>
  )
}
