/* 按住说话的录音钩子：对话页与语音助理共用，一段 MediaRecorder 落成一个 Blob 交给上层 */

import { useCallback, useEffect, useRef, useState } from 'react'

import { requireMic } from './mic'

export function pickRecordMime(): string | undefined {
  if (typeof MediaRecorder === 'undefined') return undefined
  for (const m of ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus']) {
    if (MediaRecorder.isTypeSupported(m)) return m
  }
  return undefined
}

export function useRecorder(onDone: (blob: Blob, filename: string) => void, onError: (msg: string) => void) {
  const [recording, setRecording] = useState(false)
  const recRef = useRef<MediaRecorder | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const startedAtRef = useRef(0)
  const generation = useRef(0)
  const starting = useRef(false)
  const callbacks = useRef({ onDone, onError })
  callbacks.current = { onDone, onError }
  useEffect(() => () => {
    generation.current++
    starting.current = false
    const rec = recRef.current
    recRef.current = null
    if (rec?.state === 'recording') rec.stop()
    rec?.stream.getTracks().forEach((track) => track.stop())
  }, [])

  const start = async () => {
    if (recRef.current || starting.current) return
    starting.current = true
    const gen = ++generation.current
    let stream: MediaStream
    try {
      stream = await requireMic()
    } catch {
      if (gen === generation.current) {
        starting.current = false
        callbacks.current.onError('麦克风不可用：请在浏览器允许麦克风权限后重试')
      }
      return
    }
    if (gen !== generation.current) {
      stream.getTracks().forEach((track) => track.stop())
      return
    }
    starting.current = false
    const mime = pickRecordMime()
    let rec: MediaRecorder
    try {
      rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined)
    } catch {
      stream.getTracks().forEach((track) => track.stop())
      callbacks.current.onError('当前设备无法录音，请检查音频设备')
      return
    }
    chunksRef.current = []
    rec.ondataavailable = (e) => {
      if (e.data.size > 0) chunksRef.current.push(e.data)
    }
    rec.onstop = () => {
      stream.getTracks().forEach((t) => t.stop())
      if (gen !== generation.current) return
      recRef.current = null
      setRecording(false)
      const duration = Date.now() - startedAtRef.current
      const type = rec.mimeType || 'audio/webm'
      const blob = new Blob(chunksRef.current, { type })
      // 过短视为误触
      if (duration < 400 || blob.size === 0) return
      callbacks.current.onDone(blob, type.includes('ogg') ? 'turn.ogg' : 'turn.webm')
    }
    recRef.current = rec
    startedAtRef.current = Date.now()
    const fail = () => {
      stream.getTracks().forEach((track) => track.stop())
      if (gen !== generation.current) return
      generation.current++
      recRef.current = null
      setRecording(false)
      callbacks.current.onError('录音中断，请检查音频设备后重试')
    }
    rec.onerror = fail
    try {
      rec.start()
      setRecording(true)
    } catch { fail() }
  }

  const stop = useCallback(() => {
    if (starting.current) { generation.current++; starting.current = false }
    if (recRef.current?.state === 'recording') recRef.current.stop()
  }, [])

  return { recording, start, stop }
}
