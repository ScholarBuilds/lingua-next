/* 浮层关闭即停朗读（FR-350、BR-78）。

   弹窗里点了句子或单词正在念，关掉浮层声音还在后台响——内容都看不见了还在念。

   注意 open 参数：像 WordModal 那样**常驻**、靠栈空时 `return null` 的组件永远不会卸载，
   只挂卸载清理等于没挂。传入打开态，由 true→false 的切换触发停声。
   条件渲染的弹窗（语法分析、跟读工作台、音色选择、全文）用默认值即可。 */

import { useEffect } from 'react'

import { stopTts } from './audio'

export function useStopTtsOnClose(open = true): void {
  useEffect(() => {
    if (!open) return
    return () => stopTts()
  }, [open])
}
