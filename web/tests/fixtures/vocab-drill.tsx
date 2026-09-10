import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { GroupDrillPane } from '../../src/features/vocab/GroupDrillPane'
import { apiDeck, apiScene } from '../../src/lib/api-deck'
import type { DeckItem } from '../../src/lib/api-deck'
import { usePrefStore } from '../../src/lib/prefStore'
import '../../src/styles/app.css'
import '../../src/features/vocab/deck.css'

document.documentElement.dataset.theme = new URLSearchParams(location.search).has('dark') ? 'dark' : 'light'
const words: DeckItem[] = [
  { word: 'apple', translation: '苹果' },
  { word: 'dictionary', translation: '词典' },
].map(word => ({
  ...word, phonetic: null, vocab_id: null, definition: null, frq: null, freq_band: null,
  tags: [], collins: null, exchange: null, status: 'new', bucket: 'new', difficult: false,
  mark: null, due_at: null, group_key: 'test', dict_miss: false,
  example_en: 'An example sentence.', example_zh: '一个例句。',
}))
apiDeck.words = async (_key, query) => ({
  items: words.slice(query?.offset ?? 0, (query?.offset ?? 0) + (query?.limit ?? 500)),
  total: words.length, groups: [{ key: 'test', label: '测试场景', count: 2, passed: 0 }],
})
let fail = true
let submits = 0
apiScene.submitQuiz = async (_key, scene, body) => {
  submits += 1
  document.getElementById('evidence')!.textContent = JSON.stringify({ submits, body })
  if (fail) {
    fail = false
    throw new Error('模拟保存失败')
  }
  return { scene, total: 2, passed: body.passed.length, all_passed: body.passed.length === 2,
    cursor: body.cursor, attempts: submits, first_try_ok: body.first_try_ok, first_try_total: body.first_try_total }
}
usePrefStore.setState(s => ({ prefs: { ...s.prefs, drill: { ...s.prefs.drill, autoSpeak: false } } }))
const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
function Fixture() {
  const [scene, setScene] = useState<string | null>('test')
  return <QueryClientProvider client={client}>
    <div style={{ height: '100dvh', display: 'flex', flexDirection: 'column' }}>
      <div id="evidence">尚未提交</div>
      <GroupDrillPane deckKey="drill-ui-fixture" deckName="键盘验收" scene={scene} onScene={setScene} onExit={() => setScene(null)} />
    </div>
  </QueryClientProvider>
}
createRoot(document.getElementById('root')!).render(<Fixture />)
