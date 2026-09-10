import { useQuery } from '@tanstack/react-query'

import { docsApi } from '@/lib/api-grammar-docs'
import { useWorkspaceStore } from '@/lib/workspaceStore'

interface Props {
  onOpen: (softwareId: string, document: string) => void
}

function assetPath(cover: string): string {
  return cover.replace(/^\.\//, '').replace(/^_assets\/screenshots\//, '')
}

export function SoftwareLibraryPicker({ onOpen }: Props) {
  const libraries = useQuery({ queryKey: ['glib-software-libraries'], queryFn: docsApi.softwareLibraries })
  const records = useWorkspaceStore(state => state.records)

  return (
    <div className="software-library-picker">
      <header>
        <p>软件英语</p>
        <h1>选择要学习的软件</h1>
        <p>每套教程都按真实界面编排。进入后可使用讲义目录、搜索、笔记、书签、朗读和统一词卡。</p>
      </header>
      {libraries.isLoading && <p className="glib-note">正在读取本机软件讲义…</p>}
      {libraries.isError && <p className="glib-note err">{libraries.error.message}</p>}
      <div className="software-library-grid">
        {(libraries.data?.items ?? []).map(item => {
          const prefix = `05.软件英语/${item.outline.split('/')[1]}/`
          const read = Object.entries(records).filter(([key, value]) => key.startsWith('grammar:lecture:') && key.includes(prefix) && value.selected === 'read').length
          const recent = localStorage.getItem(`glib:last-doc:software:${item.software_id}`)
          const cover = item.cover ? docsApi.softwareAssetUrl(item.software_id, assetPath(item.cover)) : ''
          return (
            <article className="software-library-card" key={item.software_id}>
              <button className="software-library-main" onClick={() => onOpen(item.software_id, item.outline)}>
                {cover ? <img src={cover} alt="" /> : <div className="software-library-cover">{item.software_name.slice(0, 1)}</div>}
                <span className="software-library-copy">
                  <b>{item.software_name}</b>
                  <small>{item.platform} · {item.version}</small>
                  <small>采集于 {item.captured_at}</small>
                </span>
              </button>
              <dl>
                <div><dt>教程</dt><dd>{item.documents} 篇</dd></div>
                <div><dt>截图</dt><dd>{item.screenshots} 张</dd></div>
                <div><dt>已读</dt><dd>{read} / {item.documents}</dd></div>
              </dl>
              <div className="software-library-progress"><i style={{ width: `${item.documents ? Math.min(100, read / item.documents * 100) : 0}%` }} /></div>
              <button className="btn btn-primary" onClick={() => onOpen(item.software_id, recent ?? item.outline)}>继续学习</button>
            </article>
          )
        })}
      </div>
      {!libraries.isLoading && libraries.data?.items.length === 0 && (
        <div className="software-library-empty"><h2>还没有可学习的软件教程</h2><p>通过校验并发布的本机 Markdown 软件讲义会显示在这里。</p></div>
      )}
    </div>
  )
}
