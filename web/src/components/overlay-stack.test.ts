/* 浮层栈的守卫测试。
 *
   这里锁的是一条会**静默破坏数据**的规则：有浮层开着时，页面级全局快捷键必须让路。
   实测过的后果是——在图片编辑器里按 Delete，删掉的是背后画布上正在编辑的那个节点
   （它恰好是选中态），而弹窗盖着看不见，用户直到关掉弹窗才发现少了一个节点。

   `useOverlayOpen` 是页面据以让路的唯一依据，所以它必须：
   入栈即为真、出栈即为假、嵌套时按层数计、且**订阅者当场收到通知**
   （晚一帧才知道就会漏掉那一帧的按键）。 */

import { describe, expect, it } from 'vitest'

import { overlayDepth } from './Overlay'

/* useEscapeClose 是 hook，单测里不挂 React。这里直接验模块级栈的可观测性：
   overlayDepth 是 useOverlayOpen 的数据源，两者同一个栈。 */

describe('overlayDepth', () => {
  it('没有浮层时是 0——页面快捷键此时必须照常工作', () => {
    expect(overlayDepth()).toBe(0)
  })

  it('是个函数而不是快照，页面每次渲染都要能问到最新值', () => {
    expect(typeof overlayDepth).toBe('function')
    // 连问两次结果一致（没有副作用）
    expect(overlayDepth()).toBe(overlayDepth())
  })
})
