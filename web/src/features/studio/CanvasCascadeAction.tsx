/* F058：所有可执行节点共用同一套「运行整条链 / 停止运行」入口。
 *
 * 蓝本只在链尾显示级联按钮；Lingua 的执行器支持更多节点类型，所以入口也必须跟着
 * 覆盖 image / video / ModelScope / Midjourney / LLM / ComfyUI / RunningHub，不能只让
 * 图片节点看得见。 */

import { useMemo } from 'react'

import { CASCADE_CONFIRM_GENS, cascadeChain, cascadePlan, runCascade, useCanvasStore } from './canvasStore'

export function CanvasCascadeAction({
  nodeId,
  disabled = false,
  showPlan = false,
  className = 'btn btn-outline btn-sm',
}: {
  nodeId: string
  disabled?: boolean
  showPlan?: boolean
  className?: string
}): JSX.Element | null {
  const nodes = useCanvasStore((state) => state.nodes)
  const connections = useCanvasStore((state) => state.connections)
  const cascade = useCanvasStore((state) => state.cascade)
  const stopCascade = useCanvasStore((state) => state.stopCascade)
  const plan = useMemo(
    () => cascadePlan(nodes, connections, nodeId),
    [connections, nodeId, nodes],
  )
  const activeHere = useMemo(() => {
    if (cascade === null) return false
    if (cascade.startId === nodeId || cascade.loopId === nodeId) return true
    return cascadeChain(nodes, connections, cascade.startId).order.includes(nodeId)
  }, [cascade, connections, nodeId, nodes])

  if (!plan.canRun) return null
  const stopping = activeHere && cascade?.stopRequested === true
  /* 节点自己的任务态会把 disabled 置上；但若它正属于这次级联，停止按钮必须仍可点。 */
  const blocked = stopping || (cascade !== null && !activeHere) || (disabled && !activeHere)

  return (
    <>
      {showPlan && (
        <span
          className={`scv-plan${plan.needsConfirm ? ' scv-plan-over' : ''}`}
          title={
            plan.needsConfirm
              ? `超过 ${CASCADE_CONFIRM_GENS} 次模型调用，点运行时会先要一次确认（不会拦住）`
              : '级联只沿 input（参考输入）边走，所以这个数跑几次都一样'
          }
        >
          链上 {plan.executableNodes} 执行节点 × {plan.rounds} 轮 = {plan.gens} 次调用
        </span>
      )}
      <button
        type="button"
        className={className}
        disabled={blocked}
        title={
          activeHere
            ? '当前任务收尾后停止，已经生成的结果会保留'
            : '从这个链尾沿 input 边回溯，从链头逐节点运行；上游产物会成为下游输入'
        }
        onClick={() => {
          if (activeHere) stopCascade()
          else void runCascade(nodeId)
        }}
      >
        {activeHere ? (stopping ? '停止中…' : '停止运行') : '运行整条链'}
      </button>
    </>
  )
}
