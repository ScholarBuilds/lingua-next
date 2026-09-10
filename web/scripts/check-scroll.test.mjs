/* 滚动链路守卫自己的单测。

   守卫本身就是判据：喂一段「祖先链缺 min-height:0」的源码它必须报错，
   补上那一行必须转绿。没有这组用例的话，守卫悄悄退化成永远通过也没人知道。 */

import { describe, expect, it } from 'vitest'

import { audit } from './check-scroll.mjs'

/** 外壳：`.app` 高度确定，`.main` 是列向 flex。与 tokens.css / app.css 同构。 */
const SHELL_CSS = `
.app { display: flex; height: 100dvh; overflow: hidden; }
.main { flex: 1; display: flex; flex-direction: column; min-width: 0; }
.page { flex: 1; min-width: 0; min-height: 0; overflow-y: auto; }
`

const run = (css, tsx) =>
  audit({
    css: [{ name: 'shell.css', text: SHELL_CSS }, { name: 'x.css', text: css }],
    tsx: [{ name: 'X.tsx', text: tsx }],
  }).results

const find = (results, cls) => results.find((r) => r.el.classes.includes(cls))

describe('滚动链路守卫', () => {
  it('列向 flex 里的中间层缺 min-height:0 时报错，并指名是哪一层', () => {
    const css = `
      .shell { display: flex; flex-direction: column; height: 600px; }
      .mid { flex: 1; display: flex; flex-direction: column; }
      .list { flex: 1; overflow-y: auto; }
    `
    const tsx = `
      export const X = () => (
        <div className="shell">
          <div className="mid">
            <div className="list">长列表</div>
          </div>
        </div>
      )
    `
    const hit = find(run(css, tsx), 'list')
    expect(hit.verdict).toBe('broken')
    // 撑破链路的是 .mid，不是滚动容器自己
    expect(hit.offenders).toHaveLength(1)
    expect(hit.offenders[0].el.classes).toContain('mid')
    expect(hit.offenders[0].axis).toBe('y')
  })

  it('给那一层补上 min-height:0 之后转绿', () => {
    const css = `
      .shell { display: flex; flex-direction: column; height: 600px; }
      .mid { flex: 1; min-height: 0; display: flex; flex-direction: column; }
      .list { flex: 1; overflow-y: auto; }
    `
    const tsx = `
      export const X = () => (
        <div className="shell">
          <div className="mid">
            <div className="list">长列表</div>
          </div>
        </div>
      )
    `
    expect(find(run(css, tsx), 'list').verdict).toBe('ok')
  })

  it('滚动容器自己不需要 min-height:0（overflow 非 visible 时自动最小尺寸就是 0）', () => {
    const css = `
      .shell { display: flex; flex-direction: column; height: 600px; }
      .list { flex: 1; overflow-y: auto; }
    `
    const tsx = `
      export const X = () => (
        <div className="shell"><div className="list">长列表</div></div>
      )
    `
    // 这条是规范细节。判错的话全仓上百个正常滚动容器会一起变红。
    expect(find(run(css, tsx), 'list').verdict).toBe('ok')
  })

  it('自带 max-height 的滚动容器不依赖祖先链', () => {
    const css = `
      .shell { display: flex; flex-direction: column; }
      .list { max-height: 320px; overflow-y: auto; }
    `
    const tsx = `
      export const X = () => (
        <div className="shell"><div className="list">长列表</div></div>
      )
    `
    expect(find(run(css, tsx), 'list').verdict).toBe('ok')
  })

  it('接得上 App 外壳：页面根出了文件也能一路判到 .app', () => {
    const css = `
      .demo-page { display: flex; flex-direction: column; overflow: hidden; }
      .demo-mid { flex: 1; display: flex; flex-direction: column; }
      .demo-list { flex: 1; overflow-y: auto; }
    `
    const tsx = `
      export const X = () => (
        <main className="page demo-page">
          <div className="demo-mid"><div className="demo-list">长列表</div></div>
        </main>
      )
    `
    /* 页面根的父级在 App 外壳里（另一个文件）。接不上外壳的话这里只能记
       unresolved，「整页滚不动」这一类就永远查不出来。 */
    const hit = find(run(css, tsx), 'demo-list')
    expect(hit.verdict).toBe('broken')
    expect(hit.offenders[0].el.classes).toContain('demo-mid')
  })

  it('页面根自己就在滚时，内层滚动容器只记 unresolved（嵌套滚动静态判不了）', () => {
    const css = `
      .demo-mid { flex: 1; display: flex; flex-direction: column; }
      .demo-list { flex: 1; overflow-y: auto; }
    `
    const tsx = `
      export const X = () => (
        <main className="page demo">
          <div className="demo-mid"><div className="demo-list">长列表</div></div>
        </main>
      )
    `
    // .page 带 overflow-y:auto，内层还要不要滚取决于运行时高度，不下判定
    expect(find(run(css, tsx), 'demo-list').verdict).toBe('unresolved')
  })

  it('className 指向变量时能解析出字面量，不当成「没有样式」', () => {
    const css = `
      .shell { display: flex; flex-direction: column; height: 600px; }
      .mid { flex: 1; min-height: 0; display: flex; flex-direction: column; }
      .list { flex: 1; overflow-y: auto; }
    `
    const tsx = `
      export const X = ({ open }: { open: boolean }) => {
        const midClass = \`mid\${open ? '' : ' collapsed'}\`
        return (
          <div className="shell">
            <div className={midClass}><div className="list">长列表</div></div>
          </div>
        )
      }
    `
    // 解析不出 .mid 的话会误报「缺 min-height:0」——生图控制台真踩过
    expect(find(run(css, tsx), 'list').verdict).toBe('ok')
  })

  it('overflow 简写会重置 overflow-y 长写，页面不再被误判成还在滚', () => {
    const css = `
      .demo-page { display: flex; overflow: hidden; }
      .demo-side { flex: 0 0 200px; overflow-y: auto; }
    `
    const tsx = `
      export const X = () => (
        <main className="page demo-page"><aside className="demo-side">侧栏</aside></main>
      )
    `
    // .page 带 overflow-y:auto，.demo-page 的 overflow:hidden 要能盖住它
    const hit = find(run(css, tsx), 'demo-side')
    expect(hit.verdict).toBe('ok')
  })

  it('祖先是组件时不下判定（它渲染出什么 DOM 看不见，可能还是 portal）', () => {
    const css = `
      .shell { display: flex; flex-direction: column; height: 600px; }
      .list { flex: 1; overflow-y: auto; }
    `
    const tsx = `
      export const X = () => (
        <Overlay><div className="list">长列表</div></Overlay>
      )
    `
    expect(find(run(css, tsx), 'list').verdict).toBe('unresolved')
  })

  it('内联 style 的祖先不下判定（可能自己写了高度）', () => {
    const css = `
      .shell { display: flex; flex-direction: column; }
      .list { flex: 1; overflow-y: auto; }
    `
    const tsx = `
      export const X = () => (
        <div className="shell" style={{ height: 600 }}>
          <div className="list">长列表</div>
        </div>
      )
    `
    expect(find(run(css, tsx), 'list').verdict).toBe('unresolved')
  })
})
