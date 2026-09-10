/* 删除墓碑：让合并远端文档时能区分「远端新建的、我没见过」与「我故意删掉的」。
 *
 *  **没有它就会删了又回来。** `mergeDocs` 里那句
 *  `for (const rn of remote.nodes) if (!seen.has(rn.id)) nodes.push(rn)`
 *  的本意是「另一个标签页新建的节点也要留下」，但它认的是「本地没有」——
 *  而用户刚删掉的节点恰好就是「本地没有」。于是删完只要来一帧远端变更
 *  （SSE canvas 帧、或保存撞 409 走合并），删掉的节点就原样复活。连线同理：
 *  `byKey` 取并集，删掉的边也会被带回来。
 *
 *  ## 什么时候该忘掉一条墓碑
 *
 *  不用 TTL 当主判据，用**保存被确认**：我们这次保存落库之后，服务端就已经
 *  同意那个节点没了，之后拉到的远端文档里本来就不会再有它，墓碑就没用了。
 *  这一点比 TTL 准——TTL 定短了删除仍会复活，定长了会压住另一个标签页
 *  **新建的同 id 节点**（虽然 id 是随机的，撞上概率低，但语义上不该压）。
 *
 *  清除按**时间点**而不是一次清空：保存在飞的这段时间里用户可能又删了几个，
 *  那几条墓碑不在这次提交的载荷里，一起清掉就等于把它们放走了。所以记下
 *  「这次保存取快照的时刻」，只清早于它的。
 *
 *  TTL 只当兜底：保存一直失败（离线、鉴权过期）时不让墓碑无限攒着。 */

/** 墓碑最长保留多久。只是兜底——正常路径靠保存确认来清。
 *  10 分钟足够覆盖一次离线重连，又不至于让一条陈年记录压住新节点。 */
export const TOMBSTONE_TTL_MS = 10 * 60 * 1000

export interface TombstoneStore {
  /** 节点 id → 记下的时刻 */
  nodes: Map<string, number>
  /** 连线 key → 记下的时刻 */
  edges: Map<string, number>
}

export function createTombstones(): TombstoneStore {
  return { nodes: new Map(), edges: new Map() }
}

/** 记下一批被删掉的节点。重复记同一个就刷新时刻——用户删了、撤销回来、又删一次，
 *  按最后那次算才对。 */
export function rememberNodes(store: TombstoneStore, ids: Iterable<string>, now: number): void {
  for (const id of ids) store.nodes.set(id, now)
}

export function rememberEdges(store: TombstoneStore, keys: Iterable<string>, now: number): void {
  for (const key of keys) store.edges.set(key, now)
}

/** 撤销把节点带回来了：墓碑要当场作废，否则下一次合并又把它删掉。 */
export function forgetNodes(store: TombstoneStore, ids: Iterable<string>): void {
  for (const id of ids) store.nodes.delete(id)
}

export function forgetEdges(store: TombstoneStore, keys: Iterable<string>): void {
  for (const key of keys) store.edges.delete(key)
}

/** 这个节点是不是被本地删掉过（且墓碑还没过期）。合并时用它挡住远端的复活。 */
export function isNodeBuried(store: TombstoneStore, id: string, now: number): boolean {
  const at = store.nodes.get(id)
  if (at === undefined) return false
  if (now - at > TOMBSTONE_TTL_MS) {
    store.nodes.delete(id)
    return false
  }
  return true
}

export function isEdgeBuried(store: TombstoneStore, key: string, now: number): boolean {
  const at = store.edges.get(key)
  if (at === undefined) return false
  if (now - at > TOMBSTONE_TTL_MS) {
    store.edges.delete(key)
    return false
  }
  return true
}

/** 保存落库之后清掉这次提交已经包含的那些墓碑。
 *
 *  `snapshotAt` 是**取保存载荷那一刻**的时间戳，不是收到响应的时刻：
 *  这中间用户可能又删了几个，那几条不在这次载荷里，清掉就等于放它们回来。 */
export function clearSettled(store: TombstoneStore, snapshotAt: number): void {
  for (const [id, at] of store.nodes) if (at <= snapshotAt) store.nodes.delete(id)
  for (const [key, at] of store.edges) if (at <= snapshotAt) store.edges.delete(key)
}

/** 换画布 / 重新加载时整个丢掉：墓碑只在一次会话内、对一张画布有意义。 */
export function clearAll(store: TombstoneStore): void {
  store.nodes.clear()
  store.edges.clear()
}

/** 过期清扫。合并路径每次会顺手清掉查到的过期项，这个用于定期整体收一次，
 *  免得删了很多又从没再合并过的 id 一直占着内存。 */
export function sweepExpired(store: TombstoneStore, now: number): number {
  let gone = 0
  for (const [id, at] of store.nodes) {
    if (now - at > TOMBSTONE_TTL_MS) {
      store.nodes.delete(id)
      gone += 1
    }
  }
  for (const [key, at] of store.edges) {
    if (now - at > TOMBSTONE_TTL_MS) {
      store.edges.delete(key)
      gone += 1
    }
  }
  return gone
}
