import { Picker } from '@/components/ui/picker'

/* 「设为封面」（模块 16 FR-424）。

   已有封面时重跑只产生候选、旧封面不动（BR-109），所以必须有一个显式的采用动作。
   这里做成"选本 → 设为封面"两步，落在查看器的信息条上，不再单开一个抽屉。 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { toast } from 'sonner'

import { apiDeck } from '@/lib/api-deck'
import type { ImageAsset } from '@/lib/api-image'
import { apiImage } from '@/lib/api-image'

export function ApplyBar({ asset }: { asset: ImageAsset }) {
  const queryClient = useQueryClient()
  const [open, setOpen] = useState(false)
  const [deckId, setDeckId] = useState('')

  // 虚拟本（生词本 / 考纲本）不占 wordlist 行，给它们配封面要另一套寻址，本期不做
  const decks = useQuery({ queryKey: ['img-apply-decks'], queryFn: apiDeck.list, enabled: open })
  const custom = (decks.data ?? []).filter((d) => d.key.startsWith('custom:'))

  const apply = useMutation({
    mutationFn: () =>
      apiImage.applyAsset(asset.id, 'wordlist', Number(deckId.replace('custom:', ''))),
    onSuccess: () => {
      toast.success('已设为封面')
      setOpen(false)
      // 封面在多处展示，一次全刷：书架卡片、详情横幅、资产状态
      void queryClient.invalidateQueries({ queryKey: ['decks'] })
      void queryClient.invalidateQueries({ queryKey: ['img-assets'] })
      void queryClient.invalidateQueries({ queryKey: ['img-asset', asset.id] })
    },
    onError: (e: Error) => toast.error(e.message),
  })

  // 已经绑到某个本上的话，默认选中它，省得再翻一遍列表
  const preset = asset.subject_id !== null ? `custom:${asset.subject_id}` : ''

  if (!open) {
    return (
      <button
        className="btn-ghost-sm"
        onClick={() => {
          setDeckId(preset)
          setOpen(true)
        }}
      >
        设为封面
      </button>
    )
  }

  return (
    <span className="imgc-apply">
      <Picker
        className="input"
        value={deckId}
        placeholder="选一个单词本…"
        onChange={setDeckId}
        options={custom.map((d) => ({
          value: d.key,
          label: `${d.emoji ?? ''} ${d.name}`.trim(),
        }))}
      />
      <button
        className="btn btn-primary"
        disabled={deckId === '' || apply.isPending}
        onClick={() => apply.mutate()}
      >
        {apply.isPending ? '写入中…' : '确认'}
      </button>
      <button className="btn-ghost-sm" onClick={() => setOpen(false)}>
        取消
      </button>
    </span>
  )
}
