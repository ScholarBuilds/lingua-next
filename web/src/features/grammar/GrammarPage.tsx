import { useUrlParams, useUrlValue } from '@/lib/urlState'
import { GrammarLibrary } from './library/GrammarLibrary'
import { SoftwareLibraryPicker } from './library/SoftwareLibraryPicker'
import './grammar.css'

type Tab = 'column' | 'vocabulary' | 'patterns' | 'scenes' | 'software'

export function GrammarPage() {
  const [tab] = useUrlValue<Tab>('tab', 'column', ['column', 'vocabulary', 'patterns', 'scenes', 'software'])
  const [softwareId] = useUrlValue<string>('software', '')
  const [columnSlug] = useUrlValue<string>('concept', '')
  const [, patchUrl] = useUrlParams()
  const tabs = [
    { key: 'column', label: '英语基础语法', collection: 'grammar' },
    { key: 'vocabulary', label: '英语词汇', collection: 'vocabulary' },
    { key: 'patterns', label: '英语句型手册', collection: 'patterns' },
    { key: 'scenes', label: '英语场景', collection: 'scenes' },
    { key: 'software', label: '软件英语', collection: 'software' },
  ] as const
  const current = tabs.find(item => item.key === tab) ?? tabs[0]
  return (
    <main className="page grammar">
      <nav className="gr-tabs" aria-label="英语讲义分类">
        {tabs.map(item => <button key={item.key} className={tab === item.key ? 'on' : ''}
          aria-current={tab === item.key ? 'page' : undefined}
          onClick={() => {
            if (item.key === 'software') {
              patchUrl({ tab: 'software', software: '', doc: '', anchor: '', concept: '', point: '', analysis: '' })
            } else if (tab !== item.key) {
              patchUrl({ tab: item.key, software: '', doc: localStorage.getItem(`glib:last-doc:${item.collection}`) ?? '', anchor: '', concept: '', point: '', analysis: '' })
            }
          }}>
          {item.label}
        </button>)}
      </nav>
      <section className="grammar-tab-body library">
        {current.collection === 'software' && !softwareId ? (
          <SoftwareLibraryPicker onOpen={(software, doc) => patchUrl({ software, doc }, { push: true })} />
        ) : (
          <GrammarLibrary key={`${current.collection}:${softwareId}`} collection={current.collection}
            libraryId={current.collection === 'software' ? softwareId : undefined}
            onBackToLibraries={current.collection === 'software' ? () => patchUrl({ software: '', doc: '', anchor: '' }, { push: true }) : undefined}
            openSlug={current.collection === 'grammar' ? columnSlug || null : null} />
        )}
      </section>
    </main>
  )
}
