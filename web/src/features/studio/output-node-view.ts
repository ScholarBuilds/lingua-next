/* 输出节点 / 历史节点的「标题条上写什么」判据（模块 17 · FR-461/FR-463）。
 *
   这里只有纯函数、只有 `import type`，运行期不依赖任何模块：
   `CanvasNodes.tsx` 拖着 konva、api-studio 这一串重依赖，判据留在里面就没法单测
   （仓里已有同款教训，见 image-math.ts）。

   要解决的是一个具体的困惑：点「出图（分支）」之后画布上冒出一个陌生的框，
   顶着「输出 · 1 项结果」两个标签，而下面就一张图。
   「输出」没说清它从哪来，「1 项结果」重复了眼睛已经看到的事实。
   判据因此收成两条：

   1. **重复即删**：只有一张图时不写产物摘要，多于一张、或产物不是图片才写；
   2. **陌生就命名**：节点自己没有标题时，沿 flow 入边回溯一跳，写「分支自 <源节点>」。 */

import type { CanvasItem, CanvasConnection } from '../../lib/api-studio'

/** 判据只用得到这几个字段。收窄入参是为了让测试不必造整个 ScvNode */
export interface NodeBrief {
  id: string
  type?: string
  title?: string
  items?: CanvasItem[]
  history_for?: string
}

/** 标题条的两格内容。整个返回 null = 这条标题条不该存在 */
export interface NodeCaption {
  /** 左边那格：节点叫什么 */
  text: string
  /** 右边那格：产物摘要。null = 没有值得说的 */
  detail: string | null
}

const KIND_UNIT: Record<CanvasItem['kind'], string> = {
  image: '张图',
  video: '条视频',
  audio: '条音频',
  file: '个文件',
}

const KIND_SINGULAR: Record<CanvasItem['kind'], string> = {
  image: '图片',
  video: '视频',
  audio: '音频',
  file: '文件',
}

/** 产物摘要：**只在有东西要说的时候**返回文字。
 *
 *  单张图返回 null 是这条判据的全部意义——图就在下面摆着，
 *  再写一句「1 项结果」是把一整条标题栏花在一个显而易见的事实上。
 *  非图片产物要说：视频/音频折叠成播放器、文件折叠成一行链接，
 *  缩远了看不出它是什么。 */
export function outputSummary(items: CanvasItem[] | undefined): string | null {
  const list = items ?? []
  if (list.length === 0) return null
  const kinds = new Set(list.map((item) => item.kind))
  if (kinds.size > 1) return `${list.length} 项产物`
  const [kind] = [...kinds]
  if (kind === undefined) return null
  if (list.length === 1) return kind === 'image' ? null : KIND_SINGULAR[kind]
  return `${list.length} ${KIND_UNIT[kind]}`
}

/** 节点在画布上显示的名字。与图片节点标题栏同一套回落顺序：
 *  标题 > 首个产物的文件名 > null（叫不出名字就别硬编一个「节点」） */
export function nodeDisplayName(node: NodeBrief | undefined): string | null {
  if (node === undefined) return null
  const title = (node.title ?? '').trim()
  if (title !== '') return title
  const name = (node.items ?? []).find((item) => (item.name ?? '') !== '')?.name
  return name === undefined || name === '' ? null : name
}

/** 沿 flow 入边回溯一跳，找这个节点是谁分出来的。
 *
 *  只认 flow：`input`（参考图）和 `history`（旧图归档）表达的不是生成血缘，
 *  把它们也算进来的话，一个接了三张参考图的输出会指向随便哪一张。 */
export function branchOriginId(
  connections: CanvasConnection[],
  nodeId: string,
): string | null {
  const edge = connections.find(
    (connection) => connection.to === nodeId && (connection.kind ?? 'flow') === 'flow',
  )
  return edge?.from ?? null
}

/** 输出节点标题条的内容。返回 null = 整条不渲染。
 *
 *  没标题又找不到源头的孤立输出节点就什么都不写：那时它和一张裸图没有区别，
 *  给它安一个「输出」只是让画布上多一行没有信息的字。 */
export function outputCaption(
  node: NodeBrief,
  nodes: NodeBrief[],
  connections: CanvasConnection[],
): NodeCaption | null {
  const detail = outputSummary(node.items)
  const own = (node.title ?? '').trim()
  if (own !== '') return { text: own, detail }
  const originId = branchOriginId(connections, node.id)
  const origin = nodes.find((candidate) => candidate.id === originId)
  const name = nodeDisplayName(origin)
  if (name !== null) return { text: `分支自 ${name}`, detail }
  if (originId !== null) return { text: '分支输出', detail }
  return detail === null ? null : { text: '输出', detail }
}

/** 历史节点归档的是谁的旧图。
 *
 *  两条线索都认：`history_for` 字段是主，`history` 入边是备。
 *  字段是后加的，早期画布（以及 Infinite-Canvas 导入的）只有那条边；
 *  只认字段的话那些画布上的历史节点会退化成一张没头没尾的淡图。 */
export function historyOwnerId(
  node: NodeBrief,
  connections: CanvasConnection[],
): string | null {
  const own = (node.history_for ?? '').trim()
  if (own !== '') return own
  const edge = connections.find(
    (connection) => connection.to === node.id && connection.kind === 'history',
  )
  return edge?.from ?? null
}

/** 这个节点是不是历史节点。字段或入边有一条成立就算 */
export function isHistoryNode(node: NodeBrief, connections: CanvasConnection[]): boolean {
  return historyOwnerId(node, connections) !== null
}

/** 历史节点标题条上的字。
 *
 *  写「历史」两个字说不清「旧图去哪了」——用户看到的是自己刚才那张图忽然
 *  变淡挪到了下面，得先认出这是**谁**的旧图才连得上。
 *  存的标题就是建节点时写死的「历史」，与派生文案同义，直接让位；
 *  用户手动改过名的（title 不是「历史」）以用户的为准。 */
export function historyTitle(
  node: NodeBrief,
  nodes: NodeBrief[],
  connections: CanvasConnection[],
): string {
  const own = (node.title ?? '').trim()
  if (own !== '' && own !== '历史') return own
  const owner = nodes.find((candidate) => candidate.id === historyOwnerId(node, connections))
  const name = nodeDisplayName(owner)
  return name === null ? '旧图存档' : `${name} 的旧图`
}
