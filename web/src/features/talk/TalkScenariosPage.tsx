import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useUrlParams, useUrlValue } from '@/lib/urlState'
import { useWorkspaceStore } from '@/lib/workspaceStore'

import {
  IconAlert,
  IconClock,
  IconEdit,
  IconPlus,
  IconTrash,
} from '../../components/icons'
import { Topbar } from '../../components/Topbar'
import { Overlay } from '../../components/Overlay'
import './talkScenarios.css'
import { PillPicker } from '../../components/ui/picker'
import { api } from '../../lib/api'
import { apiConfig } from '../../lib/api-config'
import type { TalkDifficulty, TalkScenario, TalkSessionItem } from '../../lib/api'
import { ScenarioEditor } from './ScenarioEditor'
import { VocabCoverArtwork } from '../vocab/VocabCover'

const SCENE_ART: Record<string, string> = {
  自由话题: '闲聊话题', 餐厅点餐: '餐厅点餐', 求职面试: '面试',
  日常寒暄: '问候寒暄', 购物退换: '超市购物', 工作会议: '编程通用',
}

const DIFFICULTIES: { key: TalkDifficulty; label: string }[] = [
  { key: 'easy', label: '简单' },
  { key: 'medium', label: '适中' },
  { key: 'hard', label: '挑战' },
]

const DIFF_KEY = 'ln-talk-difficulty'
const REALTIME_MODEL_KEY = 'ln-talk-realtime-deployment'


const MODE_KEY = 'ln-talk-mode'
type TalkMode = 'realtime' | 'text'
const MODES: { key: TalkMode; label: string; hint: string }[] = [
  { key: 'realtime', label: '实时对话', hint: '开麦直接说，AI 实时接话' },
  { key: 'text', label: '文字 / 录音', hint: '打字或录一段，可以慢慢想' },
]

function loadDifficulty(): TalkDifficulty {
  const v = localStorage.getItem(DIFF_KEY)
  return v === 'easy' || v === 'hard' ? v : 'medium'
}

function formatDate(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function ScenarioCard({ scenario, onPreview, onEdit, onDelete, favorite, onFavorite }: {
  scenario: TalkScenario
  onPreview: () => void
  onEdit?: () => void
  onDelete?: () => void
  favorite: boolean
  onFavorite: () => void
}) {
  return (
    <article className="talk-card">
      <button className="talk-card-hit" aria-label={`预览${scenario.title}`} onClick={onPreview}>
        <span className="talk-card-intro">
          {SCENE_ART[scenario.title] && <span className="talk-cover-frame"><VocabCoverArtwork deck={{ key: '', name: SCENE_ART[scenario.title] }} /></span>}
          <span className="talk-card-names">
            <span className="talk-card-head"><span className="talk-card-title">{scenario.title}</span><span className="talk-card-level">{scenario.level}</span></span>
            <span className="talk-card-en">{scenario.title_en}</span>
            <span className="talk-card-origin">{scenario.is_builtin ? '内置场景' : '自建场景'}</span>
          </span>
        </span>
        <span className="talk-card-goal">{scenario.goal}</span>
        <span className="talk-card-roles">你的角色：{scenario.role_user}</span>
        <span className="talk-card-preview">查看场景与关键句</span>
      </button>
      <div className="talk-card-footer">
        <button className="talk-favorite" aria-label={`${favorite ? '取消收藏' : '收藏'}${scenario.title}`} aria-pressed={favorite} onClick={onFavorite}>{favorite ? '已收藏' : '收藏场景'}</button>
        {onEdit && <button className="icon-btn" title="编辑场景" onClick={onEdit}><IconEdit /></button>}
        {onDelete && <button className="icon-btn" title="删除场景" onClick={onDelete}><IconTrash /></button>}
      </div>
    </article>
  )
}

function HistoryRow({ item, onOpen }: { item: TalkSessionItem; onOpen: () => void }) {
  return (
    <button className="hist-row" onClick={onOpen}>
      <span className={`chip${item.mode === 'realtime' ? ' accent' : ''}`}>
        {item.mode === 'realtime' ? '实时' : '文字'}
      </span>
      <b className="hist-title">{item.scenario_title ?? '自由话题'}</b>
      <span className="hist-meta">{item.turn_count} 回合</span>
      <span className="hist-meta">{formatDate(item.started_at)}</span>
      <span className={`chip ${item.ended_at ? 'ok' : 'warn'}`}>
        {item.ended_at ? '已结束' : '未结束'}
      </span>
    </button>
  )
}

export function TalkScenariosPage() {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [, patchParams] = useUrlParams()
  const [preview, setPreview] = useState<TalkScenario | null>(null)
  const [tab, setTab] = useUrlValue<string>('tab', 'scenes', ['scenes', 'history'])
  const [search, setSearch] = useUrlValue<string>('q', '')
  const [level, setLevel] = useUrlValue<string>('level', '')
  const [filter, setFilter] = useUrlValue<string>('filter', 'all', ['all', 'favorite', 'recent'])
  const favorites = useWorkspaceStore(s => s.records['talk:favorite-scenes']?.expanded)
  const recent = useWorkspaceStore(s => s.records['talk:recent-scenes']?.expanded)
  const [difficulty, setDifficulty] = useState<TalkDifficulty>(loadDifficulty)
  const [mode, setMode] = useState<TalkMode>(() =>
    localStorage.getItem(MODE_KEY) === 'text' ? 'text' : 'realtime',
  )
  const [realtimeDeployment, setRealtimeDeployment] = useState(
    () => localStorage.getItem(REALTIME_MODEL_KEY) ?? 'global',
  )
  // 编辑器：closed=关闭 / null=新建 / 场景对象=编辑
  const [editor, setEditor] = useState<TalkScenario | null | 'closed'>('closed')

  const scenariosQuery = useQuery({ queryKey: ['talk-scenarios'], queryFn: api.talkScenarios })
  const sessionsQuery = useQuery({ queryKey: ['talk-sessions'], queryFn: api.talkSessions })
  const deploymentsQuery = useQuery({
    queryKey: ['cfg-model-deployments', 'talk-realtime'],
    queryFn: () => apiConfig.modelDeployments({ media_type: 'audio', enabled: true }),
  })
  const realtimeDeployments = (deploymentsQuery.data ?? []).filter(
    (item) => item.adapter_type === 'volcengine',
  )

  const deleteMutation = useMutation({
    mutationFn: (key: string) => api.deleteTalkScenario(key),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ['talk-scenarios'] })
    },
  })

  const removeScenario = (s: TalkScenario) => {
    if (window.confirm(`删除场景「${s.title}」？已有的对话记录不受影响。`)) {
      deleteMutation.mutate(s.key)
    }
  }

  const pickDifficulty = (d: TalkDifficulty) => {
    setDifficulty(d)
    localStorage.setItem(DIFF_KEY, d)
  }

  const start = (mode: 'realtime' | 'text', key?: string) => {
    if (key) useWorkspaceStore.getState().put('talk', 'recent-scenes', { expanded: [key, ...(recent ?? []).filter(k => k !== key)].slice(0, 20) })
    const params = new URLSearchParams({ mode, difficulty })
    if (key) params.set('scenario', key)
    if (mode === 'realtime' && realtimeDeployment !== 'global') {
      params.set('deployment', realtimeDeployment)
    }
    navigate(`/talk/session?${params.toString()}`)
  }

  const scenarios = scenariosQuery.data?.filter(s => {
    const matches = `${s.title} ${s.title_en} ${s.goal} ${s.role_user} ${s.role_ai}`.toLowerCase().includes(search.trim().toLowerCase())
    return matches && (!level || s.level === level) && (filter === 'all' || (filter === 'favorite' ? favorites : recent)?.includes(s.key))
  }).sort((a, b) => filter === 'recent' ? (recent?.indexOf(a.key) ?? 0) - (recent?.indexOf(b.key) ?? 0) : 0)
  const sessions = sessionsQuery.data

  return (
    <div className="main talk-library">
      <Topbar title="对话"
        meta={scenariosQuery.data && <span className="chip">{scenariosQuery.data.length} 个场景</span>}
        actions={<button className="btn btn-outline" onClick={() => setEditor(null)}><IconPlus />新建场景</button>}
      />
      <div className="content">
        <div className="content-inner">
          <nav className="seg talk-section-tabs" aria-label="对话栏目">
            <button aria-pressed={tab === 'scenes'} className={tab === 'scenes' ? 'active' : ''} onClick={() => setTab('scenes')}>场景练习</button>
            <button aria-pressed={tab === 'history'} className={tab === 'history' ? 'active' : ''} onClick={() => setTab('history')}>练习记录</button>
          </nav>
          {tab === 'scenes' && <>
            <div className="talk-library-heading"><h2>今天想练什么？</h2><p>选一个生活场景练习表达，结束后回看对话、收藏实用句子。</p></div>
            <div className="talk-practice-settings" aria-label="练习设置">
            {mode === 'realtime' && <PillPicker
              label="实时模型"
              value={realtimeDeployment}
              disabled={deploymentsQuery.isPending || deploymentsQuery.isError}
              title={deploymentsQuery.isError ? deploymentsQuery.error.message : '选择实时语音模型'}
              options={[
                { value: 'global', label: '使用默认语音模型' },
                ...realtimeDeployments.map((item) => ({
                  value: String(item.id),
                  label: item.display_name ?? item.upstream_model_id,
                })),
              ]}
              onChange={(v) => {
                setRealtimeDeployment(v)
                localStorage.setItem(REALTIME_MODEL_KEY, v)
              }}
            />}
            <span className="talk-diff-label">方式</span>
            <div className="seg">
              {MODES.map((m) => (
                <button
                  key={m.key}
                  aria-pressed={mode === m.key}
                  className={mode === m.key ? 'active' : ''}
                  title={m.hint}
                  onClick={() => {
                    setMode(m.key)
                    localStorage.setItem(MODE_KEY, m.key)
                  }}
                >
                  {m.label}
                </button>
              ))}
            </div>
            <span className="talk-diff-label">难度</span>
            <div className="seg">
              {DIFFICULTIES.map((d) => (
                <button
                  key={d.key}
                  aria-pressed={difficulty === d.key}
                  className={difficulty === d.key ? 'active' : ''}
                  onClick={() => pickDifficulty(d.key)}
                >
                  {d.label}
                </button>
              ))}
            </div>
            </div>
            <div className="talk-free-start">
              <span className="talk-cover-frame"><VocabCoverArtwork deck={{ key: '', name: '闲聊话题' }} /></span>
              <div><h3>自由话题</h3><p>没有剧本，从今天的生活或兴趣爱好聊起。</p></div>
              <button className="btn btn-primary" onClick={() => start(mode)}>开始自由对话</button>
            </div>
          </>}
          {tab === 'scenes' && <section className="sec">
            <div className="talk-scene-filters">
              <input className="input" aria-label="搜索场景" placeholder="搜索场景、主题或目标" value={search} onChange={e => setSearch(e.target.value)} />
              <PillPicker label="等级" value={level} onChange={setLevel} options={[{ value: '', label: '全部等级' }, ...['A1', 'A2', 'B1', 'B2', 'C1', 'C2'].map(value => ({ value, label: value }))]} />
              <PillPicker label="场景范围" value={filter} onChange={setFilter} options={[{ value: 'all', label: '全部场景' }, { value: 'favorite', label: '已收藏' }, { value: 'recent', label: '最近使用' }]} />
              {(search || level || filter !== 'all') && <button className="btn-ghost-sm" onClick={() => patchParams({ q: null, level: null, filter: null })}>清除筛选</button>}
              {scenarios && <span className="talk-result-count" role="status">{scenarios.length} 个结果</span>}
            </div>
            {scenariosQuery.isPending && (
              <div className="talk-grid">
                {Array.from({ length: 6 }, (_, i) => (
                  <div key={i} className="skeleton" style={{ height: 180 }} />
                ))}
              </div>
            )}

            {scenariosQuery.isError && (
              <div className="state-block">
                <IconAlert />
                <div>场景加载失败，请确认服务端已启动</div>
                <button className="btn btn-outline" onClick={() => void scenariosQuery.refetch()}>
                  重试
                </button>
              </div>
            )}

            {scenarios && (
              <div className="talk-grid">
                {scenarios.map((s) => (
                  <ScenarioCard
                    key={s.key}
                    scenario={s}
                    onPreview={() => setPreview(s)}
                    favorite={favorites?.includes(s.key) ?? false}
                    onFavorite={() => useWorkspaceStore.getState().put('talk', 'favorite-scenes', { expanded: favorites?.includes(s.key) ? favorites.filter(k => k !== s.key) : [...(favorites ?? []), s.key] })}
                    onEdit={s.is_builtin === false ? () => setEditor(s) : undefined}
                    onDelete={s.is_builtin === false ? () => removeScenario(s) : undefined}
                  />
                ))}
                <button className="talk-add-card" onClick={() => setEditor(null)}>
                  <IconPlus />
                  <b>新建场景</b>
                  <span>手写剧本，或让 AI 按你的点子生成</span>
                </button>
              </div>
            )}

            {scenarios?.length === 0 && <div className="state-block"><h3>没有匹配的场景</h3><p>试试其他关键词或等级，也可以创建自己的场景。</p><button className="btn btn-outline" onClick={() => patchParams({ q: null, level: null, filter: null })}>查看全部场景</button></div>}
            {deleteMutation.isError && (
              <div className="panel-error" style={{ marginTop: 10 }}>
                删除失败：{deleteMutation.error.message}
              </div>
            )}
          </section>}

          {tab === 'history' && <section className="sec">
            <div className="sec-head">
              <IconClock style={{ width: 13, height: 13 }} />
              历史会话
            </div>

            {sessionsQuery.isPending && (
              <div className="hist-list">
                {Array.from({ length: 3 }, (_, i) => (
                  <div key={i} className="skeleton" style={{ height: 44 }} />
                ))}
              </div>
            )}

            {sessionsQuery.isError && (
              <div className="panel-error">历史会话加载失败 <button className="btn" onClick={() => void sessionsQuery.refetch()}>重试</button></div>
            )}

            {sessions && sessions.length === 0 && (
              <div className="state-block"><p>还没有对话记录，选一个场景开始吧</p><button className="btn btn-primary" onClick={() => setTab('scenes')}>选择场景</button></div>
            )}

            {sessions && sessions.length > 0 && (
              <div className="hist-list">
                {sessions.map((s) => (
                  <HistoryRow
                    key={s.id}
                    item={s}
                    onOpen={() => navigate(`/talk/session?id=${s.id}`)}
                  />
                ))}
              </div>
            )}
          </section>}
        </div>
      </div>

      {preview && <Overlay onClose={() => setPreview(null)} card="talk-scenario-preview" labelledBy="talk-preview-title">
        <div className="overlay-head"><h2 id="talk-preview-title">{preview.title}</h2><button className="btn" onClick={() => setPreview(null)}>关闭</button></div>
        <p className="muted">{preview.title_en} · {preview.level}</p>
        <h3>练习目标</h3><p>{preview.goal}</p>
        <dl><dt>你的角色</dt><dd>{preview.role_user}</dd><dt>对方角色</dt><dd>{preview.role_ai}</dd></dl>
        {preview.key_sentences.length > 0 && <><h3>可以用到的关键句</h3><ul>{preview.key_sentences.map(sentence => <li key={sentence.en}>{sentence.en}<small>{sentence.zh}</small></li>)}</ul></>}
        <div className="talk-preview-footer"><span>{MODES.find(item => item.key === mode)?.label} · {DIFFICULTIES.find(item => item.key === difficulty)?.label}</span><button className="btn btn-primary" onClick={() => start(mode, preview.key)}>开始练习</button></div>
      </Overlay>}
      {editor !== 'closed' && (
        <ScenarioEditor initial={editor} onClose={() => setEditor('closed')} />
      )}
    </div>
  )
}
