/* 「在跑」行的唯一来源：侧栏的任务面板、顶部布局的浮层、今天页三处都读它。
   折叠判据（image_gen 域的管线 run 是工坊任务的执行细节，只列一次）在
   taskQueries.dockRows，这里只把三份数据源接起来。 */

import { taskRow, flowRow, pipelineRows } from '../studio/taskQueries'
import type { DockRow } from '../studio/taskQueries'
import { useStudioToolCatalog } from '../studio/toolRegistry'
import { useTaskActivity } from '../studio/taskHistory'

export function useRunningRows(): DockRow[] {
  const activity = useTaskActivity()
  const toolCatalog = useStudioToolCatalog()
  const tools = new Map((toolCatalog.data?.tools ?? []).map((tool) => [tool.id, tool.label]))
  const rows = [
    ...(activity.data?.tasks ?? []).map(task => taskRow(task, tools.get(task.tool_id))),
    ...(activity.data?.flows ?? []).map(run => flowRow(run)),
    ...pipelineRows(activity.data?.pipeline ?? [], {}),
  ]
  return rows.map(row => ({ key: row.key, title: row.title, step: row.stage ?? row.statusLabel,
    progress: row.progress ?? 0, route: row.sourceRoute ?? '/tasks',
  }))
}
