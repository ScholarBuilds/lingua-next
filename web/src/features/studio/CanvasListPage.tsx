/* 画布列表页（FR-469 的 M1 子集）：卡片、内联改名、9 色点、置顶、回收站。

   meta 类操作（改名/换色/置顶）走 PATCH /meta，不刷 updated_at——打个标签
   不该把画布顶到列表最前（BR-146）。 */

import { useEffect, useMemo, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent, WheelEvent as ReactWheelEvent } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Archive, Download, Folder, FolderOpen, Layers3, Maximize2, MoreHorizontal, RefreshCw, Scissors, Sparkles, ZoomIn, ZoomOut } from '@/components/NexusIcon'
import { useNavigate } from 'react-router-dom'
import { toast } from 'sonner'

import { Overlay, useEscapeClose } from '../../components/Overlay'
import { IconClose, IconEdit, IconPlus, IconStar, IconTrash } from '../../components/icons'
import { Picker } from '@/components/ui/picker'
import { apiStudio } from '../../lib/api-studio'
import type { CanvasSummary, StudioProject } from '../../lib/api-studio'
import {
  fitBoardCanvases,
  layoutBoardCanvases,
  zoomBoardAt,
} from './canvas-list-board'
import { capturePointer, releasePointer, screenToWorld, viewportCenter } from './canvas-core/geometry'
import type { Point, Viewport } from './canvas-core/geometry'
import './canvas.css'
import './canvas-list.css'
import { saveFile } from '@/lib/shell'

/** 9 色全部取自 tokens：色点是分类标记不是装饰，跟主题一起明暗切换 */
const COLORS = ['gray', 'indigo', 'blue', 'teal', 'green', 'yellow', 'amber', 'red', 'pink'] as const
const CURRENT_PROJECT_KEY = 'studio-canvas-current-project'

interface CardDragState {
  pointerId: number
  canvasId: number
  startWorld: Point
  origin: Point
  current: Point
  moved: boolean
}

interface BoardPanState {
  pointerId: number
  startClient: Point
  origin: Point
}

function colorKey(raw: string): string {
  return (COLORS as readonly string[]).includes(raw) ? raw : 'gray'
}

function fmtTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

export default function CanvasListPage() {
  const qc = useQueryClient()
  const navigate = useNavigate()
  const [trashOpen, setTrashOpen] = useState(false)
  const [renaming, setRenaming] = useState<{ id: number; draft: string } | null>(null)
  const [colorFor, setColorFor] = useState<number | null>(null)
  const [currentProject, setCurrentProject] = useState(
    () => window.localStorage.getItem(CURRENT_PROJECT_KEY) || 'default',
  )
  const [projectDraft, setProjectDraft] = useState<string | null>(null)
  const [renamingProject, setRenamingProject] = useState<{ id: string; draft: string } | null>(null)
  const [deletingProject, setDeletingProject] = useState<StudioProject | null>(null)
  const [creatingCanvas, setCreatingCanvas] = useState(false)
  const [createPoint, setCreatePoint] = useState<Point | null>(null)
  const [cutCanvas, setCutCanvas] = useState<CanvasSummary | null>(null)
  const [cardMenu, setCardMenu] = useState<{
    canvas: CanvasSummary
    left: number
    top: number
  } | null>(null)
  const [exportingCanvas, setExportingCanvas] = useState<{ id: number; resources: boolean } | null>(null)
  const [viewport, setViewport] = useState<Viewport>({ x: 0, y: 0, scale: 1 })
  // 桌面实测宽度：补位列数与自适应缩放都按它算，列数写死会让窄屏卡片摆到视口外
  const [boardWidth, setBoardWidth] = useState(0)
  const [panning, setPanning] = useState(false)
  const [draggingCanvas, setDraggingCanvas] = useState<number | null>(null)
  const [draftPositions, setDraftPositions] = useState<Record<number, Point>>({})
  const boardRef = useRef<HTMLDivElement | null>(null)
  const panRef = useRef<BoardPanState | null>(null)
  const dragRef = useRef<CardDragState | null>(null)
  const suppressClickRef = useRef(new Set<number>())
  const autoPositionedRef = useRef(new Set<number>())
  const fittedProjectRef = useRef<string | null>(null)
  // 用户自己平移/缩放过就不再自动重置视图，窗口缩放也不抢镜
  const userMovedRef = useRef(false)

  const projects = useQuery({ queryKey: ['studio-projects'], queryFn: apiStudio.projects })
  const list = useQuery({
    queryKey: ['studio-canvases', currentProject],
    queryFn: () => apiStudio.canvases(false, currentProject),
  })

  useEffect(() => {
    const rows = projects.data?.items
    if (!rows || rows.length === 0) return
    if (!rows.some((project) => project.id === currentProject)) {
      setCurrentProject(rows[0].id)
    }
  }, [currentProject, projects.data])

  useEffect(() => {
    window.localStorage.setItem(CURRENT_PROJECT_KEY, currentProject)
    fittedProjectRef.current = null
    userMovedRef.current = false
    setDraftPositions({})
    setViewport({ x: 0, y: 0, scale: 1 })
  }, [currentProject])

  // 色点弹层点外面关掉。监听 mousedown 而不是 click：打开那次点击还在冒泡，
  // 挂 click 会立刻把弹层关回去（仓里踩过）
  useEffect(() => {
    if (colorFor === null) return
    const onDown = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null
      if (t === null || t.closest('.scl-colors') === null) setColorFor(null)
    }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [colorFor])

  useEffect(() => {
    if (cardMenu === null) return
    const onDown = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null
      if (target?.closest('.scl-card-pop, .scl-card-menu') === null) setCardMenu(null)
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setCardMenu(null)
    }
    const close = () => setCardMenu(null)
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    window.addEventListener('resize', close)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('resize', close)
    }
  }, [cardMenu])

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ['studio-canvases'] })
    void qc.invalidateQueries({ queryKey: ['studio-projects'] })
  }

  const patchMeta = async (
    id: number,
    body: {
      title?: string
      color?: string
      pinned?: boolean
      project?: string
      board_x?: number
      board_y?: number
    },
  ) => {
    try {
      await apiStudio.patchCanvasMeta(id, body)
      invalidate()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '更新失败')
    }
  }

  const create = async (draft: { title: string; kind: 'classic' | 'smart' }) => {
    try {
      const d = await apiStudio.createCanvas({
        title: draft.title,
        kind: draft.kind,
        project: currentProject,
        icon: draft.kind === 'smart' ? 'sparkles' : 'layers',
        board_x: createPoint === null ? undefined : Math.round(createPoint.x),
        board_y: createPoint === null ? undefined : Math.round(createPoint.y),
      })
      setCreatingCanvas(false)
      setCreatePoint(null)
      invalidate()
      navigate(`/studio/canvas/${d.id}`)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '新建失败')
    }
  }

  const openCreateCanvas = (point?: Point) => {
    if (point !== undefined) {
      setCreatePoint(point)
    } else {
      const board = boardRef.current
      setCreatePoint(board === null ? null : viewportCenter(board.clientWidth, board.clientHeight, viewport))
    }
    setCreatingCanvas(true)
  }

  const trash = async (c: CanvasSummary) => {
    try {
      await apiStudio.trashCanvas(c.id)
      toast.success(`「${c.title || '未命名画布'}」已进回收站，30 天内可恢复`)
      invalidate()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '删除失败')
    }
  }

  const commitRename = async () => {
    if (renaming === null) return
    const { id, draft } = renaming
    setRenaming(null)
    const next = draft.trim()
    if (next === '') return
    await patchMeta(id, { title: next })
  }

  const createProject = async () => {
    const name = projectDraft?.trim() || '新项目'
    try {
      const row = await apiStudio.createProject({ name })
      setProjectDraft(null)
      setCurrentProject(row.id)
      invalidate()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '创建项目失败')
    }
  }

  const commitProjectRename = async () => {
    if (renamingProject === null) return
    const next = renamingProject.draft.trim()
    const id = renamingProject.id
    setRenamingProject(null)
    if (next === '') return
    try {
      await apiStudio.patchProject(id, { name: next })
      invalidate()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '项目重命名失败')
    }
  }

  const removeProject = async () => {
    if (deletingProject === null) return
    try {
      const result = await apiStudio.deleteProject(deletingProject.id)
      setDeletingProject(null)
      if (currentProject === deletingProject.id) setCurrentProject('default')
      toast.success(`项目已删除，${result.moved} 块画布移回默认项目`)
      invalidate()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '删除项目失败')
    }
  }

  const pasteCutCanvas = async () => {
    if (cutCanvas === null) return
    try {
      await apiStudio.patchCanvasMeta(cutCanvas.id, { project: currentProject })
      toast.success(`「${cutCanvas.title || '未命名画布'}」已移动到当前项目`)
      setCutCanvas(null)
      invalidate()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '移动画布失败')
    }
  }

  const openCardMenu = (canvas: CanvasSummary, anchor: HTMLButtonElement) => {
    const rect = anchor.getBoundingClientRect()
    const width = 214
    const estimatedHeight = 292
    const left = Math.max(12, Math.min(rect.left, window.innerWidth - width - 12))
    const below = rect.bottom + 6
    const top = below + estimatedHeight > window.innerHeight - 12
      ? Math.max(12, rect.top - estimatedHeight - 6)
      : below
    setCardMenu({ canvas, left: Math.round(left), top: Math.round(top) })
  }

  const downloadCanvas = async (canvas: CanvasSummary, includeResources: boolean) => {
    setCardMenu(null)
    setExportingCanvas({ id: canvas.id, resources: includeResources })
    try {
      const result = await apiStudio.exportCanvasPackage(canvas.id, {
        include_resources: includeResources,
        filename: canvas.title || '未命名画布',
      })
      saveFile(result.blob, result.filename)
      toast.success(includeResources ? '已导出完整画布与原始资源 ZIP' : '已导出完整画布 JSON')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '导出失败')
    } finally {
      setExportingCanvas(null)
    }
  }

  const items = [...(list.data?.items ?? [])].sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1
    return b.updated_at.localeCompare(a.updated_at)
  })
  const current = useMemo(
    () => projects.data?.items.find((project) => project.id === currentProject) ?? null,
    [currentProject, projects.data],
  )
  const boardItems = useMemo(() => layoutBoardCanvases(items, boardWidth), [items, boardWidth])
  const renderedBoardItems = useMemo(
    () => boardItems.map((item) => ({ ...item, ...(draftPositions[item.canvas.id] ?? {}) })),
    [boardItems, draftPositions],
  )
  const boardPositionById = useMemo(
    () => new Map(renderedBoardItems.map((item) => [item.canvas.id, { x: item.x, y: item.y }])),
    [renderedBoardItems],
  )

  // 旧画布没有列表世界坐标。按 Infinite-Canvas 的网格兼容排布展示，并且只补写一次，
  // 后续所有项目切换、刷新和拖拽都读取服务端位置。
  useEffect(() => {
    // 宽度还没量到就补位会按兜底的 4 列写库，之后再也纠不回来——等量到再写
    if (boardWidth <= 0) return
    const pending = boardItems.filter(
      (item) => item.generated && !autoPositionedRef.current.has(item.canvas.id),
    )
    if (pending.length === 0) return
    pending.forEach((item) => autoPositionedRef.current.add(item.canvas.id))
    const positions = new Map(pending.map((item) => [item.canvas.id, { x: item.x, y: item.y }]))

    void Promise.all(
      pending.map((item) => apiStudio.patchCanvasMeta(item.canvas.id, {
        board_x: Math.round(item.x),
        board_y: Math.round(item.y),
      })),
    ).then(() => {
      qc.setQueryData<{ items: CanvasSummary[] }>(['studio-canvases', currentProject], (old) => (
        old === undefined
          ? old
          : {
              items: old.items.map((canvas) => {
                const position = positions.get(canvas.id)
                return position === undefined
                  ? canvas
                  : { ...canvas, board_x: position.x, board_y: position.y }
              }),
            }
      ))
    }).catch((error: unknown) => {
      toast.error(error instanceof Error ? error.message : '画布位置初始化失败')
    })
  }, [boardItems, boardWidth, currentProject, qc])

  const fitBoard = () => {
    const board = boardRef.current
    if (board === null) return
    userMovedRef.current = false
    setViewport(fitBoardCanvases(renderedBoardItems, board.clientWidth, board.clientHeight))
  }

  // 桌面尺寸跟着窗口与左侧项目栏变，量到才知道该铺几列
  useEffect(() => {
    const board = boardRef.current
    if (board === null) return
    const apply = (next: number) => {
      setBoardWidth((prev) => (Math.abs(prev - next) < 1 ? prev : next))
    }
    apply(board.clientWidth)
    const observer = new ResizeObserver((entries) => {
      apply(entries[0]?.contentRect.width ?? board.clientWidth)
    })
    observer.observe(board)
    return () => observer.disconnect()
  }, [])

  // 窗口缩放后重新自适应；用户已经自己平移或缩放过就不动他的视角
  useEffect(() => {
    if (boardWidth <= 0 || userMovedRef.current) return
    if (fittedProjectRef.current !== currentProject) return
    fitBoard()
  }, [boardWidth, currentProject])

  useEffect(() => {
    if (list.data === undefined || fittedProjectRef.current === currentProject) return
    const frame = window.requestAnimationFrame(() => {
      fitBoard()
      fittedProjectRef.current = currentProject
    })
    return () => window.cancelAnimationFrame(frame)
  }, [currentProject, list.data, renderedBoardItems])

  const persistBoardPosition = async (canvasId: number, position: Point) => {
    try {
      await apiStudio.patchCanvasMeta(canvasId, {
        board_x: Math.round(position.x),
        board_y: Math.round(position.y),
      })
      qc.setQueryData<{ items: CanvasSummary[] }>(['studio-canvases', currentProject], (old) => (
        old === undefined
          ? old
          : {
              items: old.items.map((canvas) => (
                canvas.id === canvasId
                  ? { ...canvas, board_x: Math.round(position.x), board_y: Math.round(position.y) }
                  : canvas
              )),
            }
      ))
      setDraftPositions((currentPositions) => {
        const next = { ...currentPositions }
        delete next[canvasId]
        return next
      })
    } catch (error) {
      setDraftPositions((currentPositions) => {
        const next = { ...currentPositions }
        delete next[canvasId]
        return next
      })
      toast.error(error instanceof Error ? error.message : '画布位置保存失败')
    }
  }

  const handleBoardPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    const target = event.target as HTMLElement
    if (target.closest('.scl-card, .scl-board-controls, button, input, textarea') !== null) return
    capturePointer(event.currentTarget, event.pointerId)
    panRef.current = {
      pointerId: event.pointerId,
      startClient: { x: event.clientX, y: event.clientY },
      origin: { x: viewport.x, y: viewport.y },
    }
    setPanning(true)
  }

  const handleBoardPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const pan = panRef.current
    if (pan === null || pan.pointerId !== event.pointerId) return
    userMovedRef.current = true
    setViewport((currentViewport) => ({
      ...currentViewport,
      x: pan.origin.x + event.clientX - pan.startClient.x,
      y: pan.origin.y + event.clientY - pan.startClient.y,
    }))
  }

  const finishBoardPan = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (panRef.current?.pointerId !== event.pointerId) return
    panRef.current = null
    releasePointer(event.currentTarget, event.pointerId)
    setPanning(false)
  }

  const handleBoardWheel = (event: ReactWheelEvent<HTMLDivElement>) => {
    event.preventDefault()
    const rect = event.currentTarget.getBoundingClientRect()
    const anchor = { x: event.clientX - rect.left, y: event.clientY - rect.top }
    userMovedRef.current = true
    setViewport((currentViewport) => zoomBoardAt(currentViewport, anchor, event.deltaY < 0))
  }

  const zoomBoardFromCenter = (zoomIn: boolean) => {
    const board = boardRef.current
    if (board === null) return
    const anchor = { x: board.clientWidth / 2, y: board.clientHeight / 2 }
    userMovedRef.current = true
    setViewport((currentViewport) => zoomBoardAt(currentViewport, anchor, zoomIn))
  }

  const handleCardPointerDown = (
    event: ReactPointerEvent<HTMLElement>,
    canvas: CanvasSummary,
  ) => {
    if (event.button !== 0) return
    const target = event.target as HTMLElement
    if (target.closest('button, input, .scl-color-pop') !== null) return
    const board = boardRef.current
    const position = boardPositionById.get(canvas.id)
    if (board === null || position === undefined) return
    event.stopPropagation()
    capturePointer(event.currentTarget, event.pointerId)
    const rect = board.getBoundingClientRect()
    dragRef.current = {
      pointerId: event.pointerId,
      canvasId: canvas.id,
      startWorld: screenToWorld(event.clientX, event.clientY, { x: rect.left, y: rect.top }, viewport),
      origin: position,
      current: position,
      moved: false,
    }
  }

  const handleCardPointerMove = (event: ReactPointerEvent<HTMLElement>) => {
    const drag = dragRef.current
    const board = boardRef.current
    if (drag === null || board === null || drag.pointerId !== event.pointerId) return
    const rect = board.getBoundingClientRect()
    const world = screenToWorld(event.clientX, event.clientY, { x: rect.left, y: rect.top }, viewport)
    const dx = world.x - drag.startWorld.x
    const dy = world.y - drag.startWorld.y
    if (!drag.moved && (Math.abs(dx * viewport.scale) > 5 || Math.abs(dy * viewport.scale) > 5)) {
      drag.moved = true
      setDraggingCanvas(drag.canvasId)
    }
    if (!drag.moved) return
    drag.current = { x: drag.origin.x + dx, y: drag.origin.y + dy }
    setDraftPositions((currentPositions) => ({
      ...currentPositions,
      [drag.canvasId]: drag.current,
    }))
  }

  const finishCardDrag = (event: ReactPointerEvent<HTMLElement>, cancelled = false) => {
    const drag = dragRef.current
    if (drag === null || drag.pointerId !== event.pointerId) return
    dragRef.current = null
    releasePointer(event.currentTarget, event.pointerId)
    setDraggingCanvas(null)
    if (!drag.moved) return

    suppressClickRef.current.add(drag.canvasId)
    window.setTimeout(() => suppressClickRef.current.delete(drag.canvasId), 0)
    if (cancelled) {
      setDraftPositions((currentPositions) => {
        const next = { ...currentPositions }
        delete next[drag.canvasId]
        return next
      })
      return
    }
    void persistBoardPosition(drag.canvasId, drag.current)
  }

  const openCanvas = (canvas: CanvasSummary) => {
    if (suppressClickRef.current.delete(canvas.id)) return
    navigate(`/studio/canvas/${canvas.id}`)
  }

  return (
    <main className="page scl-page">
      <aside className="scl-projects">
        <div className="scl-projects-head">
          <strong>项目</strong>
          <button className="btn-ghost-sm" aria-label="新建项目" onClick={() => setProjectDraft('')}>
            <IconPlus />
          </button>
        </div>
        {projectDraft !== null ? (
          <div className="scl-project-new">
            <input
              value={projectDraft}
              autoFocus
              maxLength={60}
              placeholder="项目名称"
              onChange={(event) => setProjectDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void createProject()
                if (event.key === 'Escape') setProjectDraft(null)
              }}
            />
            <button className="btn btn-primary btn-sm" onClick={() => void createProject()}>创建</button>
          </div>
        ) : null}
        <div className="scl-project-list">
          {(projects.data?.items ?? []).map((project) => (
            <div
              key={project.id}
              className={currentProject === project.id ? 'scl-project is-active' : 'scl-project'}
            >
              {renamingProject?.id === project.id ? (
                <div className="scl-project-main">
                  {currentProject === project.id ? <FolderOpen /> : <Folder />}
                  <input
                    value={renamingProject.draft}
                    autoFocus
                    onClick={(event) => event.stopPropagation()}
                    onChange={(event) => setRenamingProject({ id: project.id, draft: event.target.value })}
                    onBlur={() => void commitProjectRename()}
                    onKeyDown={(event) => {
                      event.stopPropagation()
                      if (event.key === 'Enter') void commitProjectRename()
                      if (event.key === 'Escape') setRenamingProject(null)
                    }}
                  />
                  <small>{project.canvas_count}</small>
                </div>
              ) : (
                <button className="scl-project-main" onClick={() => setCurrentProject(project.id)}>
                  {currentProject === project.id ? <FolderOpen /> : <Folder />}
                  <span>{project.name}</span>
                  <small>{project.canvas_count}</small>
                </button>
              )}
              <div className="scl-project-actions">
                <button aria-label="重命名项目" onClick={() => setRenamingProject({ id: project.id, draft: project.name })}>
                  <IconEdit />
                </button>
                {project.id !== 'default' ? (
                  <button aria-label="删除项目" onClick={() => setDeletingProject(project)}><IconTrash /></button>
                ) : null}
              </div>
            </div>
          ))}
        </div>
        <button className="scl-trash-entry" onClick={() => setTrashOpen(true)}>
          <IconTrash />回收站
        </button>
      </aside>

      <div className="scl-workspace">
        <header className="scl-head">
          <div className="scl-head-title">
            <div className="scl-head-name">
              <h1>{current?.name ?? '无限画布'}</h1>
              <span className="scl-board-count">{items.length}</span>
            </div>
            <p className="scl-sub">经典画布用 Shift 框选；智能画布用 ⌘/Ctrl 或 R 框选，Shift 切线</p>
          </div>
          <span className="scv-flex" />
          {cutCanvas !== null ? (
            <button
              className="btn btn-outline scll-keep"
              disabled={cutCanvas.project === currentProject}
              onClick={() => void pasteCutCanvas()}
            >
              <Scissors />粘贴「{cutCanvas.title || '未命名画布'}」
            </button>
          ) : null}
          <button className="btn-ghost-sm scl-head-tool scll-keep" aria-label="刷新画布列表" title="刷新" onClick={() => void list.refetch()}>
            <RefreshCw />
          </button>
          <button className="btn-ghost-sm scl-head-tool scll-keep" aria-label="重置无限桌面视图" title="重置视图" onClick={fitBoard}>
            <Maximize2 />
          </button>
          <button className="btn btn-primary scll-keep" onClick={() => openCreateCanvas()}>
            <IconPlus /> 新建画布
          </button>
        </header>

        <div
          ref={boardRef}
          className={panning ? 'scl-board is-panning' : 'scl-board'}
          style={{
            backgroundSize: `${120 * viewport.scale}px ${120 * viewport.scale}px, ${120 * viewport.scale}px ${120 * viewport.scale}px, ${24 * viewport.scale}px ${24 * viewport.scale}px`,
            backgroundPosition: `${viewport.x}px ${viewport.y}px, ${viewport.x}px ${viewport.y}px, ${viewport.x}px ${viewport.y}px`,
          }}
          onPointerDown={handleBoardPointerDown}
          onPointerMove={handleBoardPointerMove}
          onPointerUp={finishBoardPan}
          onPointerCancel={finishBoardPan}
          onWheel={handleBoardWheel}
          onDoubleClick={(event) => {
            const target = event.target as HTMLElement
            if (target.closest('.scl-card, button, input') !== null) return
            const rect = event.currentTarget.getBoundingClientRect()
            openCreateCanvas(screenToWorld(
              event.clientX,
              event.clientY,
              { x: rect.left, y: rect.top },
              viewport,
            ))
          }}
        >
          {list.isLoading ? <p className="scl-board-message">载入画布…</p> : null}
          {list.isError ? (
            <p className="scl-board-message">
              列表加载失败：{list.error instanceof Error ? list.error.message : '未知错误'}
            </p>
          ) : null}
          {list.data !== undefined && items.length === 0 ? (
            <div className="scl-blank">
              <Layers3 />
              <strong>还没有画布</strong>
              <span>双击空白位置也可以在这里创建</span>
              <button className="btn btn-primary" onClick={() => openCreateCanvas()}>
                <IconPlus /> 建第一块
              </button>
            </div>
          ) : null}

          <div
            className="scl-board-world"
            style={{ transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.scale})` }}
          >
          {renderedBoardItems.map(({ canvas: c, x, y }) => (
            <article
              key={c.id}
              className={[
                'scl-card',
                draggingCanvas === c.id ? 'is-dragging' : '',
                cutCanvas?.id === c.id ? 'is-cut' : '',
              ].filter(Boolean).join(' ')}
              data-c={colorKey(c.color)}
              data-canvas-id={c.id}
              data-board-x={Math.round(x)}
              data-board-y={Math.round(y)}
              style={{ left: x, top: y }}
              role="link"
              tabIndex={0}
              onClick={() => openCanvas(c)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault()
                  openCanvas(c)
                }
              }}
              onPointerDown={(event) => handleCardPointerDown(event, c)}
              onPointerMove={handleCardPointerMove}
              onPointerUp={(event) => finishCardDrag(event)}
              onPointerCancel={(event) => finishCardDrag(event, true)}
            >
              <div className="scl-thumb">
                {c.thumb_asset_id !== null ? (
                  <img src={`/api/images/assets/${c.thumb_asset_id}/thumb`} alt="" loading="lazy" draggable={false} />
                ) : (
                  <span className="scl-thumb-blank">
                    {c.kind === 'smart' ? <Sparkles /> : <Layers3 />}
                    {c.kind === 'smart' ? '智能画布' : '经典画布'}
                  </span>
                )}
                {c.pinned && <span className="scl-pin-badge">置顶</span>}
                <span className="scl-kind-badge">{c.kind === 'smart' ? '智能' : '经典'}</span>
                <button
                  className="scl-card-menu"
                  aria-label={`打开「${c.title || '未命名画布'}」菜单`}
                  title="更多"
                  onClick={(event) => {
                    event.stopPropagation()
                    openCardMenu(c, event.currentTarget)
                  }}
                >
                  <MoreHorizontal />
                </button>
              </div>
              <div className="scl-body">
                <div className="scl-title-row" onClick={(e) => e.stopPropagation()}>
                  <span className="scl-colors">
                    <button
                      className="scl-dot"
                      title="换颜色"
                      onClick={() => setColorFor(colorFor === c.id ? null : c.id)}
                    />
                    {colorFor === c.id && (
                      <span className="scl-color-pop">
                        {COLORS.map((k) => (
                          <button
                            key={k}
                            className="scl-dot"
                            data-c={k}
                            title={k}
                            onClick={() => {
                              setColorFor(null)
                              void patchMeta(c.id, { color: k })
                            }}
                          />
                        ))}
                      </span>
                    )}
                  </span>
                  {renaming !== null && renaming.id === c.id ? (
                    <input
                      className="scl-rename"
                      value={renaming.draft}
                      autoFocus
                      onChange={(e) => setRenaming({ id: c.id, draft: e.target.value })}
                      onBlur={() => void commitRename()}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') void commitRename()
                        if (e.key === 'Escape') {
                          // 两段式：Esc 只退出改名（STD-UI-002b）
                          e.stopPropagation()
                          setRenaming(null)
                        }
                      }}
                    />
                  ) : (
                    <span className="scl-title" title={c.title}>
                      {c.title || '未命名画布'}
                    </span>
                  )}
                </div>
                <div className="scl-meta">
                  {c.node_count} 节点 · {fmtTime(c.updated_at)}
                </div>
              </div>
            </article>
          ))}
          </div>
          <div className="scl-board-controls" aria-label="无限桌面视图控制">
            <button aria-label="缩小" title="缩小" onClick={() => zoomBoardFromCenter(false)}><ZoomOut /></button>
            <span>{Math.round(viewport.scale * 100)}%</span>
            <button aria-label="放大" title="放大" onClick={() => zoomBoardFromCenter(true)}><ZoomIn /></button>
            <button aria-label="适应全部画布" title="适应全部画布" onClick={fitBoard}><Maximize2 /></button>
          </div>
        </div>
      </div>

      {cardMenu !== null ? (
        <div
          className="scl-card-pop"
          role="menu"
          aria-label={`「${cardMenu.canvas.title || '未命名画布'}」操作`}
          style={{ left: cardMenu.left, top: cardMenu.top }}
        >
          <button
            role="menuitem"
            onClick={() => {
              setRenaming({ id: cardMenu.canvas.id, draft: cardMenu.canvas.title })
              setCardMenu(null)
            }}
          >
            <IconEdit /><span>重命名</span>
          </button>
          <button
            role="menuitem"
            onClick={() => {
              void patchMeta(cardMenu.canvas.id, { pinned: !cardMenu.canvas.pinned })
              setCardMenu(null)
            }}
          >
            <IconStar filled={cardMenu.canvas.pinned} />
            <span>{cardMenu.canvas.pinned ? '取消置顶' : '置顶'}</span>
          </button>
          <button
            role="menuitem"
            disabled={exportingCanvas !== null}
            onClick={() => void downloadCanvas(cardMenu.canvas, false)}
          >
            <Download /><span>导出画布 JSON</span>
          </button>
          <button
            role="menuitem"
            disabled={exportingCanvas !== null}
            onClick={() => void downloadCanvas(cardMenu.canvas, true)}
          >
            <Archive /><span>导出画布 + 资源</span>
          </button>
          <button
            role="menuitem"
            onClick={() => {
              setCutCanvas(cardMenu.canvas)
              setCardMenu(null)
              toast.success('已剪切，切换到目标项目后点击顶部“粘贴”')
            }}
          >
            <Scissors /><span>剪切到其他项目</span>
          </button>
          <span className="scl-card-pop-sep" />
          <button
            className="is-danger"
            role="menuitem"
            onClick={() => {
              setCardMenu(null)
              void trash(cardMenu.canvas)
            }}
          >
            <IconTrash /><span>移入回收站</span>
          </button>
        </div>
      ) : null}

      {trashOpen && <TrashDrawer onClose={() => setTrashOpen(false)} onChanged={invalidate} />}
      {creatingCanvas ? (
        <CreateCanvasDialog
          onClose={() => {
            setCreatingCanvas(false)
            setCreatePoint(null)
          }}
          onCreate={create}
        />
      ) : null}
      {deletingProject !== null ? (
        <Overlay onClose={() => setDeletingProject(null)} card="ov-narrow" labelledBy="scl-project-delete-title">
          <h2 id="scl-project-delete-title">删除「{deletingProject.name}」？</h2>
          <p className="scl-note">项目里的画布不会删除，会全部移回默认项目。</p>
          <div className="scl-dialog-actions">
            <button className="btn btn-outline" onClick={() => setDeletingProject(null)}>取消</button>
            <button className="btn btn-primary scl-danger" onClick={() => void removeProject()}>删除项目</button>
          </div>
        </Overlay>
      ) : null}
    </main>
  )
}

function CreateCanvasDialog({
  onClose,
  onCreate,
}: {
  onClose: () => void
  onCreate: (draft: { title: string; kind: 'classic' | 'smart' }) => Promise<void>
}) {
  const [title, setTitle] = useState('未命名画布')
  const [kind, setKind] = useState<'classic' | 'smart'>('classic')
  const [busy, setBusy] = useState(false)
  const submit = async () => {
    setBusy(true)
    try {
      await onCreate({ title: title.trim() || '未命名画布', kind })
    } finally {
      setBusy(false)
    }
  }
  return (
    <Overlay onClose={onClose} card="ov-narrow" labelledBy="scl-create-title">
      <h2 id="scl-create-title">新建画布</h2>
      <label className="scl-dialog-field">名称
        <input value={title} autoFocus maxLength={80} onChange={(event) => setTitle(event.target.value)} />
      </label>
      <label className="scl-dialog-field">画布类型
        <Picker
          value={kind}
          onChange={(value) => setKind(value as 'classic' | 'smart')}
          options={[
            { value: 'classic', label: '经典画布', hint: '显式节点编辑，Shift 框选' },
            { value: 'smart', label: '智能画布', hint: '@ 引用与底部创作编排' },
          ]}
        />
      </label>
      <p className="scl-note">
        {kind === 'classic'
          ? '经典画布：Shift 框选，Alt+Shift 切线，适合明确节点和端口的工作流。'
          : '智能画布：⌘/Ctrl 或 R 框选，Shift 切线，适合从素材与提示词连续创作。'}
      </p>
      <div className="scl-dialog-actions">
        <button className="btn btn-outline" onClick={onClose}>取消</button>
        <button className="btn btn-primary" disabled={busy} onClick={() => void submit()}>
          {busy ? '创建中…' : '创建画布'}
        </button>
      </div>
    </Overlay>
  )
}

/* ==================== 回收站抽屉 ==================== */

function TrashDrawer({ onClose, onChanged }: { onClose: () => void; onChanged: () => void }) {
  const qc = useQueryClient()
  // 侧滑抽屉套不进 <Overlay> 结构，但必须入同一个浮层栈（STD-UI-002a）
  useEscapeClose(onClose)
  // 彻底删除不可恢复：第一下只是上膛，第二下才真删
  const [armed, setArmed] = useState<number | null>(null)

  const trashed = useQuery({
    queryKey: ['studio-canvases-trashed'],
    queryFn: () => apiStudio.canvases(true),
  })

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['studio-canvases-trashed'] })
    onChanged()
  }

  const restore = async (id: number) => {
    try {
      await apiStudio.restoreCanvas(id)
      toast.success('已恢复')
      refresh()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '恢复失败')
    }
  }

  const purge = async (id: number) => {
    try {
      await apiStudio.purgeCanvas(id)
      toast.success('已彻底删除')
      setArmed(null)
      refresh()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '删除失败')
    }
  }

  return (
    <>
      <div className="scl-drawer-mask" onClick={onClose} />
      <aside className="scl-drawer" role="dialog" aria-label="回收站">
        <header className="scl-drawer-head">
          <h2>回收站</h2>
          <span className="scl-sub">30 天内可恢复，之后自动清理</span>
          <span className="scv-flex" />
          <button className="btn-ghost-sm" aria-label="关闭" onClick={onClose}>
            <IconClose />
          </button>
        </header>
        {trashed.isLoading && <p className="scl-note">载入…</p>}
        {trashed.data !== undefined && trashed.data.items.length === 0 && (
          <p className="scl-note">回收站是空的</p>
        )}
        <div className="scl-drawer-list">
          {(trashed.data?.items ?? []).map((c) => (
            <div key={c.id} className="scl-drawer-row">
              <span className="scl-title" title={c.title}>
                {c.title || '未命名画布'}
              </span>
              <span className="scl-meta">{c.node_count} 节点</span>
              <span className="scv-flex" />
              <button className="btn btn-outline btn-sm" onClick={() => void restore(c.id)}>
                恢复
              </button>
              {armed === c.id ? (
                <button className="btn btn-primary btn-sm scl-danger" onClick={() => void purge(c.id)}>
                  确认彻底删除
                </button>
              ) : (
                <button className="btn btn-outline btn-sm" onClick={() => setArmed(c.id)}>
                  彻底删除
                </button>
              )}
            </div>
          ))}
        </div>
      </aside>
    </>
  )
}
