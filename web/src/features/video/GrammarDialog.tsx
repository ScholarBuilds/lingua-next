/* 句子语法分析弹窗（FR-334）。

   后端 POST /analyze/grammar（grammar-deep 别名、按内容指纹缓存）早就有了，
   一直缺的只是入口——字幕行上没有地方点进来。结果按 ADR-006 寻址缓存，
   同一句二次打开走缓存不再调用 AI。 */

import { useMemo } from 'react'
import { GrammarVoiceButton } from '../grammar/GrammarVoice'

import { useQuery } from '@tanstack/react-query'

import { Overlay } from '../../components/Overlay'

import { IconAlert, IconClose, IconSparkle } from '../../components/icons'
import { api } from '../../lib/api'
import { layoutComponents } from '../reader/grammarTree'
import { normalizeRole, roleClass, roleNote } from '../reader/grammarRole'
import type { GramNode } from '../reader/grammarTree'
import { playTts } from '../../lib/audio'
import { ClickableEn } from '../reader/ClickableEn'
import type { CuePhrase } from '../../lib/api-video'
import type { WordSelection } from '../reader/readerStore'
import { CueText } from './CueText'
import type { PhraseHost } from './CueText'
import { VIconPause, VIconPlaySolid, VIconRestart } from './icons'
import { useStopTtsOnClose } from '../../lib/useStopTtsOnClose'
import { SendToSentenceLab } from '@/components/SendToSentenceLab'

interface GrammarDialogProps {
  /** 句 id + 原文 + 词组区间：原句要和右栏一样有三色标注（FR-358） */
  host: PhraseHost
  /** 原句正在播放 */
  playing: boolean
  /** 词级卡拉OK区间；与视频时间戳同源，所以高亮和外面一致（FR-359） */
  karaoke: [number, number] | null
  onPlay: () => void
  /** 从句首重读（FR-360）：续播按钮回不到开头，想重听一遍没有入口 */
  onReplay: () => void
  /** 字幕自带译文（FR-361）：这句本来就有中文，不必让 AI 再翻一遍 */
  zh: string | null
  onWord?: (sel: WordSelection) => void
  onPhrase?: (phrase: CuePhrase, host: PhraseHost) => void
  onClose: () => void
}

export function GrammarDialog({
  host,
  playing,
  karaoke,
  onPlay,
  onReplay,
  zh,
  onWord,
  onPhrase,
  onClose,
}: GrammarDialogProps) {
  useStopTtsOnClose()
  const sentence = host.text
  const query = useQuery({
    queryKey: ['grammar', sentence],
    queryFn: () => api.grammar({ sentence }),
    staleTime: Infinity,
    retry: false,
  })
  const g = query.data?.result
  /* 成分是先序拍平的树，还原后按层缩进渲染；平铺会让同一段文字出现两遍 */
  const gramTree = useMemo(
    () => layoutComponents(sentence, g?.components),
    [sentence, g?.components],
  )

  return (
    <Overlay onClose={onClose} card="gd-card">
        <div className="overlay-head">
          <div className="overlay-title">
            <IconSparkle />
            语法分析
          </div>
          {query.data?.cached === true && <span className="chip">缓存</span>}
          <SendToSentenceLab text={sentence} />
          <GrammarVoiceButton sentence={sentence} analysis={g} source="视频字幕语法分析" />
          <div style={{ flex: 1 }} />
          <button className="icon-btn" onClick={onClose}>
            <IconClose />
          </button>
        </div>

        {/* 与右栏同一套渲染（FR-358/359）：词组三色标注、读到哪个词亮哪个、点词查词卡。
            原句走<b>视频片段播放</b>而不是 TTS——词级时间戳是视频的，用 TTS 另合成一段音频
            时间轴对不上，高亮就会漂。 */}
        <div className="gd-sent">
          <button
            className={`gd-play${playing ? ' on' : ''}`}
            title={playing ? '暂停' : '播放原句'}
            onClick={onPlay}
          >
            {playing ? (
              <VIconPause style={{ width: 12, height: 12 }} />
            ) : (
              <VIconPlaySolid style={{ width: 12, height: 12 }} />
            )}
          </button>
          <div className="gd-sent-body">
            <p>
              <CueText cue={host} onWord={onWord} onPhrase={onPhrase} karaoke={karaoke} />
              {/* 从头读跟在句末（FR-362）：竖排在左侧时，句子一换行按钮就孤零零挂在第二行 */}
              <button className="sent-replay" title="从头读这句" onClick={onReplay}>
                <VIconRestart style={{ width: 11, height: 11 }} />
              </button>
            </p>
            {/* 译文优先取字幕自带的（FR-361）：与视频里看到的一致，也省掉 AI 重翻 */}
            {(zh ?? g?.translation) !== undefined && (zh ?? g?.translation) !== '' && (
              <p className="gd-zh-inline">{zh ?? g?.translation}</p>
            )}
          </div>
        </div>

        {query.isPending && (
          <div className="state-block">
            <div className="spinner" />
            <div>分析中…</div>
          </div>
        )}
        {query.isError && (
          <div className="gd-err">
            <IconAlert />
            {query.error instanceof Error && query.error.message.includes('503')
              ? 'AI 网关未配置，暂不可用'
              : '分析失败，可关掉重试'}
          </div>
        )}

        {g !== undefined && (
          <div className="gd-body">
            {g.quick && (
              <div className="gd-quick">
                <IconSparkle />
                {g.quick}
              </div>
            )}
            {g.backbone && (
              <div className="gd-sec">
                <span className="gd-k">主干</span>
                <div className="gd-v">{g.backbone}</div>
              </div>
            )}
            {gramTree.length > 0 && (
              <div className="gd-sec">
                <span className="gd-k">成分</span>
                <div className="gd-comps">
                  {gramTree.map((node: GramNode, i: number) => (
                    <CompRow key={i} node={node} sentence={sentence} depth={0} />
                  ))}
                </div>
              </div>
            )}
            {g.tenses && (
              <div className="gd-sec">
                <span className="gd-k">时态语态</span>
                <div className="gd-v">{g.tenses}</div>
              </div>
            )}
            {g.difficulty_note && (
              <div className="gd-sec">
                <span className="gd-k">难点</span>
                <div className="gd-v">{g.difficulty_note}</div>
              </div>
            )}
          </div>
        )}
      </Overlay>
  )
}

/* 成分是一棵先序拍平的树（见 reader/grammarTree.ts），按层缩进渲染。
   平铺渲染会让分句和它内部的成分各占一行，同一段文字出现两遍。 */
function CompRow({
  node,
  sentence,
  depth,
}: {
  node: GramNode
  sentence: string
  depth: number
}) {
  return (
    <>
      <div
        className="gd-comp"
        style={depth > 0 ? { marginLeft: depth * 14 } : undefined}
        role="button"
        tabIndex={0}
        title="点这块只读这一段；点单词查词卡"
        onClick={(ev) => {
          if ((window.getSelection()?.toString() ?? '').trim() !== '') return
          ev.stopPropagation()
          playTts(node.text, 'sentence')
        }}
      >
        <b>
          <ClickableEn text={node.text} context={sentence} force />
        </b>
        <em className={roleClass(node.role)}>{normalizeRole(node.role)}</em>
        {roleNote(node.role, node.note) !== '' && (
          <i className="gd-comp-note">{roleNote(node.role, node.note)}</i>
        )}
      </div>
      {node.children.map((child, i) => (
        <CompRow key={i} node={child} sentence={sentence} depth={depth + 1} />
      ))}
    </>
  )
}
