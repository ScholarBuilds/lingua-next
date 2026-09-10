import { Component } from 'react'
import type { ReactNode } from 'react'

export class ModuleBoundary extends Component<{ children: ReactNode; name: string }, { failed: boolean }> {
  state = { failed: false }

  static getDerivedStateFromError() { return { failed: true } }

  render() {
    if (this.state.failed) return <div className="state-block" role="alert">
      <p>{this.props.name}暂时无法加载</p>
      <button className="btn btn-outline" onClick={() => window.location.reload()}>重新加载</button>
    </div>
    return this.props.children
  }
}
