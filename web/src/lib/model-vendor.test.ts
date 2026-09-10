import { describe, expect, it } from 'vitest'

import { NON_CHAT_VENDOR, UNKNOWN_VENDOR, compareModelName, vendorOf, vendorRank } from './model-vendor'

/** 开发库 GET /config/bindings 里 deployment_options 的全部 46 条（2026-09-06 实测） */
const REAL_MODELS: Array<[string, string]> = [
  ['gpt-5.2', 'openai'],
  ['gpt-5.4-mini', 'openai'],
  ['gpt-5.6-luna', 'openai'],
  ['gpt-5.3-codex-spark', 'openai'],
  ['codex-auto-review', 'openai'],
  ['deepseek-chat', 'deepseek'],
  ['deepseek-v4-flash', 'deepseek'],
  ['deepseek-v4-flash-vision-exp', 'deepseek'],
  ['deepseek-v4-pro', 'deepseek'],
  ['glm-3-turbo', 'zhipu'],
  ['glm-4v-plus', 'zhipu'],
  ['glm-5.2', 'zhipu'],
  ['qwen3.8-max', 'qwen'],
  ['k3-256k', 'moonshot'],
  ['kimi-for-coding', 'moonshot'],
  ['MiniMax-M2.7', 'minimax'],
  ['MiniMax-M3', 'minimax'],
  ['embedding-3', 'non-chat'],
  ['auto', 'unknown'],
]

describe('vendorOf', () => {
  it.each(REAL_MODELS)('%s → %s', (model, key) => {
    expect(vendorOf(model).key).toBe(key)
  })

  it('大小写与空白不影响判定', () => {
    expect(vendorOf('  GPT-5.4  ').key).toBe('openai')
    expect(vendorOf('MINIMAX-M3').key).toBe('minimax')
  })

  it('空名字归「其它」而不是抛错', () => {
    expect(vendorOf('').key).toBe(UNKNOWN_VENDOR.key)
    expect(vendorOf('   ').key).toBe(UNKNOWN_VENDOR.key)
  })

  it('嵌入模型不进对话厂商组——它出现在对话模型列表里就是个坑', () => {
    expect(vendorOf('text-embedding-3-large').key).toBe(NON_CHAT_VENDOR.key)
    expect(vendorOf('bge-m3').key).toBe(NON_CHAT_VENDOR.key)
  })

  it('前缀相近的两家不互相抢：codestral 属 Mistral 不属 Cohere', () => {
    expect(vendorOf('codestral-latest').key).toBe('mistral')
    expect(vendorOf('command-r-plus').key).toBe('cohere')
  })

  it('o 系列要挡住 ollama / openrouter 这类不是模型名的串', () => {
    expect(vendorOf('o3-mini').key).toBe('openai')
    expect(vendorOf('o1').key).toBe('openai')
    expect(vendorOf('ollama-local').key).toBe(UNKNOWN_VENDOR.key)
  })
})

describe('vendorRank', () => {
  it('非对话垫底，其它次之，认得出的排前面', () => {
    expect(vendorRank('openai')).toBeLessThan(vendorRank(UNKNOWN_VENDOR.key))
    expect(vendorRank(UNKNOWN_VENDOR.key)).toBeLessThan(vendorRank(NON_CHAT_VENDOR.key))
  })
})

describe('compareModelName', () => {
  it('新版本在前——用户要的几乎总是最新那个', () => {
    expect([...['glm-4', 'glm-5.2', 'glm-4.7']].sort(compareModelName)).toEqual([
      'glm-5.2',
      'glm-4.7',
      'glm-4',
    ])
    expect([...['gpt-5.2', 'gpt-5.6', 'gpt-5.4']].sort(compareModelName)).toEqual([
      'gpt-5.6',
      'gpt-5.4',
      'gpt-5.2',
    ])
  })

  it('同版本按名字，不靠字典序把 5.10 排到 5.2 前面', () => {
    expect(compareModelName('glm-5.10', 'glm-5.2')).toBeLessThan(0)
  })

  it('没有数字的名字排在有数字的之后，且不抛错', () => {
    expect([...['auto', 'gpt-5.4']].sort(compareModelName)).toEqual(['gpt-5.4', 'auto'])
  })
})
