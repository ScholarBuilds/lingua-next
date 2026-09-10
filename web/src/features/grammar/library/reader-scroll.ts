/** 只移动正文栏，避免 scrollIntoView 连带滚动工作台祖先容器。 */
export function scrollWithin(
  scroller: HTMLElement,
  target: HTMLElement,
  align: 'start' | 'center' = 'start',
): void {
  const box = target.getBoundingClientRect()
  const offset = align === 'center' ? Math.max(0, (scroller.clientHeight - box.height) / 2) : 16
  const top = scroller.scrollTop + box.top - scroller.getBoundingClientRect().top
    - scroller.clientTop - offset
  scroller.scrollTo({ top: Math.max(0, top), behavior: 'instant' })
}
