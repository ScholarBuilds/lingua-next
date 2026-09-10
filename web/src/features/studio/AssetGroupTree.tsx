/* 素材库左栏：快捷入口 + 两级分组树（库 → 文件夹）。

   分组只是给同一份资产贴归属，不复制文件——所以删组只解除归属，图还在模块 16 的
   资产库里（BR-140）。这一点与「文件夹式素材管理」的直觉相反，删除确认里必须写死，
   否则用户会以为按下去图就没了。 */

import { useState } from 'react'
import { toast } from 'sonner'

import { Overlay } from '../../components/Overlay'
import { IconAlert, IconEdit, IconImage, IconPlus, IconSparkle, IconTrash } from '../../components/icons'
import { apiStudio } from '../../lib/api-studio'
import type { AssetGroup } from '../../lib/api-studio'

/** 左栏当前选中的范围。untagged 与 group 互斥，所以做成联合类型而不是一堆 boolean */
export type Scope =
  | { kind: 'all' }
  | { kind: 'ungrouped' }
  | { kind: 'untagged' }
  | { kind: 'archived' }
  | { kind: 'group'; id: number }

export function sameScope(a: Scope, b: Scope): boolean {
  if (a.kind !== b.kind) return false
  if (a.kind === 'group' && b.kind === 'group') return a.id === b.id
  return true
}

/** 新建输入框：库与子文件夹共用一个，parent 决定挂在哪 */
type Creating = { parent: number | null }

export function AssetGroupTree({
  groups,
  loading,
  error,
  total,
  scope,
  onScope,
  onGroupsChanged,
  onAssetsChanged,
}: {
  groups: AssetGroup[]
  loading: boolean
  error: string | null
  /** 「全部素材」右侧的数量，来自资产分页接口的 total；拿不到就不显示，不猜 */
  total: number | null
  scope: Scope
  onScope: (next: Scope) => void
  onGroupsChanged: () => void
  /** 删组会把图退回未归组，网格要跟着刷 */
  onAssetsChanged: () => void
}) {
  const [creating, setCreating] = useState<Creating | null>(null)
  const [draft, setDraft] = useState('')
  const [renaming, setRenaming] = useState<{ id: number; text: string } | null>(null)
  const [deleting, setDeleting] = useState<AssetGroup | null>(null)
  const [busy, setBusy] = useState(false)

  const libs = groups.filter((g) => g.parent_id === null)
  const childrenOf = (id: number) => groups.filter((g) => g.parent_id === id)

  const startCreate = (parent: number | null) => {
    setCreating({ parent })
    setDraft('')
  }

  const commitCreate = async () => {
    if (creating === null) return
    const name = draft.trim()
    const parent = creating.parent
    setCreating(null)
    setDraft('')
    if (name === '') return
    try {
      await apiStudio.createAssetGroup({ name, parent_id: parent })
      onGroupsChanged()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '新建分组失败')
    }
  }

  const commitRename = async () => {
    if (renaming === null) return
    const { id, text } = renaming
    setRenaming(null)
    const name = text.trim()
    if (name === '') return
    try {
      await apiStudio.patchAssetGroup(id, { name })
      onGroupsChanged()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '改名失败')
    }
  }

  const confirmDelete = async () => {
    if (deleting === null || busy) return
    setBusy(true)
    try {
      const r = await apiStudio.deleteAssetGroup(deleting.id)
      toast.success(`分组已删除，${r.released} 张图退回「未归组」，图本身都还在`)
      if (scope.kind === 'group' && scope.id === deleting.id) onScope({ kind: 'all' })
      setDeleting(null)
      onGroupsChanged()
      onAssetsChanged()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '删除分组失败')
    } finally {
      setBusy(false)
    }
  }

  const row = (g: AssetGroup, sub: boolean) => {
    const on = scope.kind === 'group' && scope.id === g.id
    const kids = childrenOf(g.id)
    const editing = renaming !== null && renaming.id === g.id
    return (
      <div
        key={g.id}
        className={`sal-item${on ? ' sal-item-on' : ''}${sub ? ' sal-item-sub' : ''}`}
        role="button"
        tabIndex={0}
        onClick={() => onScope({ kind: 'group', id: g.id })}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            onScope({ kind: 'group', id: g.id })
          }
        }}
      >
        {editing ? (
          <input
            className="sal-rename"
            value={renaming.text}
            autoFocus
            onClick={(e) => e.stopPropagation()}
            onChange={(e) => setRenaming({ id: g.id, text: e.target.value })}
            onBlur={() => void commitRename()}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void commitRename()
              if (e.key === 'Escape') {
                // 两段式：这一下 Esc 只退出改名，不冒到浮层栈去关别的层（STD-UI-002b）
                e.stopPropagation()
                setRenaming(null)
              }
            }}
          />
        ) : (
          <>
            <span className="sal-item-name" title={g.name}>
              {g.name}
            </span>
            <span
              className="sal-item-count"
              title={kids.length > 0 ? '直接挂在这一级的张数，不含子文件夹' : '这个分组下的张数'}
            >
              {g.count}
            </span>
            <span className="sal-item-acts" onClick={(e) => e.stopPropagation()}>
              {!sub && (
                <button
                  className="sal-act"
                  aria-label={`在「${g.name}」下新建子文件夹`}
                  title="新建子文件夹"
                  onClick={() => startCreate(g.id)}
                >
                  <IconPlus />
                </button>
              )}
              <button
                className="sal-act"
                aria-label={`重命名「${g.name}」`}
                title="改名"
                onClick={() => setRenaming({ id: g.id, text: g.name })}
              >
                <IconEdit />
              </button>
              <button
                className="sal-act"
                aria-label={`删除「${g.name}」`}
                title={kids.length > 0 ? '这个库下还有子文件夹，先把子文件夹删掉' : '删除分组（图不会被删）'}
                disabled={kids.length > 0}
                onClick={() => setDeleting(g)}
              >
                <IconTrash />
              </button>
            </span>
          </>
        )}
      </div>
    )
  }

  return (
    <aside className="sal-side">
      <button
        className={`sal-item${scope.kind === 'all' ? ' sal-item-on' : ''}`}
        onClick={() => onScope({ kind: 'all' })}
      >
        <IconImage />
        <span className="sal-item-name">全部素材</span>
        {total !== null && <span className="sal-item-count">{total}</span>}
      </button>
      <button
        className={`sal-item${scope.kind === 'ungrouped' ? ' sal-item-on' : ''}`}
        onClick={() => onScope({ kind: 'ungrouped' })}
      >
        <IconImage />
        <span className="sal-item-name">未归组</span>
      </button>
      <button
        className={`sal-item${scope.kind === 'untagged' ? ' sal-item-on' : ''}`}
        onClick={() => onScope({ kind: 'untagged' })}
      >
        <IconSparkle />
        <span className="sal-item-name">未打标</span>
      </button>
      <button
        className={`sal-item${scope.kind === 'archived' ? ' sal-item-on' : ''}`}
        onClick={() => onScope({ kind: 'archived' })}
      >
        <IconTrash />
        <span className="sal-item-name">归档</span>
      </button>

      <div className="sal-side-sec">
        <span>分组</span>
      </div>

      {loading && <p className="sal-side-note">载入分组…</p>}
      {error !== null && (
        <p className="sal-side-note sal-side-err">
          分组加载失败：{error}
          <br />
          分组树用不了，右边的素材网格照常能看。
        </p>
      )}
      {!loading && error === null && libs.length === 0 && (
        <p className="sal-side-note">还没有库。新建一个库，再往里放素材。</p>
      )}

      {libs.map((lib) => (
        <div key={lib.id}>
          {row(lib, false)}
          {childrenOf(lib.id).map((sub) => row(sub, true))}
          {creating !== null && creating.parent === lib.id && (
            <div className="sal-newbox">
              <input
                value={draft}
                autoFocus
                placeholder="子文件夹名称"
                onChange={(e) => setDraft(e.target.value)}
                onBlur={() => void commitCreate()}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void commitCreate()
                  if (e.key === 'Escape') {
                    e.stopPropagation()
                    setCreating(null)
                  }
                }}
              />
            </div>
          )}
        </div>
      ))}

      {creating !== null && creating.parent === null ? (
        <div className="sal-newbox">
          <input
            value={draft}
            autoFocus
            placeholder="库名称"
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => void commitCreate()}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void commitCreate()
              if (e.key === 'Escape') {
                e.stopPropagation()
                setCreating(null)
              }
            }}
          />
          <p>回车建库，Esc 取消</p>
        </div>
      ) : (
        <button className="sal-new" disabled={error !== null} onClick={() => startCreate(null)}>
          <IconPlus />
          新建库
        </button>
      )}

      {deleting !== null && (
        <Overlay onClose={() => setDeleting(null)} card="ov-narrow" labelledBy="sal-del-title">
          <div className="overlay-head">
            <span className="overlay-title" id="sal-del-title">
              删除分组「{deleting.name}」？
            </span>
          </div>
          <p className="sal-confirm-warn">
            <IconAlert />
            <span>
              <b>只解除归属，图不会被删。</b>
              这个分组下的 {deleting.count} 张图会退回「未归组」，仍然在素材库里，随时能重新归组。
            </span>
          </p>
          <p className="sal-confirm-note">
            分组是给资产贴的归属标记，不是文件夹——图存在模块 16 的资产库里，工坊删组动不了它。
          </p>
          <div className="overlay-foot">
            <button className="btn" onClick={() => setDeleting(null)}>
              取消
            </button>
            <button
              className={busy ? 'btn btn-danger loading' : 'btn btn-danger'}
              onClick={() => void confirmDelete()}
            >
              {busy && <span className="spinner" />}
              删除分组
            </button>
          </div>
        </Overlay>
      )}
    </aside>
  )
}
