/* 听读键位表（FR-503）：注册与帮助面板同一份，不接的键不列（帮助面板不能撒谎）。
   `keys` 是 react-hotkeys-hook 的写法，`label` 是面板上给人看的。 */

export type ListenAction =
  | 'toggle'
  | 'next'
  | 'prev'
  | 'again'
  | 'loopOne'
  | 'shuffle'
  | 'loopAll'
  | 'content'
  | 'repeat1'
  | 'repeat2'
  | 'repeat3'
  | 'repeat5'
  | 'slower'
  | 'faster'
  | 'card'
  | 'voice'
  | 'help'
  | 'close'

export interface ListenKey {
  action: ListenAction
  keys: string
  label: string
  desc: string
}

export const LISTEN_KEYS: ListenKey[] = [
  { action: 'toggle', keys: 'space', label: '空格', desc: '播放 / 暂停' },
  { action: 'prev', keys: 'left', label: '←', desc: '上一个词' },
  { action: 'next', keys: 'right', label: '→', desc: '下一个词' },
  { action: 'again', keys: 'r', label: 'R', desc: '再读一遍这个词' },
  { action: 'loopOne', keys: 'l', label: 'L', desc: '单词循环：一直念当前这个词' },
  { action: 'shuffle', keys: 's', label: 'S', desc: '随机 / 按列表' },
  { action: 'loopAll', keys: 'a', label: 'A', desc: '播完从头再来 / 停下' },
  { action: 'content', keys: 'm', label: 'M', desc: '切换念什么：只念词 → 词 + 释义 → 词 + 释义 + 例句' },
  { action: 'repeat1', keys: '1', label: '1', desc: '每词念 1 遍' },
  { action: 'repeat2', keys: '2', label: '2', desc: '每词念 2 遍' },
  { action: 'repeat3', keys: '3', label: '3', desc: '每词念 3 遍' },
  { action: 'repeat5', keys: '5', label: '5', desc: '每词念 5 遍' },
  { action: 'slower', keys: 'bracketleft', label: '[', desc: '慢一档' },
  { action: 'faster', keys: 'bracketright', label: ']', desc: '快一档' },
  { action: 'card', keys: 'w', label: 'W', desc: '打开当前词的词卡；再按一次关掉，关掉接着念' },
  { action: 'voice', keys: 'v', label: 'V', desc: '给当前词换个声音' },
  { action: 'help', keys: 'shift+slash, slash', label: '?', desc: '这张键位表' },
  { action: 'close', keys: 'escape', label: 'Esc', desc: '关闭听读' },
]
