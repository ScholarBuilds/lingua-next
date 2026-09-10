/* URL 批量导入弹层（FR-477）：一行一个链接，服务端拉取入库。

   逐条发请求而不是一次把整批塞给 /studio/assets/import-urls：接口是同步的，
   整批发出去在返回前拿不到任何中间状态，那样的「第 n/共 m」只能是编的（BR-110）。
   一条一发，进度和逐条结果都是真的。 */

import { useRef, useState } from 'react'

import { Overlay } from '../../components/Overlay'
import { IconAlert, IconCheck, IconClose } from '../../components/icons'
import { Picker } from '@/components/ui/picker'
import { apiStudio } from '../../lib/api-studio'
import type { AssetGroup, ImportUrlResult } from '../../lib/api-studio'

/** 库 → 文件夹两级，下拉里用缩进表示层级 */
function options(groups: AssetGroup[]): { id: number; label: string }[] {
  const out: { id: number; label: string }[] = []
  for (const lib of groups.filter((g) => g.parent_id === null)) {
    out.push({ id: lib.id, label: lib.name })
    for (const sub of groups.filter((g) => g.parent_id === lib.id)) {
      out.push({ id: sub.id, label: `　└ ${sub.name}` })
    }
  }
  return out
}

export function AssetImportUrls({
  groups,
  defaultGroupId,
  onClose,
  onImported,
}: {
  groups: AssetGroup[]
  /** 左栏当前选中的分组，作为导入目标的默认值 */
  defaultGroupId: number | null
  onClose: () => void
  onImported: () => void
}) {
  const [text, setText] = useState('')
  const [groupId, setGroupId] = useState<number | null>(defaultGroupId)
  const [autoTag, setAutoTag] = useState(true)
  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null)
  const [results, setResults] = useState<ImportUrlResult[]>([])
  const areaRef = useRef<HTMLTextAreaElement | null>(null)

  const urls = text
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s !== '')

  const failed = results.filter((r) => !r.ok)
  const okCount = results.length - failed.length

  // 两段式 Esc（STD-UI-002b）：正在文本框里打字时，第一下只失焦，不把打好的链接关没了
  const requestClose = () => {
    if (running) return
    if (document.activeElement === areaRef.current && text !== '') {
      areaRef.current?.blur()
      return
    }
    onClose()
  }

  const run = async () => {
    if (running || urls.length === 0) return
    setRunning(true)
    setResults([])
    setProgress({ done: 0, total: urls.length })
    let touched = false
    for (let i = 0; i < urls.length; i += 1) {
      const url = urls[i]
      try {
        const r = await apiStudio.importUrls({
          items: [{ url }],
          group_id: groupId,
          auto_tag: autoTag,
        })
        if (r.items.length === 0) {
          // 接口没回这一条的结果，如实说，不擅自当成功
          setResults((prev) => [...prev, { url, ok: false, reason: '接口没有返回这一条的结果' }])
        } else {
          setResults((prev) => [...prev, ...r.items])
          if (r.items.some((x) => x.ok)) touched = true
        }
      } catch (e) {
        setResults((prev) => [
          ...prev,
          { url, ok: false, reason: e instanceof Error ? e.message : '未知错误' },
        ])
      }
      setProgress({ done: i + 1, total: urls.length })
    }
    setRunning(false)
    if (touched) onImported()
  }

  const retryFailed = () => {
    setText(failed.map((r) => r.url).join('\n'))
    setResults([])
    setProgress(null)
  }

  return (
    <Overlay onClose={requestClose} card="sal-import" labelledBy="sal-import-title">
      <div className="overlay-head">
        <span className="overlay-title" id="sal-import-title">
          导入 URL
        </span>
        <button className="btn-ghost-sm" aria-label="关闭" disabled={running} onClick={onClose}>
          <IconClose />
        </button>
      </div>

      <div className="field">
        <label htmlFor="sal-import-text">图片链接（一行一个）</label>
        <textarea
          id="sal-import-text"
          ref={areaRef}
          className="field-textarea"
          placeholder={'https://example.com/a.png\nhttps://example.com/b.jpg'}
          value={text}
          disabled={running}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape' && text !== '') {
              // 焦点在框里，这一下只失焦；再按一次才关弹层
              e.stopPropagation()
              areaRef.current?.blur()
            }
          }}
        />
        <span className="field-hint">
          服务端拉取入库，按魔数纠正扩展名（伪装成 .png 的 webp 会被改回来）。共 {urls.length} 条。
        </span>
      </div>

      <div className="field">
        <label htmlFor="sal-import-group">导入到分组</label>
        <Picker
          size="sm"
          className="sal-sel"
          value={groupId === null ? 'none' : String(groupId)}
          disabled={running}
          onChange={(v) => setGroupId(v === 'none' ? null : Number(v))}
          options={[
            { value: 'none', label: '不归组' },
            ...options(groups).map((o) => ({ value: String(o.id), label: o.label })),
          ]}
        />
        {groups.length === 0 && (
          <span className="field-hint">还没建过分组，只能先不归组，入库后在左栏建库再移过去。</span>
        )}
      </div>

      <label className="sal-toggle">
        <input
          type="checkbox"
          checked={autoTag}
          disabled={running}
          onChange={(e) => setAutoTag(e.target.checked)}
        />
        导入后自动打标（每张多花一次视觉模型调用；打标失败不影响入库）
      </label>

      {results.length > 0 && (
        <div className="sal-import-list">
          {results.map((r, i) => (
            <div className="sal-import-row" key={`${r.url}-${i}`}>
              {r.ok ? (
                <IconCheck className="sal-import-ok" />
              ) : (
                <IconAlert className="sal-import-bad" />
              )}
              <span className="sal-import-url">{r.url}</span>
              {r.ok ? (
                <span className="sal-import-ok">已入库 #{r.asset_id ?? '?'}</span>
              ) : (
                <span className="sal-import-bad">{r.reason ?? '失败（接口没给原因）'}</span>
              )}
            </div>
          ))}
        </div>
      )}

      {progress !== null && (
        <p className="sal-note">
          {running
            ? `导入中… 第 ${progress.done + (progress.done < progress.total ? 1 : 0)}/共 ${progress.total}`
            : `导入结束：成功 ${okCount} 条，失败 ${failed.length} 条`}
        </p>
      )}

      <div className="overlay-foot">
        {!running && failed.length > 0 && (
          <button className="btn" onClick={retryFailed}>
            把失败的 {failed.length} 条填回去
          </button>
        )}
        <button className="btn" disabled={running} onClick={onClose}>
          {results.length > 0 && !running ? '完成' : '取消'}
        </button>
        <button
          className={running ? 'btn btn-primary loading' : 'btn btn-primary'}
          disabled={running || urls.length === 0}
          onClick={() => void run()}
        >
          {running && <span className="spinner" />}
          {running ? '导入中…' : `导入 ${urls.length} 条`}
        </button>
      </div>
    </Overlay>
  )
}
