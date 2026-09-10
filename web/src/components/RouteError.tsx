import { Link, useRouteError } from 'react-router-dom'

export function RouteError() {
  const error = useRouteError()
  return <main className="page" aria-label="页面暂不可用">
    <div className="state-block" role="alert">
      <h1>这个页面暂时无法打开</h1>
      <p>请检查连接后重新加载，也可以返回今天继续使用其他模块。</p>
      {error instanceof Error && <details><summary>错误详情</summary><p>{error.message}</p></details>}
      <button className="btn btn-primary" onClick={() => window.location.reload()}>重新加载</button>
      <Link className="btn btn-outline" to="/">返回今天</Link>
    </div>
  </main>
}
