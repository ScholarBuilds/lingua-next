import { useWordModalStore } from '../reader/wordModalStore'
import type { VocabSource } from '../../lib/api'

interface TalkWordTextProps {
  text: string
  source?: VocabSource
}

export function TalkWordText({ text, source }: TalkWordTextProps) {
  const openWord = useWordModalStore.getState().openWord
  return (
    <span className="talk-word-text">
      {text.split(/([A-Za-z]+(?:['’-][A-Za-z]+)*)/g).map((part, index) =>
        /^[A-Za-z]+(?:['’-][A-Za-z]+)*$/.test(part) ? (
          <button
            key={index}
            type="button"
            title={`查看 ${part} 的单词卡`}
            onClick={() => openWord(part, text.slice(0, 400), undefined, source)}
          >
            {part}
          </button>
        ) : part,
      )}
    </span>
  )
}
