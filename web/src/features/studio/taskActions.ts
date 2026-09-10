import type { StudioTask } from '../../lib/api-studio'

export const TERMINAL_TASK_STATUSES = new Set(['succeeded', 'partial', 'failed', 'cancelled'])

/** 还没收口的状态都能请求取消；worker 在协作点看到取消标记后以 cancelled 终态收口。 */
export const CANCELLABLE_TASK_STATUSES = new Set(['queued', 'submitting', 'running', 'recovering'])

/** 统一执行器能从不可变 invocation 快照重新建任务的类型。 */
export function canRerunTask(task: Pick<StudioTask, 'status' | 'task_type'>): boolean {
  if (!TERMINAL_TASK_STATUSES.has(task.status)) return false
  return task.task_type === 'image.generate'
    || task.task_type === 'image.edit'
    || task.task_type === 'image.rerun'
    || task.task_type === 'video.generate'
    || task.task_type === 'midjourney.generate'
    || task.task_type === 'midjourney.action'
    || task.task_type.startsWith('workflow.')
}

export function canCancelTask(task: Pick<StudioTask, 'status'>): boolean {
  return CANCELLABLE_TASK_STATUSES.has(task.status)
}
