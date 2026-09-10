/* 「AI 写一条」的前端侧。

   这一路唯一真正会出事的地方是**产出直接入库**：模型写的东西质量参差，
   库里一旦混进没人看过的条目，整个库就不敢直接套用了。所以这里逐条钉住
   「只调 compose 这一个端点、不调任何写库端点」，以及覆盖规则不会把用户
   自己打的东西弄没。 */

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import type { ComposedPrompt } from './prompt-compose'
import { COMPOSE_DEFAULTS, applyComposed, composePrompt, composedNote } from './prompt-compose'

const OUT: ComposedPrompt = {
  title: '黄昏街拍',
  scene: '想要一张暖调街头人像时',
  body: 'a candid street portrait at golden hour',
  negative: 'blurry, watermark',
  variables: [],
  mode: 'create',
  model: 'deepseek-chat',
  latency_ms: 900,
}

function stubFetch(payload: unknown, status = 200): { calls: [string, RequestInit?][] } {
  const calls: [string, RequestInit?][] = []
  vi.stubGlobal('fetch', (url: string, init?: RequestInit) => {
    calls.push([url, init])
    return Promise.resolve(
      new Response(JSON.stringify(payload), {
        status,
        headers: { 'Content-Type': 'application/json' },
      }),
    )
  })
  return { calls }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('端点只有一份', () => {
  it('POST 到 /studio/prompts/compose，参数原样带过去', async () => {
    const { calls } = stubFetch(OUT)
    const got = await composePrompt({ intent: '黄昏街头人像', language: 'zh' })
    expect(got.model).toBe('deepseek-chat')
    expect(calls).toHaveLength(1)
    const [url, init] = calls[0]
    expect(url).toBe('/api/studio/prompts/compose')
    expect(init?.method).toBe('POST')
    expect(JSON.parse(String(init?.body))).toEqual({ intent: '黄昏街头人像', language: 'zh' })
  })

  it('生成一次只发一个请求，不顺手写库', async () => {
    // 库里的写操作走 /studio/prompts（POST/PATCH）。多出任何一个请求都说明
    // 产出被自动落库了——那正是这套东西不该做的事
    const { calls } = stubFetch(OUT)
    await composePrompt({ draft: 'a cat', mode: 'expand' })
    expect(calls).toHaveLength(1)
    expect(calls.every(([url]) => url.endsWith('/prompts/compose'))).toBe(true)
  })

  it('后端的 detail 原样抛出来，不改写成「生成失败」', async () => {
    stubFetch({ detail: '能力 chat-general 尚未绑定模型' }, 503)
    await expect(composePrompt({ intent: '猫' })).rejects.toThrow('尚未绑定模型')
  })

  /* 「端点只有一份」在运行时验不出来：提示词库与画布输入框各写一个客户端，
     两边都 200、都出词，只是慢慢分叉成两套请求形状与两套默认值，
     而用户以为它们出自同一处。所以按源码扫——多一份客户端当场失败。 */
  it('全仓只有这一个模块打 /studio/prompts/compose', () => {
    const SRC = join(__dirname, '..', '..')
    const hits: string[] = []
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name)
        if (entry.isDirectory()) {
          walk(full)
          continue
        }
        if (!/\.(ts|tsx)$/.test(entry.name)) continue
        if (!readFileSync(full, 'utf-8').includes("'/studio/prompts/compose'")) continue
        hits.push(full.slice(SRC.length + 1))
      }
    }
    walk(SRC)
    expect(hits.sort()).toEqual(['features/studio/prompt-compose.test.ts', 'features/studio/prompt-compose.ts'])
  })
})

describe('产出合进编辑器', () => {
  const empty = { title: '', scene: '', body: '', negative: '', variables: [] }

  it('空编辑器全盘接收', () => {
    expect(applyComposed(empty, OUT)).toEqual({
      title: '黄昏街拍',
      scene: '想要一张暖调街头人像时',
      body: 'a candid street portrait at golden hour',
      negative: 'blurry, watermark',
      variables: [],
    })
  })

  it('用户自己起的标题与场景不被模型改掉', () => {
    // 那是他用来在列表里找这条的东西，被悄悄换名字比生成得不好更难受
    const mine = { ...empty, title: '我的街拍', scene: '拍朋友时用' }
    const merged = applyComposed(mine, OUT)
    expect(merged.title).toBe('我的街拍')
    expect(merged.scene).toBe('拍朋友时用')
    expect(merged.body).toBe(OUT.body)
  })

  it('勾掉「带负向」时不拿空串把已有负向抹掉', () => {
    const mine = { ...empty, negative: 'lowres, jpeg artifacts' }
    const merged = applyComposed(mine, { ...OUT, negative: '' })
    expect(merged.negative).toBe('lowres, jpeg artifacts')
  })

  it('正文照盖——用户点这个按钮要的就是一段新正文', () => {
    const mine = { ...empty, body: 'a cat' }
    expect(applyComposed(mine, OUT).body).toBe(OUT.body)
  })

  it('变量名单跟着产出走', () => {
    const withVars: ComposedPrompt = {
      ...OUT,
      body: 'a photo of {{主体}}',
      variables: [
        { name: '主体', label: '主体', description: '拍谁', default: '', required: true },
      ],
    }
    expect(applyComposed(empty, withVars).variables).toHaveLength(1)
  })
})

describe('产出后那行字', () => {
  it('「模型」那一位显示上游真名，不显示能力名', () => {
    expect(composedNote(OUT)).toBe('已写好 · 模型 deepseek-chat')
    expect(composedNote({ ...OUT, mode: 'expand' })).toBe('已扩写 · 模型 deepseek-chat')
    // 能力名（chat-general）一个字都不该出现在这行里（核心原则 6）
    expect(composedNote(OUT)).not.toContain('chat-general')
  })
})

describe('默认开关', () => {
  it('英文 · 要负向 · 不留占位', () => {
    // 多数时候用户要的是一条能直接用的提示词，不是又一个还得填空的模板
    expect(COMPOSE_DEFAULTS).toEqual({ language: 'en', withNegative: true, withVariables: false })
  })
})
