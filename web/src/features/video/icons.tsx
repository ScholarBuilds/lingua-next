import type { CSSProperties } from 'react'

import { LearningIcon } from '@/components/LearningIcon'

import {
  AlertTriangle, ArrowLeft, ArrowRight, AudioLines, Bookmark, Copy, ExternalLink,
  Info, Maximize2, RefreshCw, TextCursorInput, Workflow,
} from '@/components/NexusIcon'
import type { LucideProps } from '@/components/NexusIcon'

export function VIconBookmark({ filled: _filled, ...props }: LucideProps & { filled?: boolean }) {
  void _filled
  return <Bookmark {...props} />
}

export function VIconFlag({ filled: _filled, ...props }: LucideProps & { filled?: boolean }) {
  void _filled
  return <Bookmark {...props} />
}

function learningGlyph(name: Parameters<typeof LearningIcon>[0]['name']) {
  return function VideoLearningIcon({ className, style }: LucideProps) {
    return <LearningIcon name={name} className={className} style={style as CSSProperties} />
  }
}

export const VIconRefresh = RefreshCw
export const VIconCopy = Copy
export const VIconEyeOff = Info
export const VIconFullscreen = Maximize2
export const VIconRepeat = learningGlyph('ab-loop')
export const VIconRepeatOne = learningGlyph('repeat-sentence')
export const VIconPinA = Bookmark
export const VIconTimerGap = learningGlyph('interval')
export const VIconPhraseHint = learningGlyph('focus-sentence')
export const VIconStepPause = learningGlyph('pause')
export const VIconPrevCue = learningGlyph('previous-sentence')
export const VIconNextCue = learningGlyph('next-sentence')
export const VIconArrowLeft = ArrowLeft
export const VIconArrowRight = ArrowRight
export const VIconWarnTri = AlertTriangle
export const VIconInfoCircle = Info
export const VIconSpeakerCue = learningGlyph('voice')
export const VIconMicLine = AudioLines
export const VIconPlaySolid = learningGlyph('play')
export const VIconPauseSolid = learningGlyph('pause')
export const VIconRestart = learningGlyph('restart')
export const VIconExternal = ExternalLink

export function VIconGrammar({ style }: { style?: CSSProperties }) {
  return <Workflow style={style} />
}

export function VIconPause({ style }: { style?: CSSProperties }) {
  return <TextCursorInput style={style} />
}
