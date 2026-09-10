import { describe, expect, it } from 'vitest'

import { UNKNOWN_MODEL_TEXT, capabilityWithModel, modelText } from './model-label'

describe('modelText', () => {
  it('有真名就原样给真名', () => {
    expect(modelText('gpt-image-2')).toBe('gpt-image-2')
    expect(modelText('  deepseek-chat  ')).toBe('deepseek-chat')
  })

  it('没有真名如实说没有，不编一个出来', () => {
    expect(modelText(null)).toBe(UNKNOWN_MODEL_TEXT)
    expect(modelText(undefined)).toBe(UNKNOWN_MODEL_TEXT)
    expect(modelText('   ')).toBe(UNKNOWN_MODEL_TEXT)
  })
})

describe('capabilityWithModel', () => {
  it('能力用中文标签，模型用上游真名，中间一个点', () => {
    expect(capabilityWithModel('修复代理', 'deepseek-chat')).toBe('修复代理 · deepseek-chat')
    expect(capabilityWithModel('插图', 'gpt-image-2')).toBe('插图 · gpt-image-2')
  })

  it('能力标签缺失时只显示模型名，不回落到能力 slug', () => {
    expect(capabilityWithModel('', 'gpt-image-2')).toBe('gpt-image-2')
    expect(capabilityWithModel(null, 'gpt-image-2')).toBe('gpt-image-2')
  })

  it('能力有标签但没绑模型时，模型位如实标未绑定', () => {
    expect(capabilityWithModel('快速翻译', null)).toBe(`快速翻译 · ${UNKNOWN_MODEL_TEXT}`)
  })

  it('两头都空时只剩占位，任何情况下都不会吐出能力 slug', () => {
    const text = capabilityWithModel(null, null)
    expect(text).toBe(UNKNOWN_MODEL_TEXT)
    expect(text).not.toContain('-')
  })
})
