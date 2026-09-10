/* 拆开记（FR-321~329）：把一个词拆成看得懂的块。

   两段视图：
   - 音节：前端 hyphen 离线切，进卡片就有；AI 给出更权威的切分后替换（BR-68）
   - 词素：AI 给出前缀/词根/后缀 + 中文注解 + 构词 + 助记 + 同根词，按 ADR-006 指纹缓存

   进卡片先探一次缓存（不产生调用），命中直出，没命中给按钮（FR-327）。 */

import { useMutation, useQuery } from '@tanstack/react-query'

import { IconSparkle, IconSpeaker } from '../../components/icons'
import { api } from '../../lib/api'
import type { Morpheme } from '../../lib/api'
import { playTts } from '../../lib/audio'
import { usePrefStore } from '../../lib/prefStore'
import { syllablesOf } from '../../lib/syllable'
import { useWordModalStore } from './wordModalStore'
import './breakdown.css'

/** 构词式去重：词素块已经把 "appet(食欲) + -izer(使成为…的)" 摆出来了，
    formation 前半段是同一份信息的文字版，只留 → 之后的推导。 */
function derivation(formation: string): string {
  const parts = formation.split('→').map((p) => p.trim()).filter((p) => p !== '')
  return parts.length > 1 ? parts.slice(1).join(' → ') : formation
}

const TYPE_LABEL: Record<Morpheme['type'], string> = {
  prefix: '前缀',
  root: '词根',
  suffix: '后缀',
  linking: '连接',
}

interface WordBreakdownProps {
  word: string
}

export function WordBreakdown({ word }: WordBreakdownProps) {
  const mode = usePrefStore((s) => s.prefs.vocab.breakdown)
  const openWord = useWordModalStore((s) => s.openWord)
  const key = word.trim().toLowerCase()

  // 探缓存：命中直出，未命中返回 result:null，不触发 LLM
  const probe = useQuery({
    queryKey: ['breakdown', key],
    queryFn: () => api.wordBreakdown(key, { cachedOnly: true }),
    enabled: mode !== 'off' && key !== '',
    staleTime: 0,
    refetchInterval: query => query.state.data?.result ? false : 5000,
    retry: false,
  })

  const generate = useMutation({
    mutationFn: () => api.wordBreakdown(key),
    onSuccess: (data) => probe.refetch().then(() => data),
  })

  if (mode === 'off' || key === '') return null

  const ai = generate.data?.result ?? probe.data?.result ?? null
  // AI 的切分更权威；没有就用离线那份顶上
  const syllables = ai?.syllables ?? syllablesOf(key)
  const stress = ai?.stress ?? -1
  const showSyl = mode === 'both' || mode === 'syllable'
  const showMor = mode === 'both' || mode === 'morpheme'

  return (
    <div className="wc-sec wb">
      <div className="wc-label">
        拆开记
        {ai !== null && <span className="re wb-src">AI 拆解</span>}
      </div>

      {/* 音节与音标上下对齐成两行，不做成一堆小盒子——卡片其余部分是文字流，
          突然出现一排带框控件就显得违和。重音只靠着色 + 底部细线表达。 */}
      {showSyl && (
        <div className="wb-syl">
          <div className="wb-syl-row">
            {syllables.map((s, i) => (
              <button
                key={`${s}-${i}`}
                className={`wb-cell${i === stress ? ' stress' : ''}`}
                title={`只读这一段：${s}`}
                onClick={() => playTts(s, 'word')}
              >
                <span className="wb-cell-s">{s}</span>
                {ai?.ipa_syllables?.[i] !== undefined && (
                  <span className="wb-cell-p">{ai.ipa_syllables[i]}</span>
                )}
              </button>
            ))}
          </div>
          <button className="wb-all" title="读整个词" onClick={() => playTts(key, 'word')}>
            <IconSpeaker />
          </button>
        </div>
      )}

      {showMor && ai === null && (
        <div className="wb-cta">
          <button
            className={`btn btn-soft btn-sm${generate.isPending ? ' loading' : ''}`}
            disabled={generate.isPending}
            onClick={() => generate.mutate()}
          >
            {generate.isPending ? <span className="spinner" /> : <IconSparkle />}
            {generate.isPending ? '拆解中…' : 'AI 拆解词根词缀'}
          </button>
          {generate.isError && (
            <span className="wb-err">
              {generate.error instanceof Error && generate.error.message.includes('503')
                ? 'AI 网关未配置'
                : '拆解失败，可重试'}
            </span>
          )}
        </div>
      )}

      {showMor && ai !== null && (
        <>
          {/* 词素排成一道构词式：块之间用 + 连接，块本身不加边框，
              只用颜色区分前缀/词根/后缀，注解压到下面一行小字 */}
          <div className="wb-mor">
            {ai.morphemes.map((m, i) => (
              <span key={`${m.text}-${i}`} className="wb-m-wrap">
                {i > 0 && <i className="wb-plus">+</i>}
                <span className={`wb-m t-${m.type}`}>
                  <b>{m.text}</b>
                  <span className="wb-m-note">
                    {TYPE_LABEL[m.type] ?? m.type} · {m.gloss}
                  </span>
                </span>
              </span>
            ))}
          </div>
          {ai.formation && (
            <div className="wb-line">
              <i>→</i>
              {derivation(ai.formation)}
            </div>
          )}
          {ai.mnemonic && (
            <div className="wb-mne">
              <IconSparkle />
              {ai.mnemonic}
            </div>
          )}
          {ai.family.length > 0 && (
            <div className="wb-fam">
              <span className="wb-fam-label">同根词</span>
              {ai.family.map((f) => (
                <button key={f.word} title={`${f.zh} · 点击查看这个词`} onClick={() => openWord(f.word, ai.formation)}>
                  {f.word}
                  <em>{f.zh}</em>
                </button>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  )
}
