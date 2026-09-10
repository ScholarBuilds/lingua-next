import { renderToString } from 'react-dom/server'
import { createMemoryRouter, Link, Outlet, RouterProvider } from 'react-router-dom'
import { expect, it } from 'vitest'
import { RouteError } from './RouteError'

it('failed lazy modules keep navigation and render recovery controls', async () => {
  const router = createMemoryRouter([{
    path: '/', element: <><nav><Link to="/">今天</Link></nav><Outlet /></>,
    children: [{ path: 'broken', errorElement: <RouteError />, hydrateFallbackElement: <p>正在加载页面…</p>, lazy: async () => { throw new Error('chunk unavailable') } }],
  }], { initialEntries: ['/broken'] })
  await new Promise<void>(resolve => {
    if (router.state.initialized) { resolve(); return }
    const unsubscribe = router.subscribe(state => { if (state.initialized) { unsubscribe(); resolve() } })
  })
  const html = renderToString(<RouterProvider router={router} />)
  expect(html).toContain('<nav>')
  expect(html).toContain('这个页面暂时无法打开')
  expect(html).toContain('重新加载')
  expect(html).toContain('返回今天')
  router.dispose()
})
