import { ApiImageError, apiImage } from './api-image'
import type { ImageAsset } from './api-image'
import { apiStudio } from './api-studio'

const POLL_MS = 2000
const POLL_MAX = 180

export interface ImageEditTaskContext {
  toolId: string
  sourceRoute: string
  sourceContext?: Record<string, unknown>
  /** 画布节点固定的真实模型；其他入口不传时仍跟随全局能力绑定。 */
  deploymentId?: number | null
}

function resultAssetIds(result: Record<string, unknown> | null): number[] {
  const raw = result?.asset_ids
  if (!Array.isArray(raw)) return []
  return raw.filter((value): value is number => typeof value === 'number')
}

/** 提交编辑并等待本次结果；超时只停止页面等待，后台任务不会被取消。 */
export async function runImageEditTask(
  form: FormData,
  context: ImageEditTaskContext,
  /** 任务一建好就回调，早于它跑完。
   *
   *  调用方拿这个 id 去登记「这个节点在跑」——否则用户在编辑器里点了重绘、
   *  关掉弹窗，画布上什么都看不见，图跑完也不会自己回来。 */
  onCreated?: (taskId: string) => void,
): Promise<ImageAsset[]> {
  form.set('tool_id', context.toolId)
  form.set('source_route', context.sourceRoute)
  if (context.deploymentId !== undefined && context.deploymentId !== null) {
    form.set('deployment_id', String(context.deploymentId))
  }
  if (context.sourceContext !== undefined) {
    form.set('source_context', JSON.stringify(context.sourceContext))
  }
  const created = await apiImage.createEditJob(form)
  onCreated?.(created.studio_task_id)
  for (let index = 0; index < POLL_MAX; index += 1) {
    const task = await apiStudio.task(created.studio_task_id)
    if (task.status === 'succeeded' || task.status === 'partial') {
      const ids = resultAssetIds(task.result)
      if (ids.length === 0) throw new ApiImageError(500, '编辑完成但没有返回图片资产')
      return Promise.all(ids.map((id) => apiImage.asset(id)))
    }
    if (task.status === 'failed' || task.status === 'cancelled') {
      throw new ApiImageError(500, task.error ?? '编辑任务失败')
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS))
  }
  throw new ApiImageError(0, '页面等待超时，任务仍在后台；可到任务中心查看结果')
}
