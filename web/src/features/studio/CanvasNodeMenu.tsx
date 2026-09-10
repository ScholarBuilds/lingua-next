/* 画布上的三套上下文菜单（模块 17 · CR-005 §3.8 / 需求 §6.8）。
 *
   蓝本有五套彼此独立的菜单 DOM（`static/canvas.html` 的 `createMenu` /
   `linkCreateMenu` / `nodeInputMenu` / `nodeOutputMenu` / `imageNodeMenu`）。
   这里补齐蓝本有而我们缺的三套，全部走 `canvas-core/ContextMenu` 一个组件：

   - **节点菜单**：右键节点。编辑、送到别的工具、复制、删除
   - **连线菜单**：右键连线。改语义、断开
   - **端口菜单**：从端口拖到空白松手。只列能接上的节点类型

   创建菜单（双击/右键空白）仍是页面里那份 `CanvasCreateMenu`，样式不同暂不合并；
   但两处的候选类型、图标、措辞与默认值都取自同一份节点注册表（`nodes/`），
   不会再出现「端口菜单建出来 3 轮、创建菜单建出来 1 轮」这种对不上。

   说明只给**标签讲不清**的项。蓝本的菜单只有图标 + 两三个字，第一次用完全猜不出
   「循环节点」「Output」是干什么的，所以那些要配一句；但「预览」「复制」「删除」
   这种一看就懂的配上说明就是替用户读界面——工具自己人用几百次，
   第二次之后每一行多余的灰字都是要跳过的噪音。

   判据：这句话带了标签之外的**约束、代价或反预期**吗？
   带了才写（「细节增强」其实不放大像素、「执行流」不发参考图），否则留空。 */

import { useNavigate } from 'react-router-dom'
import { toast } from 'sonner'
import {
  Copy,
  CopyPlus,
  Crop,
  Download,
  Files,
  Focus,
  Globe,
  Grid3x3,
  Image as ImageIcon,
  Link2Off,
  Replace,
  Repeat2,
  Sparkles,
  Trash2,
} from '@/components/NexusIcon'

import { ContextMenu } from './canvas-core'
import type { MenuSection } from './canvas-core'
import { canConnect, wouldCreateCycle } from './canvas-core/layout'
import { NODE_DEFINITIONS, NODE_PORT_MATRIX, nodeDefaults, portMenuTypes } from './nodes'
import {
  connKey,
  copyNodes,
  duplicateNodes,
  newNodeId,
  outputToInputGroup,
  useCanvasStore,
} from './canvasStore'
import type { ScvNode } from './canvasStore'
import { apiStudio } from '../../lib/api-studio'
import type { CanvasConnection } from '../../lib/api-studio'
import { saveFile } from '@/lib/shell'

/** 画布编辑器的模式。与 `CanvasEditorResult['action']` 对齐 */
type EditorMode = 'crop' | 'mask' | 'outpaint' | 'split' | 'join' | 'resize' | 'annotate'

/* ==================== 节点菜单 ==================== */

export function CanvasNodeMenu({
  node,
  canvasTitle,
  at,
  onEdit,
  onPreview,
  onClose,
}: {
  node: ScvNode
  canvasTitle: string
  at: { x: number; y: number }
  onEdit: (id: string, mode: EditorMode) => void
  onPreview: (id: string) => void
  onClose: () => void
}): JSX.Element {
  const navigate = useNavigate()
  const firstAsset = (node.items ?? []).find((it) => it.asset_id !== undefined)?.asset_id
  const hasImage = (node.type === 'image' || node.type === 'output') && firstAsset !== undefined
  const outputImages = (node.items ?? []).filter((item) => item.kind === 'image')
  const outputAssetIds = outputImages.flatMap((item) =>
    item.asset_id === undefined ? [] : [item.asset_id],
  )

  /** 把这张图带去另一个工具。工具页从 query 里读 asset id 接着用 */
  const sendTo = (route: string, label: string): void => {
    if (firstAsset === undefined) return
    navigate(`${route}?asset=${firstAsset}`)
    toast.success(`已把这张图带到「${label}」`)
  }

  const nodeSection: MenuSection = {
    key: 'node',
    title: '这个节点',
    items: [
      {
        key: 'copy',
        label: '复制',
        icon: <Copy />,
        onSelect: () => {
          const n = copyNodes([node.id])
          if (n > 0) toast.success('已复制，⌘V 粘贴')
        },
      },
      {
        key: 'dup',
        label: '就地复制一份',
        icon: <Files />,
        onSelect: () => duplicateNodes([node.id]),
      },
      {
        key: 'del',
        label: '删除',
        icon: <Trash2 />,
        danger: true,
        onSelect: () => {
          const s = useCanvasStore.getState()
          s.snapshot()
          s.removeNodes([node.id])
        },
      },
    ],
  }

  const downloadOutput = async (): Promise<void> => {
    try {
      const result = await apiStudio.downloadOutputImages({
        asset_ids: outputAssetIds,
        filename: `${canvasTitle || 'canvas-output'}-${node.id}`,
      })
      saveFile(result.blob, result.filename)
      toast.success(`已打包 ${outputAssetIds.length} 张原图`)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '批量下载失败')
    }
  }

  const sections: MenuSection[] = node.type === 'output'
    ? [
        {
          key: 'output-group',
          title: '输出组操作',
          items: [
            {
              key: 'output-convert',
              label: '转换为输入组',
              icon: <Replace />,
              disabled: outputImages.length === 0,
              disabledReason: '这个输出节点里还没有图片',
              onSelect: () => {
                if (outputToInputGroup(node.id, 'convert') !== null) toast.success('已转换为输入组')
              },
            },
            {
              key: 'output-copy',
              label: '复制为输入组',
              icon: <CopyPlus />,
              disabled: outputImages.length === 0,
              disabledReason: '这个输出节点里还没有图片',
              onSelect: () => {
                if (outputToInputGroup(node.id, 'copy') !== null) toast.success('已复制为输入组')
              },
            },
          ],
        },
        {
          key: 'output-files',
          title: '输出文件',
          items: [
            {
              key: 'output-download',
              label: '下载全部图片',
              icon: <Download />,
              disabled: outputAssetIds.length === 0,
              disabledReason: '只能批量下载已入库的图片',
              onSelect: () => void downloadOutput(),
            },
          ],
        },
        nodeSection,
      ]
    : [
    {
      key: 'edit',
      title: '编辑这张图',
      items: hasImage
        ? [
            {
              key: 'preview',
              label: '预览',
              icon: <ImageIcon />,
              onSelect: () => onPreview(node.id),
            },
            {
              key: 'crop',
              label: '裁剪 / 画笔 / 遮罩…',
              icon: <Crop />,
              onSelect: () => onEdit(node.id, 'crop'),
            },
          ]
        : [
            {
              key: 'noimg',
              label: '编辑',
              hint: '',
              icon: <Crop />,
              disabled: true,
              disabledReason: '这个节点还没有图，先出一张或连上游',
              onSelect: () => undefined,
            },
          ],
    },
    {
      key: 'send',
      title: '带到别的工具',
      items: [
        {
          key: 'angle',
          label: '角度控制',
          icon: <Focus />,
          disabled: !hasImage,
          disabledReason: '需要一张已入库的图',
          onSelect: () => sendTo('/studio/angle', '角度控制'),
        },
        {
          key: 'enhance',
          label: '细节增强',
          // 「细节增强」这名字天然指向超分，而上游没有放大模型——这条是纠正预期，留
          hint: '重绘细节，不放大像素',
          icon: <Sparkles />,
          disabled: !hasImage,
          disabledReason: '需要一张已入库的图',
          onSelect: () => sendTo('/studio/enhance', '细节增强'),
        },
        {
          key: 'panorama',
          label: '全景预览',
          icon: <Globe />,
          disabled: !hasImage,
          disabledReason: '需要一张已入库的图',
          onSelect: () => sendTo('/studio/panorama', '全景预览'),
        },
        {
          key: 'grid',
          label: '宫格切拼',
          icon: <Grid3x3 />,
          disabled: !hasImage,
          disabledReason: '需要一张已入库的图',
          onSelect: () => sendTo('/studio/grid', '宫格切拼'),
        },
      ],
    },
    nodeSection,
  ]

  return <ContextMenu at={at} sections={sections} title={node.title ?? '节点'} onClose={onClose} width={268} />
}

/* ==================== 连线菜单 ==================== */

/* hint 渲染在 label 正下方，所以句首不能再把标签念一遍（原来三条都以
   「参考输入：」「执行流：」「历史归档：」开头，用户看到的是同一个词上下两行）。
   只留标签讲不清的那半句——选错线的后果是**图静默地多发或少发一张**，
   任务照跑、不报错、只有产物不对，这类才值得占一行。
   `input` 留空：它是这三档的默认含义，标签已经说完。 */
const KIND_HINT: Record<string, string> = {
  input: '',
  flow: '不发参考图',
  history: '既不发图，也不排先后',
}

export function CanvasEdgeMenu({
  conn,
  at,
  onClose,
}: {
  conn: CanvasConnection
  at: { x: number; y: number }
  onClose: () => void
}): JSX.Element {
  const kind = conn.kind ?? 'flow'
  /* 连线的 key 里含 kind（`from→to→kind`），所以改语义不是原地改字段，
     而是删掉旧的再加一条新的——直接改字段会让 key 和内容对不上，
     后续按 key 删就删不掉了。 */
  const change = (next: 'input' | 'flow' | 'history'): void => {
    const s = useCanvasStore.getState()
    s.snapshot()
    s.removeConnectionsByKey([connKey(conn)])
    s.addConnection({ from: conn.from, to: conn.to, kind: next })
  }

  /* 连反了是最常见的手滑：从 B 拖到 A 而不是 A 拖到 B。
     没有这一项就得先断开、再拖一次，而拖线本身是这套交互里最费准头的动作。 */
  const allNodes = useCanvasStore((s) => s.nodes)
  const allConnections = useCanvasStore((s) => s.connections)
  const from = allNodes.find((n) => n.id === conn.from)
  const to = allNodes.find((n) => n.id === conn.to)
  const ends = from === undefined || to === undefined
    ? null
    : {
        from: { id: from.id, type: from.type, history: from.history_for !== undefined },
        to: { id: to.id, type: to.type, history: to.history_for !== undefined },
      }
  /** 反过来接得上吗：端口矩阵点头，且反向之后不成环 */
  const reverseBlocked = ends === null
    ? '连线两端有一头已经不在画布上了'
    /* 归档边不给反转：它的方向本身就是语义（谁归档了谁），
       反过来会变成「历史分组产出了源节点」，端口矩阵还偏偏放行 history 边 */
    : kind === 'history'
      ? '历史归档是单向的记录关系，反过来没有意义'
      : !canConnect(ends.to, ends.from, kind, NODE_PORT_MATRIX)
      ? `「${to?.title ?? to?.type ?? '下游'}」送不出「${from?.title ?? from?.type ?? '上游'}」收得下的东西`
      : wouldCreateCycle(
            conn.to,
            conn.from,
            allConnections.filter((c) => connKey(c) !== connKey(conn)),
          )
        ? '反过来接会绕成一个环'
        : null

  const reverse = (): void => {
    const s = useCanvasStore.getState()
    s.snapshot()
    s.removeConnectionsByKey([connKey(conn)])
    s.addConnection({ from: conn.to, to: conn.from, kind })
  }

  const sections: MenuSection[] = [
    {
      key: 'kind',
      title: '这条线是什么关系',
      items: (['input', 'flow', 'history'] as const).map((k) => ({
        key: k,
        label: { input: '参考输入', flow: '执行流', history: '历史归档' }[k],
        hint: KIND_HINT[k],
        disabled: k === kind,
        disabledReason: '当前就是这个',
        onSelect: () => change(k),
      })),
    },
    {
      key: 'ops',
      items: [
        {
          key: 'reverse',
          label: '反转方向',
          icon: <Repeat2 />,
          disabled: reverseBlocked !== null,
          disabledReason: reverseBlocked ?? undefined,
          onSelect: reverse,
        },
        {
          key: 'cut',
          label: '断开',
          icon: <Link2Off />,
          danger: true,
          onSelect: () => {
            const s = useCanvasStore.getState()
            s.snapshot()
            s.removeConnectionsByKey([connKey(conn)])
          },
        },
      ],
    },
  ]

  return <ContextMenu at={at} sections={sections} title="连线" onClose={onClose} width={268} />
}

/* ==================== 端口拖到空白 ==================== */

/** 从某个端口拖到空白处松手时弹出来：**只列能接上的节点类型**。
 *
 *  蓝本这里也是按端口方向给不同的列表（nodeInputMenu / nodeOutputMenu）。
 *  列不能接的类型再让用户点了报错，是最没必要的挫败感。
 *
 *  候选由注册表的端口声明现算：从图片的 out 拖出来，只会列吃得下图片的类型；
 *  从循环的 out 拖出来，列的是能被轮次驱动的执行节点。原来是两份写死的清单，
 *  与来源类型无关——从提示词节点拖出来也会推荐"接一个提示词"。 */
export function CanvasPortMenu({
  fromId,
  side,
  world,
  at,
  onClose,
}: {
  fromId: string
  side: 'in' | 'out'
  world: { x: number; y: number }
  at: { x: number; y: number }
  onClose: () => void
}): JSX.Element {
  const source = useCanvasStore((state) => state.nodes.find((node) => node.id === fromId))

  const add = (patch: Omit<ScvNode, 'id' | 'x' | 'y'>): void => {
    const s = useCanvasStore.getState()
    s.snapshot()
    const id = newNodeId()
    // 落在松手的地方，左上角对齐指针稍微往左上挪一点，别正好压在指针底下
    s.addNode({ id, x: Math.round(world.x - 40), y: Math.round(world.y - 40), ...patch })
    // 从输出端口拖出来的，新节点在下游；从输入端口拖出来的，新节点在上游
    s.addConnection(side === 'out' ? { from: fromId, to: id, kind: 'input' } : { from: id, to: fromId, kind: 'input' })
  }

  const candidates = portMenuTypes(source?.type ?? 'image', side)
  const section: MenuSection = {
    key: side,
    title: side === 'out' ? '接一个下游节点' : '接一个上游节点',
    /* 一个候选都没有时给一条说明而不是一片空白：外壳上两个端口是无条件渲染的，
       提示词、音频这类节点的输入端口本来就没东西接得进来，空菜单看着像坏了 */
    items: candidates.length > 0
      ? candidates.map((type) => {
          const definition = NODE_DEFINITIONS[type]
          const Icon = definition.icon
          return {
            key: type,
            label: definition.label,
            hint: definition.hint,
            icon: <Icon />,
            onSelect: () => add(nodeDefaults(type)),
          }
        })
      : [{
          key: 'none',
          label: side === 'out' ? '没有能接下去的节点' : '没有能接进来的节点',
          disabled: true,
          disabledReason: `「${source?.title ?? source?.type ?? '这个节点'}」这一侧的端口没有可用的候选类型`,
          onSelect: () => undefined,
        }],
  }

  return (
    <ContextMenu
      at={at}
      sections={[section]}
      title={side === 'out' ? '这条线接到哪' : '什么接进来'}
      onClose={onClose}
      width={268}
    />
  )
}
