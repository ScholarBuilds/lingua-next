/* 节点产物渲染（需求 12 FR-247）：按节点类型渲染成人看的形态，不是 JSON dump。

   原来「产物」页签直接 JSON.stringify，那是开发者视角。用户要看的是
   「这一步生成了哪些词」，并且点词就能查它的词卡。 */

import { useState } from 'react'

import { Overlay } from '../../components/Overlay'

import { ImageArtifact } from './ImageArtifact'
import { IconChevronDown, IconClose, IconSpeaker } from '../../components/icons'
import { playTts } from '../../lib/audio'
import { useWordModalStore } from '../reader/wordModalStore'
import { useStopTtsOnClose } from '../../lib/useStopTtsOnClose'

const GROUP_LABEL: Record<string, string> = {
  core_noun: '核心名词',
  action: '常用动作',
  descriptor: '描述词',
  phrase: '高频短语',
  pattern: '句型',
}

interface WordItem {
  en: string
  zh: string
  group?: string
  dict_miss?: boolean
  reason?: string
}

/** 点词弹词卡：与阅读器、词库详情页用同一套弹层，查词体验全站一致 */
function useOpenWord(context: string) {
  const openWord = useWordModalStore((s) => s.openWord)
  return (word: string) => openWord(word, context)
}

function WordGrid({
  words,
  context,
  muted,
}: {
  words: WordItem[]
  context: string
  muted?: boolean
}) {
  const open = useOpenWord(context)
  if (words.length === 0) return <div className="av-none">没有词条</div>
  return (
    <div className="av-grid">
      {words.map((w) => (
        <button
          key={w.en}
          className={`av-word${muted ? ' muted' : ''}`}
          title={w.reason ?? '点击查看词卡'}
          onClick={() => open(w.en)}
        >
          <b>{w.en}</b>
          <span>{w.zh}</span>
          {w.dict_miss && <i className="av-flag">词典外</i>}
          {w.reason && <i className="av-flag err">{w.reason}</i>}
          <em
            className="av-say"
            title="朗读"
            onClick={(e) => {
              e.stopPropagation()
              playTts(w.en, 'word')
            }}
          >
            <IconSpeaker />
          </em>
        </button>
      ))}
    </div>
  )
}

function Grouped({ groups, context }: { groups: Record<string, WordItem[]>; context: string }) {
  const keys = Object.keys(GROUP_LABEL).filter((k) => (groups[k] ?? []).length > 0)
  return (
    <div className="av-sections">
      {keys.map((k) => (
        <section key={k}>
          <div className="av-sec-head">
            {GROUP_LABEL[k]}
            <span className="av-n">{groups[k].length}</span>
          </div>
          <WordGrid words={groups[k]} context={context} />
        </section>
      ))}
    </div>
  )
}

export function ArtifactView({
  step,
  payload,
  context,
  onUsePrompt,
}: {
  step: string
  payload: unknown
  context: string
  /** 生图节点专用：把产物里的提示词填进重跑表单，省得手抄（模块 16） */
  onUsePrompt?: (prompt: string) => void
}) {
  const [raw, setRaw] = useState(false)
  const [full, setFull] = useState(false)
  const body = renderBody(step, payload, context, onUsePrompt)
  const paras =
    step === 'passage'
      ? ((payload as { paragraphs?: unknown[] } | null)?.paragraphs ?? [])
      : []

  return (
    <div className="av">
      {body}
      {paras.length > 0 && (
        <button className="btn btn-soft" onClick={() => setFull(true)}>
          看全文（{paras.length} 段）
        </button>
      )}
      {full && (
        <FullPassage payload={payload} onClose={() => setFull(false)} />
      )}
      {/* 原始数据降为折叠项：排查时才需要，日常不该占版面 */}
      <button className="av-raw-toggle" onClick={() => setRaw((v) => !v)}>
        <IconChevronDown style={{ transform: raw ? 'none' : 'rotate(-90deg)' }} />
        原始数据
      </button>
      {raw && <pre className="av-raw">{JSON.stringify(payload, null, 2).slice(0, 6000)}</pre>}
    </div>
  )
}

function renderBody(
  step: string,
  payload: unknown,
  context: string,
  onUsePrompt?: (prompt: string) => void,
) {
  const data = payload as Record<string, unknown> | null
  if (data === null || typeof data !== 'object') {
    return <div className="av-none">该节点没有可展示的产物</div>
  }

  // 生图节点（模块 16 FR-413）：产物里只有资产 id，图片走 /api/images 发。
  // 图片字节绝不进 payload——它是 JSONB，且下面「原始数据」块按 6000 字符截断
  const assetIds = data.asset_ids
  if (Array.isArray(assetIds) && assetIds.length > 0) {
    return (
      <ImageArtifact
        ids={assetIds as number[]}
        applied={data.applied_asset_id as number | undefined}
        brief={data.brief as Record<string, unknown> | null}
        prompt={typeof data.prompt === 'string' ? data.prompt : undefined}
        onUsePrompt={onUsePrompt}
      />
    )
  }

  // 提示词节点：整段文本，塞进键值表会挤成一坨读不了（模块 16）
  if (typeof data.prompt === 'string' && data.prompt !== '') {
    return (
      <div className="av-img">
        <div className="av-kv-note">
          {String(data.style ?? '')} · {String(data.size ?? '')}
        </div>
        <pre className="av-prompt">{data.prompt as string}</pre>
      </div>
    )
  }

  if (step === 'normalize') {
    const d = data as {
      emoji?: string; title_zh?: string; title_en?: string
      cefr?: string; category?: string; description?: string; keywords?: string[]
    }
    return (
      <div className="av-scene">
        <div className="av-scene-top">
          <span className="av-emoji">{d.emoji ?? '📘'}</span>
          <div>
            <b>{d.title_zh}</b>
            <span className="av-en">{d.title_en}</span>
          </div>
        </div>
        {d.description && <div className="av-desc">{d.description}</div>}
        <div className="av-tags">
          {d.cefr && <span className="chip accent">{d.cefr}</span>}
          {d.category && <span className="chip">{d.category}</span>}
          {(d.keywords ?? []).map((k) => (
            <span key={k} className="chip">{k}</span>
          ))}
        </div>
      </div>
    )
  }

  if (step === 'generate') {
    const groups = data as unknown as Record<string, WordItem[]>
    const total = Object.values(groups).reduce((n, v) => n + (v?.length ?? 0), 0)
    return (
      <>
        <div className="av-summary">生成候选 {total} 词，点任一词查看词卡</div>
        <Grouped groups={groups} context={context} />
      </>
    )
  }

  if (step === 'verify' || step === 'refill') {
    const kept = (data.kept ?? data.words ?? []) as WordItem[]
    const dropped = (data.dropped ?? []) as WordItem[]
    return (
      <>
        <div className="av-summary">
          保留 {kept.length} 词{dropped.length > 0 ? ` · 剔除 ${dropped.length} 词` : ''}
        </div>
        <section>
          <div className="av-sec-head">保留<span className="av-n">{kept.length}</span></div>
          <WordGrid words={kept} context={context} />
        </section>
        {dropped.length > 0 && (
          <section>
            <div className="av-sec-head">
              剔除<span className="av-n">{dropped.length}</span>
              <span className="av-hint">本地词典未收录，默认不入库</span>
            </div>
            <WordGrid words={dropped} context={context} muted />
          </section>
        )}
      </>
    )
  }

  if (step === 'passage') {
    const d = data as {
      title?: string; title_en?: string; form?: string
      roles?: string[]; article_id?: number
      paragraphs?: Array<{ role?: string; en?: string; zh?: string }>
      coverage?: { covered?: string[]; missing?: string[]; rate?: number }
    }
    const cov = d.coverage ?? {}
    const covered = cov.covered ?? []
    const missing = cov.missing ?? []
    const paras = d.paragraphs ?? []
    return (
      <div className="av-passage">
        <div className="av-pg-head">
          <b>{d.title ?? '场景短文'}</b>
          <span className="chip accent">{d.form === 'dialogue' ? '对话' : '短文'}</span>
          {(d.roles ?? []).map((r) => (
            <span key={r} className="chip">{r}</span>
          ))}
        </div>
        {/* 决定要不要重新生成，看的就是这两个数：用了多少词、还差哪些 */}
        <div className="av-pg-cov">
          <div className="av-pg-bar">
            <i style={{ width: `${(cov.rate ?? 0) * 100}%` }} />
          </div>
          <span>
            用上 {covered.length}/{covered.length + missing.length} 词 · {paras.length} 段
          </span>
        </div>
        {missing.length > 0 && (
          <div className="av-pg-missing">
            没用上：{missing.slice(0, 10).join('、')}
            {missing.length > 10 && ` 等 ${missing.length} 个`}
          </div>
        )}
        <div className="av-pg-body">
          {paras.slice(0, 4).map((p, i) => (
            <div key={i} className="av-pg-para">
              {p.role && <b>{p.role}</b>}
              <p>{p.en}</p>
              {p.zh && <span>{p.zh}</span>}
            </div>
          ))}
          {paras.length > 4 && (
            <div className="av-pg-more">下面还有 {paras.length - 4} 段，展开看全文 ↓</div>
          )}
        </div>
      </div>
    )
  }

  if (step === 'examples') {
    const entries = Object.entries(data as Record<string, { en?: string; zh?: string }>)
    return (
      <>
        <div className="av-summary">{entries.length} 条场景例句</div>
        <div className="av-egs">
          {entries.map(([word, eg]) => (
            <div key={word} className="av-eg">
              <b>{word}</b>
              <span className="av-eg-en">{eg?.en}</span>
              {eg?.zh && <span className="av-eg-zh">{eg.zh}</span>}
            </div>
          ))}
        </div>
      </>
    )
  }

  // 其余节点（视频域的 metrics 等）用键值对表呈现，比 JSON 好读
  return (
    <div className="av-kv">
      {Object.entries(data).map(([k, v]) => (
        <div key={k}>
          <span>{k}</span>
          <b>{typeof v === 'object' ? JSON.stringify(v) : String(v)}</b>
        </div>
      ))}
    </div>
  )
}

/** 全文弹窗（FR-280）：抽屉太窄读不了长文，看全文得铺开 */
function FullPassage({ payload, onClose }: { payload: unknown; onClose: () => void }) {
  useStopTtsOnClose()
  const d = payload as {
    title?: string
    form?: string
    paragraphs?: Array<{ role?: string; en?: string; zh?: string }>
  }
  return (
    <Overlay onClose={onClose} card="fp-card">
        <div className="overlay-head">
          <div className="overlay-title">{d.title ?? '场景短文'}</div>
          <span className="chip accent">{d.form === 'dialogue' ? '对话' : '短文'}</span>
          <div style={{ flex: 1 }} />
          <button className="icon-btn" onClick={onClose}>
            <IconClose />
          </button>
        </div>
        <div className="fp-body">
          {(d.paragraphs ?? []).map((p, i) => (
            <div key={i} className="fp-para">
              {p.role && <div className="fp-role">{p.role}</div>}
              <p>{p.en}</p>
              {p.zh && <span>{p.zh}</span>}
            </div>
          ))}
        </div>
      </Overlay>
  )
}
