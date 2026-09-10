/* 全局即时提示（FR-357、BR-84）。

   原生 title 要悬停一两秒才浮出来，图标密集处等于没提示。
   产品里有 255 处 title、散在 70 个文件——逐个换成组件不现实，
   新写的代码也会忘。改成在 App 层做一次**事件委托**接管 title：
   现存的全部自动升级，以后照常写 title 即可，不必记新 API。

   接管手法：悬停时把 title 摘到 data-tip 上（原生提示就不会再弹），
   离开时原样放回去——DOM 上始终留着 title 给读屏与外部工具。 */

import { useEffect } from 'react'

const SHOW_AFTER_MS = 60
const EDGE = 8

export function useInstantTooltip(): void {
  useEffect(() => {
    const tip = document.createElement('div')
    tip.className = 'itip'
    tip.setAttribute('role', 'tooltip')
    document.body.appendChild(tip)

    let host: HTMLElement | null = null
    let timer = 0

    const hide = () => {
      window.clearTimeout(timer)
      tip.classList.remove('on')
      if (host !== null) {
        const saved = host.getAttribute('data-tip')
        if (saved !== null) {
          host.setAttribute('title', saved)
          host.removeAttribute('data-tip')
        }
        host = null
      }
    }

    const place = (el: HTMLElement) => {
      const r = el.getBoundingClientRect()
      const t = tip.getBoundingClientRect()
      // 默认贴上方，顶不下就翻到下方
      let top = r.top - t.height - 6
      let below = false
      if (top < EDGE) {
        top = r.bottom + 6
        below = true
      }
      const left = Math.min(
        Math.max(r.left + r.width / 2 - t.width / 2, EDGE),
        window.innerWidth - t.width - EDGE,
      )
      tip.style.top = `${top}px`
      tip.style.left = `${left}px`
      tip.classList.toggle('below', below)
    }

    const show = (el: HTMLElement) => {
      const text = el.getAttribute('title')
      if (text === null || text.trim() === '') return
      hide()
      host = el
      // 摘掉 title 才不会和原生提示打架，离开时放回
      el.setAttribute('data-tip', text)
      el.removeAttribute('title')
      tip.textContent = text
      tip.classList.add('on')
      place(el)
    }

    const onOver = (e: Event) => {
      const target = e.target
      if (!(target instanceof Element)) return
      const el = target.closest<HTMLElement>('[title]')
      if (el === null || el === host) return
      // 禁用的控件不给提示：它本来就不可操作
      if (el.matches(':disabled')) return
      window.clearTimeout(timer)
      timer = window.setTimeout(() => show(el), SHOW_AFTER_MS)
    }

    const onOut = (e: Event) => {
      const target = e.target
      if (!(target instanceof Element)) return
      if (host !== null && (target === host || target.contains(host))) hide()
      else if (target.closest('[data-tip]') !== null) hide()
    }

    document.addEventListener('mouseover', onOver, true)
    document.addEventListener('mouseout', onOut, true)
    document.addEventListener('focusin', onOver, true)
    document.addEventListener('focusout', onOut, true)
    // 一旦发生位移或交互就撤掉，别让提示悬在原地
    window.addEventListener('scroll', hide, true)
    document.addEventListener('mousedown', hide, true)
    document.addEventListener('keydown', hide, true)

    return () => {
      hide()
      document.removeEventListener('mouseover', onOver, true)
      document.removeEventListener('mouseout', onOut, true)
      document.removeEventListener('focusin', onOver, true)
      document.removeEventListener('focusout', onOut, true)
      window.removeEventListener('scroll', hide, true)
      document.removeEventListener('mousedown', hide, true)
      document.removeEventListener('keydown', hide, true)
      tip.remove()
    }
  }, [])
}
