/* 版本历史面板：提示词与工作流共用。

   两块业务的历史长得一模一样（版本号 + 备注 + 时间 + 回滚 + 保留），所以做成一个
   组件按 `kind` 分流，而不是各写一份——两份 UI 早晚会长歪，而且 check:css 也不允许
   两个文件抢同一批类名。

   两条口径要在界面上说清楚，否则用户会误会：
   - **回滚不倒退版本号**：旧内容重新提交成新的一版，回滚本身也留痕、也能再回滚。
   - **未标记的版本会被裁**：只留最近若干版，想长期留住的那一版得自己按「保留」。 */

import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { toast } from 'sonner'

import { Overlay } from '../../components/Overlay'
import { IconClock, IconStar } from '../../components/icons'
import { apiStudio } from '../../lib/api-studio'
import './revision-panel.css'

export type RevisionKind = 'prompt' | 'workflow'

function errText(e: unknown): string {
  return e instanceof Error ? e.message : '未知错误'
}

function fmtTime(iso: string | null): string {
  if (iso === null) return '未记录'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleString('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

export function RevisionPanel({
  kind,
  id,
  name,
  currentVersion,
  onRestored,
  onClose,
}: {
  kind: RevisionKind
  id: number
  /** 标题上显示的条目名 */
  name: string
  /** 当前版本，用来把「就是这一版」标出来并禁掉它的回滚按钮 */
  currentVersion: number | null
  onRestored: () => void
  onClose: () => void
}): JSX.Element {
  const [busy, setBusy] = useState<number | null>(null)
  const query = useQuery({
    queryKey: ['studio-revisions', kind, id],
    queryFn: () =>
      kind === 'prompt' ? apiStudio.promptRevisions(id) : apiStudio.workflowRevisions(id),
  })

  const items = query.data?.items ?? []
  const keepRecent = query.data?.keep_recent ?? 0

  const refresh = () => void query.refetch()

  const restore = async (version: number) => {
    if (busy !== null) return
    setBusy(version)
    try {
      if (kind === 'prompt') await apiStudio.restorePrompt(id, version)
      else await apiStudio.restoreWorkflow(id, version)
      toast.success(`已回滚到第 ${version} 版，这次回滚本身也记成了新的一版`)
      onRestored()
      refresh()
    } catch (e) {
      toast.error(errText(e))
    } finally {
      setBusy(null)
    }
  }

  const pin = async (version: number, pinned: boolean) => {
    if (busy !== null) return
    setBusy(version)
    try {
      if (kind === 'prompt') await apiStudio.pinPromptRevision(id, version, pinned)
      else await apiStudio.pinWorkflowRevision(id, version, pinned)
      refresh()
    } catch (e) {
      toast.error(errText(e))
    } finally {
      setBusy(null)
    }
  }

  return (
    <Overlay onClose={onClose} card="shv-card" labelledBy="shv-title">
      <div className="overlay-head">
        <span className="overlay-title" id="shv-title">
          <IconClock /> 版本历史 · {name}
        </span>
      </div>

      {query.isPending && <p className="shv-note">载入版本历史…</p>}
      {query.isError && (
        <p className="shv-note shv-note-err">
          版本历史读取失败：{errText(query.error)}
          <button className="btn btn-ghost-sm" onClick={refresh}>
            重试
          </button>
        </p>
      )}
      {!query.isPending && !query.isError && items.length === 0 && (
        <p className="shv-note">还没有历史版本。改一次内容就会留下一版。</p>
      )}

      {items.length > 0 && (
        <ul className="shv-list">
          {items.map((item) => {
            const current = currentVersion !== null && item.version === currentVersion
            return (
              <li className={current ? 'shv-row shv-row-now' : 'shv-row'} key={item.version}>
                <span className="shv-ver">v{item.version}</span>
                <span className="shv-body">
                  <span className="shv-note-text">
                    {item.note === '' ? '（没写备注）' : item.note}
                  </span>
                  <span className="shv-time">{fmtTime(item.created_at)}</span>
                </span>
                {current && <span className="shv-badge">当前</span>}
                <button
                  className={item.pinned ? 'shv-pin shv-pin-on' : 'shv-pin'}
                  aria-label={item.pinned ? `取消保留第 ${item.version} 版` : `保留第 ${item.version} 版`}
                  title={
                    item.pinned
                      ? '取消保留后，这一版会立刻按保留窗口重新参与裁剪'
                      : '标记保留：不参与保留窗口的裁剪，想留多久留多久'
                  }
                  disabled={busy !== null}
                  onClick={() => void pin(item.version, !item.pinned)}
                >
                  <IconStar filled={item.pinned} />
                </button>
                <button
                  className={busy === item.version ? 'btn btn-sm btn-outline loading' : 'btn btn-sm btn-outline'}
                  disabled={current || busy !== null}
                  title={current ? '这就是当前内容' : `把第 ${item.version} 版的内容取回来`}
                  onClick={() => void restore(item.version)}
                >
                  {busy === item.version && <span className="spinner" />}
                  回滚
                </button>
              </li>
            )
          })}
        </ul>
      )}

      {keepRecent > 0 && (
        <p className="shv-keep">
          回滚不会倒退版本号：旧内容会重新提交成新的一版，所以回滚本身也能再回滚。
          没标「保留」的版本只留最近 {keepRecent} 版，想长期留住某一版就点它的星标。
        </p>
      )}

      <div className="overlay-foot">
        <button className="btn" onClick={onClose}>
          关闭
        </button>
      </div>
    </Overlay>
  )
}
