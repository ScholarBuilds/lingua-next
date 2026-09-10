/* 模型选择弹窗的纯逻辑：分组、排序、搜索。与渲染分开，能直接单测。 */

import type { ModelDeployment } from '@/lib/api-config'
import { NON_CHAT_VENDOR, type Vendor, compareModelName, vendorOf, vendorRank } from '@/lib/model-vendor'

/** 部署行。`ready`（adapter 有没有接线）只有 /config/bindings 的清单带，缺省当已接线：
 *  调用方各自的筛选函数多半已经把没接线的滤掉了，缺一位不该让弹窗误标一片「接线缺失」。 */
export type PickableDeployment = ModelDeployment & { ready?: boolean }

export interface ModelRow {
  deployment: PickableDeployment
  vendor: Vendor
  /** 这条模型来自哪个凭据（账号）。同一个模型可能在两个中转下都有 */
  account: string
}

export interface VendorGroup {
  vendor: Vendor
  rows: ModelRow[]
}

/** 全局默认能力名。和服务端 domain/credentials.DEFAULT_LLM_CAPABILITY 同值 */
export const DEFAULT_LLM_CAPABILITY = 'default-llm'

export function toRows(options: PickableDeployment[]): ModelRow[] {
  return options.map((deployment) => ({
    deployment,
    vendor: vendorOf(deployment.upstream_model_id),
    account: deployment.credential_name ?? `凭据 #${deployment.credential_id}`,
  }))
}

/** 按厂商分组，组内新版本在前。
 *
 *  排序判据不是「凭据名字母序」——那正是现在这个弹窗第一眼看到 `embedding-3` 的原因：
 *  组按凭据名排、组内按模型名字母排，于是「个人中转」的 `embedding-3` 稳坐第一，
 *  而它连对话都不能做。 */
export function groupByVendor(rows: ModelRow[]): VendorGroup[] {
  const groups = new Map<string, VendorGroup>()
  for (const row of rows) {
    let group = groups.get(row.vendor.key)
    if (group === undefined) {
      group = { vendor: row.vendor, rows: [] }
      groups.set(row.vendor.key, group)
    }
    group.rows.push(row)
  }
  for (const group of groups.values()) {
    group.rows.sort(
      (a, b) =>
        compareModelName(a.deployment.upstream_model_id, b.deployment.upstream_model_id) ||
        a.account.localeCompare(b.account),
    )
  }
  return [...groups.values()].sort(
    (a, b) => vendorRank(a.vendor.key) - vendorRank(b.vendor.key) || a.vendor.name.localeCompare(b.vendor.name),
  )
}

/** 搜索：模型真名、厂商中文名与 key、账号名都能命中，空格分词后全部命中才算。
 *
 *  刻意**不匹配部署 id**：现在的下拉把 `value` 设成 id 字符串交给 cmdk 做子串匹配，
 *  输入「46」会命中一条毫不相干的模型。 */
export function matchRow(row: ModelRow, query: string): boolean {
  const q = query.trim().toLowerCase()
  if (q === '') return true
  const hay = [
    row.deployment.upstream_model_id,
    row.deployment.display_name ?? '',
    row.vendor.name,
    row.vendor.key,
    row.account,
  ]
    .join(' ')
    .toLowerCase()
  return q.split(/\s+/).every((term) => hay.includes(term))
}

export function filterGroups(groups: VendorGroup[], query: string): VendorGroup[] {
  if (query.trim() === '') return groups
  const out: VendorGroup[] = []
  for (const group of groups) {
    const rows = group.rows.filter((row) => matchRow(row, query))
    if (rows.length > 0) out.push({ vendor: group.vendor, rows })
  }
  return out
}

/** 键盘上下键要走的扁平序列，与渲染顺序一致 */
export function flatten(groups: VendorGroup[]): ModelRow[] {
  return groups.flatMap((group) => group.rows)
}

/** 非对话模型默认折叠：它们在对话模型列表里出现本身就是噪音，但删掉又会让
 *  「我明明有这个部署」的人找不到。给一组、默认收起、要用能展开。 */
export function isNoiseGroup(group: VendorGroup): boolean {
  return group.vendor.key === NON_CHAT_VENDOR.key
}

/** 下一个高亮项的索引；空列表返回 -1，到头停住而不是绕回去（绕回去在长列表里会让人迷失） */
export function moveHighlight(current: number, delta: 1 | -1, total: number): number {
  if (total === 0) return -1
  if (current < 0) return delta === 1 ? 0 : total - 1
  return Math.min(total - 1, Math.max(0, current + delta))
}
