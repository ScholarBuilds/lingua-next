/* 听读的 App 级部分（BR-184 跨页常驻）：

   - 媒体键 / 系统「正在播放」注册在这里而不是停靠条上——切到别的页停靠条卸了，
     媒体键还得能暂停。
   - 迷你条：听读开着但停靠条不在页面上（去了阅读 / 视频 / 别的本），右下角露一条能
     暂停、切词、跳回单词本的小条，别让用户找不到正在响的是什么。 */

import { useEffect } from 'react'
import { useNavigate } from 'react-router-dom'

import { IconClose, IconPause, IconPlay, IconSkipBack, IconSkipForward } from '../../components/icons'
import { usePrefStore } from '../../lib/prefStore'
import { useListenStore } from './listenStore'
import { spokenMeaning } from './spokenMeaning'
import './listen.css'

const MEDIA_ACTIONS: MediaSessionAction[] = ['play', 'pause', 'previoustrack', 'nexttrack']

function ListenMediaSession() {
  const status = useListenStore((s) => s.status)
  const deckName = useListenStore((s) => s.deckName)
  const current = useListenStore((s) => {
    const idx = s.order[s.pos]
    return idx === undefined ? undefined : s.items[idx]
  })
  const scope = usePrefStore((s) => s.prefs.listen.meaningScope)

  /* 处理器里读 getState，不抓过期闭包 */
  useEffect(() => {
    if (!('mediaSession' in navigator)) return
    const ms = navigator.mediaSession
    const s = () => useListenStore.getState()
    ms.setActionHandler('play', () => s().play())
    ms.setActionHandler('pause', () => s().pause())
    ms.setActionHandler('previoustrack', () => s().prev())
    ms.setActionHandler('nexttrack', () => s().next())
    return () => {
      for (const action of MEDIA_ACTIONS) ms.setActionHandler(action, null)
      ms.metadata = null
      ms.playbackState = 'none'
    }
  }, [])
  useEffect(() => {
    if (!('mediaSession' in navigator)) return
    const ms = navigator.mediaSession
    ms.metadata = new MediaMetadata({
      title: current?.word ?? deckName,
      artist: spokenMeaning(current?.translation, { scope }),
      album: deckName,
    })
    // 词间空档里 status 仍是 playing，系统面板不该在每个空档闪一下「已暂停」
    ms.playbackState = status === 'playing' ? 'playing' : status === 'paused' ? 'paused' : 'none'
  }, [current, status, deckName, scope])
  return null
}

function ListenMiniBar() {
  const navigate = useNavigate()
  const status = useListenStore((s) => s.status)
  const deckName = useListenStore((s) => s.deckName)
  const route = useListenStore((s) => s.route)
  const pos = useListenStore((s) => s.pos)
  const count = useListenStore((s) => s.order.length)
  const current = useListenStore((s) => {
    const idx = s.order[s.pos]
    return idx === undefined ? undefined : s.items[idx]
  })
  const { play, pause, next, prev, close } = useListenStore.getState()
  const playing = status === 'playing'
  return (
    <div className="lsn-mini" role="region" aria-label="正在听读">
      <button
        className="lsn-mini-back"
        title={`回到「${deckName}」`}
        onClick={() => navigate(route || '/vocab')}
      >
        <span className="lsn-mini-deck">听读 · {deckName}</span>
        <b>{current?.word ?? '…'}</b>
        {count > 0 && <span className="lsn-mini-count">{Math.min(pos + 1, count)} / {count}</span>}
      </button>
      <button className="icon-btn" title="上一个词" onClick={prev}>
        <IconSkipBack />
      </button>
      <button className="lsn-play" title={playing ? '暂停' : '播放'} onClick={playing ? pause : play}>
        {playing ? <IconPause /> : <IconPlay />}
      </button>
      <button className="icon-btn" title="下一个词" onClick={next}>
        <IconSkipForward />
      </button>
      <button className="icon-btn" title="关闭听读" onClick={close}>
        <IconClose />
      </button>
    </div>
  )
}

export function ListenGlobal() {
  const visible = useListenStore((s) => s.visible)
  const barMounted = useListenStore((s) => s.barMounted)
  if (!visible) return null
  return (
    <>
      <ListenMediaSession />
      {!barMounted && <ListenMiniBar />}
    </>
  )
}
