import { Bookmark, Braces, Copy, Languages, Maximize2, MoreHorizontal, Rows3, Shrink, TextCursorInput, Workflow } from '@/components/NexusIcon'

export const IconTypography = TextCursorInput
export const IconTranslate = Languages
export const IconFocus = Braces
export const IconExpand = Maximize2
export const IconShrink = Shrink
export const IconAutoScroll = Rows3
export const IconMore = MoreHorizontal
export const IconKeyboard = TextCursorInput
export const IconCopy = Copy
export const IconGrammar = Workflow

export function IconBookmark({ filled: _filled = false }: { filled?: boolean }) {
  void _filled
  return <Bookmark />
}
