import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Overlay } from '../../components/Overlay'
import { apiDeck, apiScene } from '../../lib/api-deck'
import type { DeckGroup } from '../../lib/api-deck'
import { stopTts } from '../../lib/audio'
import { usePrefStore } from '../../lib/prefStore'
import { DEFAULT_GROUP_SIZE, emptyProgress, firstTryStats, nextKind, pickNext, splitGroups, wordPassed } from './grouping'
import type { GroupItem, WordProgress } from './grouping'
import { GateStage, QuizStage, RecallStage } from './QuizStages'
import { SceneGrid, sceneTotals } from './SceneGrid'
import { WHOLE_DECK_SCENE } from './shared'
import { loadDrillWords, recordAnswer, restoreDrill, restoreDrillSubmission, startGroup } from './drillSession'
import type { DrillState } from './drillSession'
import { useDrillKeys } from './useDrillKeys'
import './groupDrill.css'

interface GroupDrillPaneProps {
  deckKey: string
  deckName: string
  scene: string | null
  onScene: (scene: string | null) => void
  onExit: () => void
}

export function GroupDrillPane(props: GroupDrillPaneProps) {
  const { deckKey, scene, onExit } = props
  const scenesQuery = useQuery({ queryKey: ['drill-scenes', deckKey], queryFn: () => apiDeck.words(deckKey, { limit: 1 }) })
  const scenes = scenesQuery.data?.groups ?? []
  const sceneGroup = scene !== null && scene !== WHOLE_DECK_SCENE ? scene : null
  const query = useQuery({
    queryKey: ['group-drill-complete', deckKey, scene],
    queryFn: () => loadDrillWords(offset => apiDeck.words(deckKey, { offset, limit: 500, ...(sceneGroup ? { group: sceneGroup } : {}) })),
    enabled: scene !== null || (scenesQuery.isSuccess && scenes.length === 0),
  })
  const groups = useMemo(() => splitGroups((query.data?.items ?? []).filter(w => w.translation?.trim()).map(w => ({
    word: w.word, translation: w.translation, phonetic: w.phonetic, vocabId: w.vocab_id,
    exampleEn: w.example_en, exampleZh: w.example_zh,
  })), DEFAULT_GROUP_SIZE), [query.data])
  const failed = scenesQuery.error ?? query.error
  if (failed) return <div className="state-block" role="alert"><p>读取速记失败：{failed.message}</p>
    <button className="btn btn-primary" onClick={() => { void scenesQuery.refetch(); if (query.isError) void query.refetch() }}>重试</button>
    <button className="btn btn-outline" onClick={onExit}>返回单词本</button></div>
  if (scenesQuery.isPending) return <div className="state-block">正在读取场景…</div>
  if (scene === null && scenes.length > 0) return <ScenePicker {...props} scenes={scenes} total={scenesQuery.data?.total ?? 0} />
  if (query.isPending) return <div className="state-block">正在准备完整词表与分组…</div>
  if (!groups.length) return <div className="state-block"><p>没有带释义的可练习单词</p><button className="btn btn-outline" onClick={onExit}>返回单词本</button></div>
  return <DrillSession key={deckKey + ':' + scene} {...props} groups={groups} />
}

function DrillSession({ deckKey, deckName, scene, groups: originalGroups, onScene, onExit }: GroupDrillPaneProps & { groups: GroupItem[][] }) {
  const qc = useQueryClient()
  const allItems = useMemo(() => originalGroups.flat(), [originalGroups])
  const signature = JSON.stringify(originalGroups.map(g => g.map(w => w.word)))
  const storageKey = 'nexus:drill:v2:' + deckKey + ':' + (scene ?? WHOLE_DECK_SCENE)
  const [initial] = useState(() => {
    try {
      const raw = localStorage.getItem(storageKey)
      const savedWords: unknown = raw ? JSON.parse(raw)?.retryWords : null
      const retryWords: string[] | null = Array.isArray(savedWords) && savedWords.length > 0 &&
        savedWords.every(word => typeof word === 'string' && allItems.some(item => item.word === word)) ? savedWords : null
      const savedGroups = retryWords ? splitGroups(allItems.filter(w => retryWords.includes(w.word)), DEFAULT_GROUP_SIZE) : originalGroups
      const saved = restoreDrill(raw, signature, savedGroups)
      const protocol = raw ? JSON.parse(raw)?.protocol : null
      const pending = saved && typeof protocol?.runId === 'string'
        ? restoreDrillSubmission(JSON.parse(raw!)?.pending, protocol.runId, saved.groupIdx, (savedGroups[saved.groupIdx] ?? []).map(w => w.word)) : null
      return { saved, retryWords: saved ? retryWords : null, protocol: saved ? protocol : null,
        pending,
        error: raw && !saved ? '词表或断点格式已变化，本次从第一组开始。' : '' }
    } catch {
      return { saved: null, retryWords: null, protocol: null, pending: null, error: '本机记录无法读取，本次从第一组开始。' }
    }
  })
  const [retryWords, setRetryWords] = useState<string[] | null>(initial.retryWords)
  const groups = useMemo(() => retryWords ? splitGroups(allItems.filter(w => retryWords.includes(w.word)), DEFAULT_GROUP_SIZE) : originalGroups, [originalGroups, allItems, retryWords])
  const [state, setState] = useState<DrillState>(() => initial.saved ?? startGroup())
  const [paused, setPaused] = useState(Boolean(initial.saved && initial.saved.groupIdx < groups.length))
  const [panel, setPanel] = useState<'keys' | 'options' | null>(null)
  const [storageError, setStorageError] = useState(initial.error)
  const [history, setHistory] = useState<DrillState[]>([])
  const [revision, setRevision] = useState(0)
  const saving = useRef(false)
  const [protocol, setProtocol] = useState<{ runId: string; version: number | null }>(() => ({
    runId: initial.protocol?.runId ?? crypto.randomUUID(), version: initial.protocol?.version ?? null,
  }))
  const pendingSubmit = useRef(initial.pending)
  const opts = usePrefStore(s => s.prefs.drill)
  const setPrefs = usePrefStore(s => s.update)
  const group = groups[state.groupIdx] ?? []
  const progress = new Map<string, WordProgress>(group.map(w => [w.word, state.progress[w.word] ?? emptyProgress()]))
  const current = state.phase === 'recall' ? group[state.recallIdx] : pickNext(group.filter(w => (state.progress[w.word]?.seen ?? 0) < (state.round + 1) * 9), progress, state.recent)
  const finished = state.groupIdx >= groups.length
  const atGate = state.phase === 'gate' || (state.phase !== 'recall' && current === null)
  const passed = group.filter(w => wordPassed(progress.get(w.word) ?? emptyProgress()))
  const sceneGroup = scene !== null && scene !== WHOLE_DECK_SCENE ? scene : null

  function persist(nextState = state, nextProtocol = protocol) {
    localStorage.setItem(storageKey, JSON.stringify({ version: 2, signature, state: nextState, retryWords, protocol: nextProtocol,
      pending: pendingSubmit.current, totalGroups: groups.length, updatedAt: new Date().toISOString(), deckName }))
  }
  useEffect(() => {
    try {
      persist()
      setStorageError('')
    } catch { setStorageError('本机进度未保存，离开或刷新可能丢失本组进度。') }
  }, [state, storageKey, signature, retryWords, protocol, deckName, groups.length])
  useEffect(() => () => stopTts(), [])
  const save = useMutation({
    mutationFn: async () => {
      const target = sceneGroup ?? WHOLE_DECK_SCENE
      const stats = firstTryStats(progress)
      if (!pendingSubmit.current) {
        const version = protocol.version ?? (await apiScene.quizState(deckKey, target)).version
        pendingSubmit.current = { passed: passed.map(w => w.word), first_try_ok: stats.ok,
          first_try_total: stats.total, cursor: state.groupIdx + 1,
          submission_id: `${protocol.runId}:${state.groupIdx}`, run_id: protocol.runId, version }
      }
      persist(state, { ...protocol, version: pendingSubmit.current.version! })
      const result = await apiScene.submitQuiz(deckKey, target, pendingSubmit.current)
      return result.version
    },
    onSuccess: (version) => {
      pendingSubmit.current = null
      const pending = group.filter(w => !wordPassed(progress.get(w.word) ?? emptyProgress())).map(w => w.word)
      const struggling = [...new Set([...state.struggling.filter(w => !passed.some(p => p.word === w)), ...pending])]
      const nextState = startGroup(state.groupIdx + 1, struggling)
      const nextProtocol = { ...protocol, version }
      try { persist(nextState, nextProtocol) }
      catch { setStorageError('本组已保存到服务端，本机断点未同步，刷新后可重试读取回执。') }
      setProtocol(nextProtocol)
      setState(nextState)
      setHistory([])
      for (const key of ['drill-scenes', 'deck-scenes', 'deck-words', 'deck-words-all', 'scene-quiz']) void qc.invalidateQueries({ queryKey: [key, deckKey] })
    },
    onSettled: () => { saving.current = false },
  })
  const nextGroup = () => { if (saving.current) return; saving.current = true; save.mutate() }
  const change = (next: DrillState) => { if (pendingSubmit.current) return; setHistory(h => [...h.slice(-29), state]); setState(next); save.reset() }
  const undo = () => {
    const previous = history.at(-1)
    if (!previous || save.isPending || pendingSubmit.current) return
    setState(previous); setHistory(h => h.slice(0, -1)); setRevision(r => r + 1); save.reset(); stopTts()
  }
  const pause = () => { stopTts(); setPaused(true) }
  const togglePause = () => paused ? setPaused(false) : pause()
  useDrillKeys({ u: !paused && history.length ? undo : undefined, p: togglePause, '?': () => setPanel('keys') }, !finished && !save.isPending)
  const exit = () => { stopTts(); onExit() }
  const openPanel = (value: 'keys' | 'options') => { stopTts(); setPanel(value) }
  const retry = () => change({ ...state, phase: 'recap', round: state.round + 1 })
  const startRetry = () => {
    setProtocol(p => ({ ...p, runId: crypto.randomUUID() }))
    setRetryWords(state.struggling); setState(startGroup(0, state.struggling)); setHistory([]); save.reset()
  }

  return <div className="drill-workspace">
    <header className="drill-header"><div><strong>{retryWords ? '待巩固词' : sceneGroup ?? '整本速记'} · {deckName}</strong>
      <p>{finished ? '本轮完成' : '第 ' + (state.groupIdx + 1) + ' / ' + groups.length + ' 组'} · {groups.flat().length.toLocaleString()} 词
        {storageError ? '' : ' · 进度保存在本机'}</p></div>
      <div className="drill-tools"><button className="btn btn-outline" onClick={() => openPanel('keys')}>快捷键 <kbd>?</kbd></button>
        <button className="btn btn-outline" onClick={() => openPanel('options')}>选项</button>
        {!finished && <button className="btn btn-outline" onClick={togglePause} disabled={save.isPending}>{paused ? '继续' : '暂停'} <kbd>P</kbd></button>}
        <button className="btn btn-outline" onClick={exit} disabled={save.isPending}>退出</button></div></header>
    {storageError && <p className="drill-notice" role="alert">{storageError}</p>}
    {initial.error && initial.error !== storageError && <p className="drill-notice" role="status">{initial.error}</p>}
    {save.isError && <div className="drill-notice" role="alert">保存失败：{save.error.message}。本组结果仍保留。
      <button className="btn btn-outline" onClick={nextGroup}>重试保存</button></div>}
    {initial.pending && !save.isError && state.groupIdx === initial.saved?.groupIdx && <div className="drill-notice" role="status">本组有待确认的提交，确认结果后再继续。
      <button className="btn btn-primary" disabled={save.isPending} onClick={nextGroup}>恢复提交</button></div>}
    {finished ? <div className="drill-content"><section className="drill-question">
      <h2>本轮速记完成</h2><p>完成 {groups.length} 组 · {state.struggling.length} 词待巩固</p>
      {state.struggling.length > 0 && <><p className="drill-word-list">{state.struggling.join(' · ')}</p>
        <button className="btn btn-primary" onClick={startRetry}>重练待巩固词</button></>}
      <div className="drill-tools"><button className="btn btn-outline" onClick={() => onScene(null)}>选择场景</button><button className="btn btn-outline" onClick={exit}>返回单词本</button>
        <button className="btn btn-outline" onClick={() => { setProtocol(p => ({ ...p, runId: crypto.randomUUID() })); setRetryWords(null); setState(startGroup()); setHistory([]) }}>再练整轮</button></div>
    </section></div> : <>
      <nav className="drill-phases" aria-label="练习阶段"><span aria-current={state.phase === 'recall' ? 'step' : undefined}>认词回想</span>
        <span aria-current={state.phase !== 'recall' && !atGate ? 'step' : undefined}>独立自测</span><span aria-current={atGate ? 'step' : undefined}>本组结果</span>
        <progress aria-label="小组完成进度" max={groups.length} value={state.groupIdx} /></nav>
      <div className="drill-content"><main className="drill-main">
        <div hidden={paused}>
        {!atGate && current && (state.phase === 'recall' ? <RecallStage key={current.word + ':' + revision + ':' + opts.dir} item={current} index={state.recallIdx} total={group.length}
          opts={opts} active={!paused && panel === null} onGrade={grade => change({ ...state,
            progress: { ...state.progress, [current.word]: { ...(state.progress[current.word] ?? emptyProgress()), known: grade === 'known', weak: grade === 'unknown' } },
            recallIdx: state.recallIdx + 1 < group.length ? state.recallIdx + 1 : 0,
            phase: state.recallIdx + 1 < group.length ? 'recall' : 'drill' })} />
          : <QuizStage key={current.word + ':' + (state.progress[current.word]?.seen ?? 0) + ':' + revision} item={current}
            group={allItems} kind={nextKind(state.progress[current.word] ?? emptyProgress())} active={!paused && panel === null}
            onAnswer={(kind, ok) => change({ ...state, progress: { ...state.progress, [current.word]: recordAnswer(state.progress[current.word] ?? emptyProgress(), kind, ok) },
              recent: [...state.recent, current.word].slice(-4) })} />)}
        {atGate && <GateStage passed={passed.length === group.length} round={state.round} busy={save.isPending || paused}
          onNext={nextGroup} onGiveUp={nextGroup} onRetry={retry} />}
        </div>
        {paused && <section className="drill-question"><h2>练习已暂停</h2><p>回到刚才的进度，继续当前小组。</p><button className="btn btn-primary" onClick={() => setPaused(false)}>继续练习</button></section>}
      </main><aside className="drill-rail" aria-label="本组进度"><h3>本组进度 <span>{passed.length} / {group.length}</span></h3>
        <p className="gdr-muted">独立答对并完成拼写后通过</p>
        <ol>{group.map((w, index) => { const p = progress.get(w.word) ?? emptyProgress(); return <li key={w.word} aria-current={current?.word === w.word ? 'true' : undefined}>
          <span>{state.phase === 'recall' && index < state.recallIdx || wordPassed(p) ? w.word : '单词 ' + (index + 1)}</span>
          <small>{wordPassed(p) ? '已通过' : current?.word === w.word ? '当前' : p.seen ? '待巩固' : state.phase === 'recall' && index < state.recallIdx ? '已认词' : '待练'}</small></li> })}</ol>
        <button className="btn btn-outline" disabled={!history.length || save.isPending || paused} onClick={undo}>撤销上一操作 <kbd>U</kbd></button>
        <p className="gdr-muted">可撤销本组最近 30 次操作；已保存的小组不会被撤回。</p>
        {!atGate && state.phase !== 'recall' && <button className="btn btn-outline" disabled={paused} onClick={() => change({ ...state, phase: 'gate' })}>结束本组自测</button>}
      </aside></div>
      <footer className="drill-footer"><span><kbd>空格</kbd> 看 / 藏答案</span><span><kbd>1–4</kbd> 作答</span><span><kbd>Enter</kbd> 确认前进</span><span><kbd>R</kbd> 朗读</span><span><kbd>U</kbd> 撤销</span><span><kbd>P</kbd> 暂停</span></footer>
    </>}
    {panel && <Overlay onClose={() => setPanel(null)} labelledBy="drill-panel-title" card="drill-panel-card">
      <div className="drill-panel"><h2 id="drill-panel-title">{panel === 'keys' ? '速记快捷键' : '练习选项'}</h2>
        {panel === 'keys' ? <><dl>{[['空格', '反复显示 / 隐藏答案，不提交作答'], ['1 / 2 / 3', '认词：不会 / 模糊 / 认识'], ['1–4', '自测：选择对应答案'], ['Enter', '拼写核对；反馈后继续；本组通过后保存'], ['R', '朗读；答案侧发音计为提示'], ['U', '撤销本组上一操作'], ['P', '暂停当前练习'], ['?', '打开快捷键说明'], ['Esc', '关闭选项或快捷键说明']].map(([key, label]) => <div key={key}><dt><kbd>{key}</kbd></dt><dd>{label}</dd></div>)}</dl>
          <p>输入框、输入法组合和弹窗内不会触发页面快捷键。长按不会连续作答。拼写输入框中用 Enter 核对，空格正常输入。</p></>
          : <><h3>认词方向</h3><div className="drill-tools">{([['en2zh', '看英文'], ['zh2en', '看中文'], ['mix', '混合']] as const).map(([dir, label]) =>
            <button key={dir} className={opts.dir === dir ? 'btn btn-primary' : 'btn btn-outline'} aria-pressed={opts.dir === dir} onClick={() => setPrefs({ drill: { dir } })}>{label}</button>)}</div>
            {([['showPhonetic', '显示音标'], ['showExample', '核对时显示例句'], ['autoSpeak', '认词时自动朗读英文']] as const).map(([key, label]) =>
              <label className="drill-setting" key={key}><input type="checkbox" checked={opts[key]} onChange={e => setPrefs({ drill: { [key]: e.target.checked } })} />{label}</label>)}
            <p>自测不会提前自动播放答案。专项速记不改变正式复习的间隔安排。</p></>}
        <button className="btn btn-primary" onClick={() => setPanel(null)}>关闭</button>
      </div></Overlay>}
  </div>
}

function ScenePicker({ deckName, scenes, total, onScene, onExit }: GroupDrillPaneProps & { scenes: DeckGroup[]; total: number }) {
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState('all')
  const { passed, doneScenes } = sceneTotals(scenes)
  const shown = scenes.filter(s => (s.label + s.key).toLowerCase().includes(search.trim().toLowerCase()) &&
    (filter === 'all' || (filter === 'done' ? (s.passed ?? 0) >= s.count : (s.passed ?? 0) < s.count)))
  return <div className="drill-workspace drill-picker">
    <header className="drill-header"><div><h2>选一组，开始速记</h2><p>{deckName} · {doneScenes} / {scenes.length} 个场景通过 · {passed.toLocaleString()} 词通过自测</p></div>
      <button className="btn btn-outline" onClick={onExit}>返回单词本</button></header>
    <div className="drill-picker-scroll"><section className="drill-start"><div><h3>按场景记忆，或从整本开始</h3>
      <p>每组最多 7 词。先回想，再核对；不熟的词会再次出现。可以随时暂停，回来接着练。</p>
      <span><kbd>空格</kbd> 看 / 藏答案　<kbd>1–3</kbd> 自评　<kbd>R</kbd> 朗读</span></div>
      <button className="btn btn-primary" onClick={() => onScene(WHOLE_DECK_SCENE)}>整本速记 · {total.toLocaleString()} 词</button></section>
      <div className="drill-filter"><input className="input" aria-label="搜索速记场景" placeholder="搜索场景或主题" value={search} onChange={e => setSearch(e.target.value)} />
        <div className="seg">{[['all', '全部'], ['pending', '未完成'], ['done', '已通过']].map(([key, label]) => <button key={key} className={filter === key ? 'active' : undefined} aria-pressed={filter === key} onClick={() => setFilter(key)}>{label}</button>)}</div>
        <span>{shown.length} 个场景</span></div>
      {shown.length ? <SceneGrid scenes={shown} onPick={onScene} /> : <div className="state-block"><p>没有匹配的场景</p><button className="btn btn-outline" onClick={() => { setSearch(''); setFilter('all') }}>清除筛选</button></div>}
    </div>
  </div>
}
