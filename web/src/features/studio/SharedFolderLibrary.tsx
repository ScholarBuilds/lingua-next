import type { ReactNode } from 'react'
import { useEffect, useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Check,
  FileText,
  Film,
  Folder,
  FolderOpen,
  Music,
  Plus,
  RefreshCw,
  Trash2,
} from '@/components/NexusIcon'
import { toast } from 'sonner'

import { Overlay } from '../../components/Overlay'
import { IconClose, IconImage, IconSearch } from '../../components/icons'
import { Picker } from '@/components/ui/picker'
import { apiStudio } from '../../lib/api-studio'
import type {
  AssetGroup,
  SharedFolder,
  SharedFolderItem,
  SharedFolderNode,
} from '../../lib/api-studio'

function errText(error: unknown): string {
  return error instanceof Error ? error.message : '未知错误'
}

function flattenNodes(root: SharedFolderNode | undefined): SharedFolderNode[] {
  if (root === undefined) return []
  return [root, ...root.children.flatMap(flattenNodes)]
}

function flattenItems(root: SharedFolderNode | undefined): SharedFolderItem[] {
  if (root === undefined) return []
  return [...root.items, ...root.children.flatMap(flattenItems)]
}

function sizeLabel(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function kindLabel(kind: SharedFolderItem['kind']): string {
  return kind === 'image' ? '图片' : kind === 'video' ? '视频' : kind === 'audio' ? '音频' : '文件'
}

function FolderNodeRow({
  node,
  depth,
  activePath,
  onOpen,
}: {
  node: SharedFolderNode
  depth: number
  activePath: string
  onOpen: (path: string) => void
}) {
  const active = activePath === node.path
  const total = flattenItems(node).length
  return (
    <>
      <button
        className={active ? 'sal-shared-node is-active' : 'sal-shared-node'}
        style={{ paddingLeft: `${12 + depth * 14}px` }}
        onClick={() => onOpen(node.path)}
      >
        {active ? <FolderOpen /> : <Folder />}
        <span>{node.name}</span>
        <small>{total}</small>
      </button>
      {node.children.map((child) => (
        <FolderNodeRow
          key={child.id}
          node={child}
          depth={depth + 1}
          activePath={activePath}
          onOpen={onOpen}
        />
      ))}
    </>
  )
}

function RegisterDialog({
  onClose,
  onSaved,
}: {
  onClose: () => void
  onSaved: (folder: SharedFolder) => void
}) {
  const [path, setPath] = useState('')
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)

  const save = async () => {
    if (path.trim() === '' || busy) return
    setBusy(true)
    try {
      const folder = await apiStudio.registerSharedFolder({ path: path.trim(), name: name.trim() })
      toast.success(`已登记「${folder.name}」`)
      onSaved(folder)
    } catch (error) {
      toast.error(`登记失败：${errText(error)}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Overlay onClose={onClose} card="sal-shared-dialog" labelledBy="sal-shared-register-title">
      <header className="overlay-head">
        <div>
          <h2 id="sal-shared-register-title">登记共享文件夹</h2>
          <p>仅允许 Lingua 项目目录内的子文件夹；登记后只读浏览，不会移动原文件。</p>
        </div>
        <button className="btn-ghost-sm" aria-label="关闭" onClick={onClose}><IconClose /></button>
      </header>
      <div className="sal-shared-form">
        <label>
          文件夹路径
          <input
            autoFocus
            value={path}
            placeholder="例如 assets/library 或 output"
            onChange={(event) => setPath(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void save()
              if (event.key === 'Escape' && path !== '') {
                event.stopPropagation()
                setPath('')
              }
            }}
          />
        </label>
        <label>
          显示名称（可选）
          <input value={name} placeholder="默认使用目录名" onChange={(event) => setName(event.target.value)} />
        </label>
      </div>
      <footer className="overlay-foot">
        <button className="btn btn-outline" onClick={onClose}>取消</button>
        <button className="btn" disabled={path.trim() === '' || busy} onClick={() => void save()}>
          {busy ? '登记中…' : '登记并打开'}
        </button>
      </footer>
    </Overlay>
  )
}

export function SharedFolderLibrary({
  tabs,
}: {
  tabs: ReactNode
}) {
  const queryClient = useQueryClient()
  const [folderId, setFolderId] = useState<number | null>(null)
  const [activePath, setActivePath] = useState('')
  const [text, setText] = useState('')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [detailId, setDetailId] = useState<string | null>(null)
  const [groupId, setGroupId] = useState<number | null>(null)
  const [registering, setRegistering] = useState(false)
  const [removing, setRemoving] = useState<SharedFolder | null>(null)
  const [importing, setImporting] = useState(false)

  const foldersQuery = useQuery({
    queryKey: ['sal-shared-folders'],
    queryFn: () => apiStudio.sharedFolders(),
  })
  const folders = foldersQuery.data?.items ?? []
  useEffect(() => {
    if (folders.length === 0) {
      setFolderId(null)
      return
    }
    if (folderId === null || !folders.some((folder) => folder.id === folderId)) {
      setFolderId(folders[0].id)
    }
  }, [folderId, folders])

  const treeQuery = useQuery({
    queryKey: ['sal-shared-tree', folderId],
    queryFn: () => apiStudio.sharedFolderTree(folderId as number),
    enabled: folderId !== null,
  })
  const groupsQuery = useQuery({ queryKey: ['sal-groups'], queryFn: () => apiStudio.assetGroups() })
  const groups: AssetGroup[] = groupsQuery.data?.items ?? []
  const nodes = useMemo(() => flattenNodes(treeQuery.data?.tree), [treeQuery.data])
  const activeNode = nodes.find((node) => node.path === activePath) ?? treeQuery.data?.tree
  const search = text.trim().toLowerCase()
  const items = useMemo(() => {
    const source = search === '' ? (activeNode?.items ?? []) : flattenItems(treeQuery.data?.tree)
    return source.filter((item) => (
      search === ''
      || `${item.name} ${item.relative_path} ${kindLabel(item.kind)}`.toLowerCase().includes(search)
    ))
  }, [activeNode, search, treeQuery.data])
  const detail = flattenItems(treeQuery.data?.tree).find((item) => item.id === detailId) ?? null

  useEffect(() => {
    setActivePath('')
    setSelected(new Set())
    setDetailId(null)
  }, [folderId])

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['sal-shared-folders'] })
    void queryClient.invalidateQueries({ queryKey: ['sal-shared-tree'] })
  }

  const toggle = (item: SharedFolderItem) => {
    setDetailId(item.id)
    setSelected((previous) => {
      const next = new Set(previous)
      if (next.has(item.id)) next.delete(item.id)
      else next.add(item.id)
      return next
    })
  }

  const importSelected = async () => {
    if (folderId === null || selected.size === 0 || importing) return
    const paths = flattenItems(treeQuery.data?.tree)
      .filter((item) => selected.has(item.id))
      .map((item) => item.relative_path)
    setImporting(true)
    try {
      const result = await apiStudio.importSharedFolderFiles(folderId, {
        paths,
        group_id: groupId,
      })
      if (result.failed.length > 0) {
        toast.error(`已导入 ${result.items.length} 个，失败 ${result.failed.length} 个：${result.failed[0].reason}`)
      } else {
        toast.success(`已复制 ${result.items.length} 个素材到素材库，原文件保持不变`)
      }
      setSelected(new Set())
      void queryClient.invalidateQueries({ queryKey: ['sal-assets'] })
      void queryClient.invalidateQueries({ queryKey: ['sal-media-assets'] })
      void queryClient.invalidateQueries({ queryKey: ['sal-groups'] })
    } catch (error) {
      toast.error(`导入失败：${errText(error)}`)
    } finally {
      setImporting(false)
    }
  }

  const removeFolder = async () => {
    if (removing === null) return
    try {
      await apiStudio.deleteSharedFolder(removing.id)
      toast.success('已移除共享文件夹登记，磁盘文件没有删除')
      setRemoving(null)
      refresh()
    } catch (error) {
      toast.error(errText(error))
    }
  }

  return (
    <main className="page sal-page">
      <aside className="sal-side sal-shared-side">
        <div className="sal-side-sec"><span>已登记目录</span></div>
        {foldersQuery.isPending && <p className="sal-side-note">载入共享目录…</p>}
        {foldersQuery.isError && <p className="sal-side-note sal-side-err">{errText(foldersQuery.error)}</p>}
        {!foldersQuery.isPending && folders.length === 0 && (
          <p className="sal-side-note">还没有共享目录。登记项目内文件夹后，可只读浏览并复制素材。</p>
        )}
        {folders.map((folder) => (
          <div className="sal-shared-folder-row" key={folder.id}>
            <button
              className={folder.id === folderId ? 'sal-item sal-item-on' : 'sal-item'}
              onClick={() => setFolderId(folder.id)}
              title={folder.path}
            >
              {folder.exists ? <FolderOpen /> : <Folder />}
              <span className="sal-item-name">{folder.name}</span>
              {!folder.exists && <small>已丢失</small>}
            </button>
            <button className="sal-act" aria-label={`移除${folder.name}`} onClick={() => setRemoving(folder)}>
              <Trash2 />
            </button>
          </div>
        ))}
        {treeQuery.data !== undefined && (
          <div className="sal-shared-tree">
            <div className="sal-side-sec"><span>目录树</span></div>
            <FolderNodeRow node={treeQuery.data.tree} depth={0} activePath={activePath} onOpen={setActivePath} />
          </div>
        )}
        <button className="sal-new" onClick={() => setRegistering(true)}><Plus />登记共享文件夹</button>
      </aside>

      <section className="sal-main">
        {tabs}
        <header className="sal-head">
          <div>
            <h1>素材库</h1>
            <p>本地素材 · 共享目录只读，选中后复制入素材库，原文件保持不变</p>
          </div>
          <span className="sal-flex" />
          <button className="btn btn-outline" onClick={() => setRegistering(true)}><Plus />登记目录</button>
          <button className="btn btn-outline" onClick={refresh}><RefreshCw />刷新</button>
        </header>
        <div className="sal-bar">
          <span className="sal-search">
            <IconSearch />
            <input value={text} placeholder="搜索共享文件夹素材…" onChange={(event) => setText(event.target.value)} />
          </span>
          <Picker
            size="sm"
            value={groupId === null ? 'none' : String(groupId)}
            onChange={(value) => setGroupId(value === 'none' ? null : Number(value))}
            options={[
              { value: 'none', label: '复制到未归组' },
              ...groups.map((group) => ({
                value: String(group.id),
                label: group.parent_id === null ? group.name : `　└ ${group.name}`,
              })),
            ]}
          />
          <button className="btn btn-soft" disabled={selected.size === 0 || importing} onClick={() => void importSelected()}>
            <Check />{importing ? '复制中…' : `复制所选（${selected.size}）`}
          </button>
        </div>
        {treeQuery.isError && <p className="sal-note sal-note-err">读取共享目录失败：{errText(treeQuery.error)}</p>}
        <div className="sal-body">
          {treeQuery.isPending && folderId !== null && <p className="sal-empty">读取共享目录…</p>}
          {folderId === null && <p className="sal-empty">登记一个 Lingua 项目内的素材目录后，即可从这里浏览。</p>}
          {treeQuery.data !== undefined && items.length === 0 && (
            <p className="sal-empty">{search === '' ? '当前目录没有支持的图片、视频或音频。' : '没有匹配的共享素材。'}</p>
          )}
          {items.length > 0 && (
            <div className="sal-grid sal-shared-grid">
              {items.map((item) => (
                <button
                  key={item.id}
                  className={selected.has(item.id) ? 'sal-cell sal-cell-on sal-shared-cell' : 'sal-cell sal-shared-cell'}
                  onClick={() => toggle(item)}
                  title={item.relative_path}
                >
                  {item.kind === 'image' ? (
                    <img src={item.url} alt="" loading="lazy" />
                  ) : (
                    <span className="sal-media-icon">
                      {item.kind === 'video' ? <Film /> : item.kind === 'audio' ? <Music /> : <FileText />}
                    </span>
                  )}
                  <span className="sal-media-name">{item.name}</span>
                  <span className="sal-media-meta">{kindLabel(item.kind)} · {sizeLabel(item.size)}</span>
                  {selected.has(item.id) && <span className="sal-tick"><Check /></span>}
                </button>
              ))}
            </div>
          )}
        </div>
      </section>

      {detail !== null && (
        <aside className="sal-media-detail" aria-label="共享素材详情">
          <header><strong>{detail.name}</strong><button className="btn-ghost-sm" onClick={() => setDetailId(null)}><IconClose /></button></header>
          {detail.kind === 'image' && <img className="sal-shared-preview" src={detail.url} alt="" />}
          {detail.kind === 'video' && <video src={detail.url} controls playsInline preload="metadata" />}
          {detail.kind === 'audio' && <audio src={detail.url} controls preload="metadata" />}
          {detail.kind === 'file' && <div className="sal-media-file"><IconImage /></div>}
          <dl>
            <div><dt>相对路径</dt><dd>{detail.relative_path}</dd></div>
            <div><dt>类型</dt><dd>{kindLabel(detail.kind)}</dd></div>
            <div><dt>大小</dt><dd>{sizeLabel(detail.size)}</dd></div>
          </dl>
          <p className="sal-shared-readonly">共享目录为只读引用。导入会复制一份到素材库，不会移动或删除这里的原文件。</p>
          <button className="btn btn-soft" onClick={() => toggle(detail)}>
            <Check />{selected.has(detail.id) ? '取消选择' : '选择并准备复制'}
          </button>
        </aside>
      )}

      {registering && (
        <RegisterDialog
          onClose={() => setRegistering(false)}
          onSaved={(folder) => {
            setRegistering(false)
            setFolderId(folder.id)
            refresh()
          }}
        />
      )}
      {removing !== null && (
        <Overlay onClose={() => setRemoving(null)} card="ov-narrow" labelledBy="sal-shared-remove-title">
          <header className="overlay-head"><h2 id="sal-shared-remove-title">移除“{removing.name}”？</h2></header>
          <p className="overlay-copy">只会移除 Lingua 里的登记记录，不会删除磁盘目录或任何原文件。</p>
          <footer className="overlay-foot">
            <button className="btn btn-outline" onClick={() => setRemoving(null)}>取消</button>
            <button className="btn btn-danger" onClick={() => void removeFolder()}>确认移除</button>
          </footer>
        </Overlay>
      )}
    </main>
  )
}
