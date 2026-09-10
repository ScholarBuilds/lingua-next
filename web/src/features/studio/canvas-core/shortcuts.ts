/* 画布内核 · 快捷键（模块 17 · 需求 §6.3）
 *
   移植自 Infinite-Canvas 两套画布的 keydown 处理
   （`static/js/canvas.js` 约 15964~16030 行、`smart-canvas.js` 同族）。

   蓝本把二十来个分支写在一个 `window.addEventListener('keydown')` 里，
   每个分支各自判一遍「现在是不是在输入框」「有没有浮层开着」，
   漏判一处就是「在输入框里按 Delete 把节点删了」这类事故。
   这里把判定收成一处，键位表做成数据：

   - **键位是数据不是代码**：帮助面板直接渲染这张表，不会出现
     「面板写着 Ctrl+G 而代码绑的是 Ctrl+Shift+G」这种两边对不上；
   - **平台感知**：mac 显示 ⌘，其它显示 Ctrl，绑定用同一个 `mod` 语义；
   - **输入态一律让路**：输入框、textarea、contenteditable 里只放行
     显式声明 `allowInInput` 的键。 */

import { useEffect, useMemo } from 'react'

export type ShortcutAction =
  | 'undo'
  | 'redo'
  | 'copy'
  | 'paste'
  | 'cut'
  | 'delete'
  | 'selectAll'
  | 'group'
  | 'ungroup'
  | 'duplicate'
  | 'toggleAssets'
  | 'toggleOverview'
  | 'fitView'
  | 'fitSelection'
  | 'zoomIn'
  | 'zoomOut'
  | 'resetZoom'
  | 'run'
  | 'stop'
  | 'save'
  | 'nudge'
  | 'help'
  | 'escape'

export interface ShortcutSpec {
  action: ShortcutAction
  /** 主键，小写。特殊键用 KeyboardEvent.key 的原名（Delete/Backspace/Escape/Enter） */
  key: string
  /** ⌘（mac）/ Ctrl（其它） */
  mod?: boolean
  shift?: boolean
  alt?: boolean
  /** 在输入框里也生效。默认 false */
  allowInInput?: boolean
  /** 绑定但不进帮助面板。用于同一个动作的键盘布局兼容别名 */
  hidden?: boolean
  label: string
  /** 一句话说明这个键干什么，帮助面板直接用 */
  hint: string
}

/** 键位表。改这里就同时改了绑定和帮助面板——两边不会再对不上 */
export const SHORTCUTS: ShortcutSpec[] = [
  { action: 'undo', key: 'z', mod: true, label: '撤销', hint: '退回上一步。画布上的每次改动都进撤销栈' },
  { action: 'redo', key: 'z', mod: true, shift: true, label: '重做', hint: '把刚撤销的那步再做一遍' },
  { action: 'copy', key: 'c', mod: true, label: '复制节点', hint: '复制选中的节点，可跨画布粘贴' },
  { action: 'paste', key: 'v', mod: true, label: '粘贴', hint: '优先粘系统剪贴板里的图片，没有才粘复制的节点' },
  { action: 'cut', key: 'x', mod: true, label: '剪切节点', hint: '复制并删除选中节点' },
  { action: 'selectAll', key: 'a', mod: true, label: '全选', hint: '选中画布上所有节点' },
  { action: 'delete', key: 'Delete', label: '删除', hint: '删掉选中的节点，连着它们的连线一起删' },
  { action: 'delete', key: 'Backspace', label: '删除', hint: '同 Delete', hidden: true },
  /* mac 笔记本键盘**没有 Delete 键**，右上角那个是 Backspace；
     系统级的「删除」手势是 ⌘+Delete（Finder 删文件就是它）。
     只认裸 Delete/Backspace 的话，mac 用户按惯用手势删不掉节点，
     而且按下去毫无反应——最难自证的一类。 */
  { action: 'delete', key: 'Backspace', mod: true, label: '删除', hint: 'mac 惯用手势（⌘+Delete）' },
  { action: 'delete', key: 'Delete', mod: true, label: '删除', hint: '同上', hidden: true },
  { action: 'group', key: 'g', mod: true, label: '成组', hint: '把选中的图片合并成一个组节点' },
  { action: 'ungroup', key: 'g', mod: true, shift: true, label: '解组', hint: '把组拆回一个个独立节点' },
  { action: 'duplicate', key: 'd', mod: true, label: '就地复制', hint: '在旁边复制一份，不占剪贴板' },
  { action: 'toggleAssets', key: 'a', label: '素材库', hint: '开关右侧素材库抽屉' },
  { action: 'toggleOverview', key: 'z', label: '缩略概览', hint: '缩到能看见全部节点，再按回到原来的位置' },
  { action: 'fitView', key: 'f', label: '适应画布', hint: '把所有节点装进视口' },
  /* 与 f（适应全部）同一族，差一个 Shift。上百个节点的画布里「适应全部」会缩到看不清，
     真正想看的永远是手头这几个 */
  { action: 'fitSelection', key: 'f', shift: true, label: '放大到选区', hint: '把选中的节点铺满视口，最多放到 2 倍' },
  { action: 'zoomIn', key: '=', label: '放大', hint: '以视口中心放大' },
  { action: 'zoomOut', key: '-', label: '缩小', hint: '以视口中心缩小' },
  { action: 'resetZoom', key: '0', mod: true, label: '实际大小', hint: '缩放回 100%' },
  { action: 'run', key: 'Enter', mod: true, label: '运行这条链', hint: '从选中节点沿参考输入边回溯并逐节点生成' },
  { action: 'stop', key: '.', mod: true, label: '停止', hint: '请求停止正在跑的级联，当前这一轮跑完就停' },
  { action: 'save', key: 's', mod: true, label: '立即保存', hint: '平时是改完 450ms 自动存，这个键让它马上存' },
  { action: 'nudge', key: 'ArrowLeft', label: '微移', hint: '方向键把选中节点挪 5px，按住 Shift 是 20px' },
  { action: 'help', key: '?', shift: true, label: '快捷键', hint: '打开这张表' },
  /* 有些键盘布局下 Shift+/ 报的是 `/` 而不是 `?`（实测 playwright 就是）。
     只认 `?` 的话那些键盘上这张表永远打不开，所以两个都收。 */
  { action: 'help', key: '/', shift: true, hidden: true, label: '快捷键', hint: '同 Shift+?' },
  { action: 'escape', key: 'Escape', allowInInput: true, label: '取消', hint: '关掉最上面那层浮层；没有浮层时取消选择' },
]

/** 手势说明。不是键盘事件，但用户要在同一张表里看到 */
export interface GestureSpec {
  label: string
  hint: string
}

export const GESTURES: GestureSpec[] = [
  { label: '⌘/Ctrl + V', hint: '粘贴。系统剪贴板里有图就先导入，没有才粘复制的节点' },
  { label: '空白处拖动', hint: '平移画布' },
  { label: '按住空格 + 拖动', hint: '在节点上也能平移，画布铺满时不用先找空白处' },
  { label: '滚轮', hint: '以光标为锚缩放；在图片预览里则缩放图片' },
  { label: '⌘/Ctrl + 拖动', hint: '框选节点（智能画布）' },
  { label: '框选时按住 Alt', hint: '只选完全框住的，默认是碰到就选' },
  { label: 'Shift + 拖动', hint: '划过连线即切断，松键退出（智能画布）' },
  { label: '拖动节点靠近邻居', hint: '出现参考线并轻微吸附：边对边、中线对中线' },
  { label: 'Shift + 点击节点', hint: '加进选区' },
  { label: '⌘/Ctrl + 点击节点', hint: '已选中的从选区里摘掉，没选中的加进来' },
  { label: 'Alt + 拖动节点', hint: '拖出一个副本' },
  { label: 'Alt + Shift + 拖动节点', hint: '拖出副本并保留输入连线' },
  { label: '点击连线', hint: '选中它，再按 Delete 断开；⌘/Ctrl 点可多选几条' },
  { label: '双击空白', hint: '打开创建菜单' },
  { label: '右键空白', hint: '同双击' },
  { label: '双击节点', hint: '打开预览/编辑' },
  { label: '右键节点', hint: '打开节点菜单' },
  { label: '右键连线', hint: '改语义、反转方向、断开' },
  { label: '从端口拖到空白', hint: '松手弹出「能接什么」的菜单' },
]

/** 当前是不是 mac。导出而不是各处再写一遍：
 *  平台判断写第三份的时候，三份的正则迟早不一样。 */
export const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)

/** 修饰键的显示名。mac 是 ⌘，其它是 Ctrl */
export const MOD_LABEL = IS_MAC ? '⌘' : 'Ctrl'

/** 一条快捷键渲染成给人看的字符串，例如 "⌘ + Shift + Z" */
export function shortcutLabel(spec: ShortcutSpec): string {
  const parts: string[] = []
  if (spec.mod === true) parts.push(MOD_LABEL)
  if (spec.shift === true) parts.push('Shift')
  if (spec.alt === true) parts.push(IS_MAC ? '⌥' : 'Alt')
  const key = spec.key.length === 1 ? spec.key.toUpperCase() : spec.key
  parts.push(key)
  return parts.join(' + ')
}

/** 焦点在这上面时，页面级快捷键要让路。
 *
 *  **按 role 判，不能只按标签判**：原生 `<select>` 换成 Radix 之后触发器是
 *  `<button role="combobox">`，`tag === 'SELECT'` 再也匹配不到——
 *  于是选完质量、焦点留在下拉上，按 Delete 会直接删掉正在编的节点。
 *  这个回归不报错，只是"忽然删错了东西"。
 *
 *  role 是这些部件对外的契约，换实现库也不会变；标签只是当下的实现。 */
const FOCUS_ROLES = new Set([
  'combobox', // Select / 下拉触发器
  'listbox',
  'option',
  'menu',
  'menuitem',
  'menuitemradio',
  'menuitemcheckbox',
  'spinbutton',
])

/** 焦点是不是落在「该由它自己吃键」的部件上。
 *
 *  **导出是有意的**：空格平移（`useSpaceHeld`）自己挂 window 监听，
 *  不走这张键位表，但让路的口径必须和这里一模一样。各写一份的结果是
 *  下拉框开着按空格没选中选项、画布反而进了平移待命态——两边都不报错。 */
export function isEditable(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  if (el === null) return false
  const tag = el.tagName
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true
  if (el.isContentEditable) return true
  const role = el.getAttribute?.('role') ?? ''
  if (FOCUS_ROLES.has(role)) return true
  // 弹层内容是 portal 出去的，焦点可能落在里面的任意一层
  return typeof el.closest === 'function' && el.closest('[role="menu"], [role="listbox"]') !== null
}

function matches(e: KeyboardEvent, spec: ShortcutSpec): boolean {
  const mod = IS_MAC ? e.metaKey : e.ctrlKey
  /* mac 上 Ctrl 与 ⌘ 是两回事：⌘+C 复制、Ctrl+C 在终端里是中断。
     只认 mod 对应的那个键，另一个按下时不匹配。 */
  const otherMod = IS_MAC ? e.ctrlKey : e.metaKey
  if (otherMod) return false
  if ((spec.mod === true) !== mod) return false
  if ((spec.shift === true) !== e.shiftKey) return false
  if ((spec.alt === true) !== e.altKey) return false
  const key = e.key
  if (spec.key.length === 1) return key.toLowerCase() === spec.key.toLowerCase()
  return key === spec.key
}

export type ShortcutHandlers = Partial<Record<ShortcutAction, () => void>>

/** 把键位表绑到 window 上。`enabled` 关掉时整个不生效（例如画布还没加载完）。 */
export function useCanvasShortcuts(handlers: ShortcutHandlers, enabled = true): void {
  /* handlers 每次渲染都是新对象，直接进依赖会每帧重绑。
     用 ref 存最新的一份，effect 只在 enabled 变化时跑。 */
  const ref = useMemo(() => ({ current: handlers }), [])
  ref.current = handlers

  useEffect(() => {
    if (!enabled) return
    const onKeyDown = (e: KeyboardEvent): void => {
      const editable = isEditable(e.target)
      for (const spec of SHORTCUTS) {
        if (editable && spec.allowInInput !== true) continue
        if (!matches(e, spec)) continue
        const fn = ref.current[spec.action]
        if (fn === undefined) continue
        /* 只有真的接了处理器才 preventDefault：
           没接的键要让浏览器原生行为继续（⌘+A 在页面上选文字之类） */
        e.preventDefault()
        e.stopPropagation()
        fn()
        return
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [enabled, ref])
}

/** 帮助面板要的分组视图。按用途分组，不按字母排 */
export function shortcutGroups(): { title: string; items: ShortcutSpec[] }[] {
  const pick = (...actions: ShortcutAction[]): ShortcutSpec[] =>
    actions
      .flatMap((a) => SHORTCUTS.filter((s) => s.action === a && s.hidden !== true))
      .filter((s, i, arr) => arr.indexOf(s) === i)
  return [
    { title: '编辑', items: pick('undo', 'redo', 'copy', 'paste', 'cut', 'duplicate', 'delete') },
    { title: '选择与整理', items: pick('selectAll', 'group', 'ungroup') },
    { title: '视图', items: pick('fitView', 'fitSelection', 'toggleOverview', 'zoomIn', 'zoomOut', 'resetZoom', 'toggleAssets') },
    { title: '运行', items: pick('run', 'stop') },
    { title: '其它操作', items: pick('save', 'nudge') },
    { title: '其它', items: pick('help', 'escape') },
  ]
}
