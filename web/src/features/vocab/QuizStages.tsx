import { useEffect, useMemo, useState } from 'react'
import { playTts } from '../../lib/audio'
import { judge } from './dictation'
import { optionsFor } from './grouping'
import type { GroupItem, QuizKind } from './grouping'
import { useDrillKeys } from './useDrillKeys'

export const MAX_RECAP_ROUNDS = 3
export type RecallDir = 'en2zh' | 'zh2en' | 'mix'
export type RecallGrade = 'known' | 'fuzzy' | 'unknown'
export interface DrillOptions {
  dir: RecallDir
  showPhonetic: boolean
  showExample: boolean
  autoSpeak: boolean
}
export const DEFAULT_DRILL_OPTIONS: DrillOptions = {
  dir: 'en2zh', showPhonetic: true, showExample: true, autoSpeak: true,
}
export function dirOf(opts: DrillOptions, word: string): 'en2zh' | 'zh2en' {
  if (opts.dir !== 'mix') return opts.dir
  let h = 0
  for (let i = 0; i < word.length; i += 1) h = (h * 31 + word.charCodeAt(i)) % 2
  return h === 0 ? 'en2zh' : 'zh2en'
}

export function RecallStage({ item, index, total, opts, onGrade, active = true }: {
  item: GroupItem; index: number; total: number; opts: DrillOptions
  onGrade: (g: RecallGrade) => void; active?: boolean
}) {
  const [shown, setShown] = useState(false)
  const [checked, setChecked] = useState(false)
  const dir = dirOf(opts, item.word)
  useEffect(() => {
    if (active && opts.autoSpeak && dir === 'en2zh') playTts(item.word, 'word')
  }, [item.word, dir, opts.autoSpeak, active])
  const toggle = () => { setShown(v => !v); setChecked(true) }
  const listen = () => {
    if (dir === 'zh2en') { setShown(true); setChecked(true) }
    playTts(item.word, 'word')
  }
  useDrillKeys({ ' ': toggle, r: listen, '1': checked ? () => onGrade('unknown') : undefined,
    '2': checked ? () => onGrade('fuzzy') : undefined, '3': checked ? () => onGrade('known') : undefined }, active)
  return <section className="drill-question" aria-label="认词">
    <div className="drill-question-meta">先回想，再核对 <span>{index + 1} / {total}</span></div>
    <h2 className="drill-prompt">{dir === 'en2zh' ? item.word : item.translation}</h2>
    {dir === 'en2zh' && opts.showPhonetic && item.phonetic && <div className="gdr-phon">{item.phonetic}</div>}
    <div className="drill-answer" aria-live="polite">
      {shown ? <>
        <strong>{dir === 'en2zh' ? item.translation : item.word}</strong>
        {opts.showExample && item.exampleEn && <div className="drill-example">{item.exampleEn}<p>{item.exampleZh}</p></div>}
      </> : <p className="gdr-muted">{checked ? '答案已隐藏，再回想一次。' : '在心里说出答案，再按空格核对。'}</p>}
    </div>
    <div className="drill-tools"><button className="btn btn-soft" aria-pressed={shown} onClick={toggle}>{shown ? '隐藏答案' : '看答案'} <kbd>空格</kbd></button>
      <button className="btn btn-outline" onClick={listen}>朗读 <kbd>R</kbd></button></div>
    <div className="drill-grade">
      <button className="btn btn-outline" disabled={!checked} onClick={() => onGrade('unknown')}>不会 <kbd>1</kbd></button>
      <button className="btn btn-outline" disabled={!checked} onClick={() => onGrade('fuzzy')}>模糊 <kbd>2</kbd></button>
      <button className="btn btn-primary" disabled={!checked} onClick={() => onGrade('known')}>认识 <kbd>3</kbd></button>
    </div>
    <p className="gdr-muted">自评决定练习顺序，通过自测后才记录结果。</p>
  </section>
}

export function QuizStage({ item, group, kind, onAnswer, active = true }: {
  item: GroupItem; group: GroupItem[]; kind: QuizKind
  onAnswer: (kind: QuizKind, ok: boolean) => void; active?: boolean
}) {
  const [typed, setTyped] = useState('')
  const [picked, setPicked] = useState<string | null>(null)
  const [shown, setShown] = useState(false)
  const [assisted, setAssisted] = useState(false)
  const options = useMemo(() => optionsFor(group, item, kind), [item, group, kind])
  const spell = kind === 'spell'
  const correct = picked !== null && (spell ? judge(picked, item.word).verdict === 'correct' : picked === item.word)
  const toggle = () => { setShown(v => !v); if (picked === null) setAssisted(true) }
  const listen = () => {
    if (kind !== 'en2zh' && picked === null) setAssisted(true)
    playTts(item.word, 'word')
  }
  const choose = (value: string) => { if (picked === null && value.trim()) setPicked(value) }
  const advance = () => { if (picked !== null) onAnswer(kind, correct && !assisted) }
  useDrillKeys({ ' ': toggle, r: listen, enter: picked !== null ? advance : spell ? () => choose(typed) : undefined,
    ...Object.fromEntries(options.map((option, index) => [String(index + 1), !spell && picked === null ? () => choose(option.word) : undefined])) }, active)
  return <section className="drill-question" aria-label="自测">
    <div className="drill-question-meta">{spell ? '拼写 · 写出英文' : kind === 'zh2en' ? '选出对应的英文' : '选出对应的释义'}<span>{assisted ? '已用提示' : '独立回想'}</span></div>
    <h2 className="drill-prompt">{kind === 'en2zh' ? item.word : item.translation}</h2>
    {spell ? <form onSubmit={e => { e.preventDefault(); if (picked !== null) advance(); else choose(typed) }}>
      <input className="dic-input" aria-label="拼写答案" value={typed} autoComplete="off" autoCapitalize="none" spellCheck={false}
        readOnly={picked !== null} placeholder="输入英文，按 Enter 核对" onChange={e => setTyped(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter' && (e.nativeEvent.isComposing || e.repeat)) e.preventDefault() }} />
      {picked === null && <button className="btn btn-primary" disabled={!typed.trim()} type="submit">核对拼写 <kbd>Enter</kbd></button>}
    </form> : <div className="drill-options">{options.map((option, index) => <button key={option.word}
      className={'drill-option' + (picked !== null && option.word === item.word ? ' correct' : '') + (picked === option.word && !correct ? ' incorrect' : '')}
      disabled={picked !== null} onClick={() => choose(option.word)}><kbd>{index + 1}</kbd><span>{kind === 'zh2en' ? option.word : option.translation}</span>
      {picked !== null && option.word === item.word && <small>正确答案</small>}{picked === option.word && !correct && <small>你的选择</small>}</button>)}</div>}
    <div className="drill-answer" aria-live="polite">
      {picked !== null ? <><strong>{correct ? assisted ? '核对正确 · 提示后完成，稍后再练' : '回答正确' : '还没记稳 · 稍后再练'}</strong>
        <p>{item.word} — {item.translation}</p>{item.exampleEn && <div className="drill-example">{item.exampleEn}<p>{item.exampleZh}</p></div>}</>
        : shown ? <><strong>{item.word} — {item.translation}</strong><p className="gdr-muted">这次计为提示后完成，之后会再测一次。</p></>
        : <p className="gdr-muted">{assisted ? '提示已隐藏，这次仍按辅助练习记录。' : '想不起来时可以偷看。看过答案后不会直接判为通过。'}</p>}
    </div>
    <div className="drill-tools">{picked === null && <button className="btn btn-soft" aria-pressed={shown} onClick={toggle}>{shown ? '隐藏答案' : '偷看答案'} <kbd>空格</kbd></button>}
      <button className="btn btn-outline" onClick={listen}>{kind === 'en2zh' || picked !== null ? '重听' : '听发音提示'} <kbd>R</kbd></button>
      {picked !== null && <button className="btn btn-primary" onClick={advance}>继续 <kbd>Enter</kbd></button>}</div>
    {spell && <p className="gdr-muted">输入框内空格正常输入；点击输入框外即可使用快捷键。</p>}
  </section>
}

export function GateStage({ passed, onRetry, onNext, onGiveUp, busy = false }: {
  passed: boolean; round: number; onRetry: () => void; onNext: () => void; onGiveUp: () => void; busy?: boolean
}) {
  useDrillKeys({ enter: passed ? onNext : onRetry }, !busy)
  return <section className="drill-question" aria-label="本组结果">
    <h2>{passed ? '本组通过' : '这组还有待巩固的词'}</h2>
    <p>{passed ? '已完成独立识别与拼写，可以进入下一组。' : '可以再练未通过的词，也可以暂放，完成后集中巩固。'}</p>
    <div className="drill-tools"><button className="btn btn-primary" disabled={busy} onClick={passed ? onNext : onRetry}>{busy ? '正在保存…' : passed ? '保存并继续' : '再练待巩固词'} <kbd>Enter</kbd></button>
      {!passed && <button className="btn btn-outline" disabled={busy} onClick={onGiveUp}>暂放并继续</button>}</div>
  </section>
}
