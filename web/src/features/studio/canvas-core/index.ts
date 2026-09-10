/* 画布内核对外出口（模块 17 · CR-005 §3.1）。
 *
   自研内核，替代 @xyflow/react。结构直译自 Infinite-Canvas：
   `#board > #world > (svg 连线 + div 节点)`，没有 Canvas/WebGL。

   放弃 React Flow 的三条实证理由见 CLAUDE.md 踩坑索引；
   手感常数由 geometry.test.ts 锁住，改数字会在测试里炸。 */

export { ConnectionLayer, DraftConnection, EraseTrail } from './ConnectionLayer'
export type { ConnectionLayerProps, RenderedConnection } from './ConnectionLayer'

export { ContextMenu } from './ContextMenu'
export type { ContextMenuProps, MenuItem, MenuSection } from './ContextMenu'

export { Minimap } from './Minimap'
export type { MinimapProps } from './Minimap'

export { AlignGuides } from './AlignGuides'

export { NodeShell, NodeToolButton } from './NodeShell'
export type { NodeShellProps, PortSide } from './NodeShell'

export { applySelection, selectModeOf } from './selection'
export type { SelectMode } from './selection'

export { GUIDE_EPSILON, SNAP_TOLERANCE_PX, alignmentSnap, unionRect } from './snapping'
export type { SnapAxis, SnapGuide, SnapOptions, SnapResult } from './snapping'

export {
  RESIZE_HANDLES,
  WIDTH_RESIZE_HANDLES,
  arrangeGrid,
  capturePointer,
  growRectAnchored,
  releasePointer,
  resizeCursor,
  resizeRectBy,
  connectionEndpoints,
  connectionMidpoint,
  connectionPath,
  fitRects,
  rectContains,
  rectFromPoints,
  rectsIntersect,
  safeScale,
  samplePointerPath,
  screenToWorld,
  viewportCenter,
  wheelZoomFactor,
  worldToScreen,
  zoomAtPoint,
} from './geometry'
export type { ConnectionKind, Point, Rect, ResizeHandle, Viewport } from './geometry'

export {
  GESTURES,
  MOD_LABEL,
  SHORTCUTS,
  shortcutGroups,
  shortcutLabel,
  useCanvasShortcuts,
  IS_MAC,
} from './shortcuts'
export type { GestureSpec, ShortcutAction, ShortcutHandlers, ShortcutSpec } from './shortcuts'

export { NORMAL_KEYMAP, SMART_KEYMAP, resetZoom, useCanvasInput, useKeyHeld, useSpaceHeld, zoomByStep } from './useCanvasInput'
export type { CanvasInputOptions, CanvasInputState, DragMode, KeyMap, MarqueeOptions } from './useCanvasInput'

export {
  canvasScale,
  canvasSize,
  canvasToScreen,
  canvasView,
  measuredBox,
  registerCanvas,
  resetCanvasRegistry,
  screenToCanvas,
  watchViewport,
} from './registry'
export type { ViewControls } from './registry'
