/* 模板变量的前端侧算法。

   这几条与服务端 `domain/studio_prompts` 是同一套口径：名单由正文派生、
   双花括号才算占位、声明只带说明。前端算是为了让编辑器打字时就显示变量，
   服务端保存时会再派生一遍——两边判据不一致的话，用户会看到「编辑器里有这个变量、
   存完就没了」，所以这里逐条钉住。 */

import { describe, expect, it } from 'vitest'

import {
  extractVariableNames,
  hasUnfilledPlaceholders,
  mergeVariables,
  toRenderValues,
  variableSchema,
} from './prompt-variables'
import { describeSchema, schemaDefaults, validateFields } from './SchemaForm'

describe('占位提取', () => {
  it('按首次出现顺序去重', () => {
    expect(extractVariableNames('{{a}} {{b}} {{a}}')).toEqual(['a', 'b'])
  })

  it('正文与负向合起来算，顺序按先正文后负向', () => {
    expect(extractVariableNames('{{who}}', 'no {{avoid}}, no {{who}}')).toEqual(['who', 'avoid'])
  })

  it('单花括号不是占位', () => {
    // 提示词里贴 JSON 是常事，`{"seed": 1}` 被当成变量的话整段正文就废了
    expect(extractVariableNames('{"seed": 1} and {{seed}}')).toEqual(['seed'])
  })

  it('允许占位内侧留空格', () => {
    expect(extractVariableNames('{{  subject  }}')).toEqual(['subject'])
  })

  it('不合法的名字不算占位', () => {
    expect(extractVariableNames('{{1st}} {{a-b}} {{ok_1}}')).toEqual(['ok_1'])
  })

  it('中文名字算占位', () => {
    // 界面上的例子写的就是 `{{主体}}`，内置模板迁入时也用它替掉了蓝本的 `[主体]`。
    // 只认 ASCII 的话，照着例子写的占位既不进名单也不报错，套用时原样发给模型
    expect(extractVariableNames('画 {{主体}}，避免 {{要避开的}}')).toEqual(['主体', '要避开的'])
    expect(extractVariableNames('{{阶段一}} {{阶段二}}')).toEqual(['阶段一', '阶段二'])
  })

  it('中文名字里的数字只能在后面', () => {
    expect(extractVariableNames('{{1格}} {{格1}}')).toEqual(['格1'])
  })

  it('带中文占位的正文照样拦得下来', () => {
    expect(hasUnfilledPlaceholders('a 3x3 grid of {{主体}}')).toBe(true)
  })
})

describe('声明对齐', () => {
  const declared = [
    { name: 'subject', label: '主体', description: '拍什么', default: 'a cat', required: false },
    { name: 'ghost', label: '幽灵', description: '', default: '', required: true },
  ]

  it('保留人写的说明', () => {
    const merged = mergeVariables('a photo of {{subject}}', '', declared)
    expect(merged).toEqual([
      { name: 'subject', label: '主体', description: '拍什么', default: 'a cat', required: false },
    ])
  })

  it('正文里没有的声明会被丢掉', () => {
    const merged = mergeVariables('a photo of {{subject}}', '', declared)
    expect(merged.some((item) => item.name === 'ghost')).toBe(false)
  })

  it('新出现的占位默认必填', () => {
    const merged = mergeVariables('{{subject}} in {{place}}', '', declared)
    expect(merged.map((item) => item.name)).toEqual(['subject', 'place'])
    expect(merged[1].required).toBe(true)
  })
})

describe('交给 SchemaForm 的 schema', () => {
  const variables = [
    { name: 'subject', label: '主体', description: '拍什么', default: 'a cat', required: true },
    { name: 'mood', label: '', description: '', default: '', required: false },
  ]

  it('必填项进 required，标签留空就用变量名', () => {
    const schema = variableSchema(variables)
    expect(schema.required).toEqual(['subject'])
    const fields = describeSchema(schema)
    expect(fields.map((f) => f.label)).toEqual(['主体', 'mood'])
    expect(fields.map((f) => f.required)).toEqual([true, false])
  })

  it('默认值成为表单初值', () => {
    const fields = describeSchema(variableSchema(variables))
    expect(schemaDefaults(fields)).toEqual({ subject: 'a cat' })
  })

  it('必填项留空时表单自己就能拦下', () => {
    const fields = describeSchema(variableSchema(variables))
    const issues = validateFields(fields, {})
    expect(issues.map((issue) => issue.label)).toEqual(['主体'])
  })
})

describe('套用前的最后一道闸', () => {
  it('正文里还有占位就不许直接插', () => {
    expect(hasUnfilledPlaceholders('a photo of {{subject}}', '')).toBe(true)
  })

  it('负向里的占位同样算', () => {
    expect(hasUnfilledPlaceholders('a photo', 'no {{avoid}}')).toBe(true)
  })

  it('渲染完的正文放行', () => {
    expect(hasUnfilledPlaceholders('a photo of a fox', 'no blur')).toBe(false)
  })

  it('只看 variables 不够：旧缓存里 variables 是空的、正文里却还有占位', () => {
    // 这一条是真会发生的：条目缓存早于服务端补上 variables 字段那一版
    const stale = { body: 'a photo of {{subject}}', negative: '', variables: [] }
    expect(stale.variables.length > 0).toBe(false)
    expect(hasUnfilledPlaceholders(stale.body, stale.negative)).toBe(true)
  })
})

describe('表单值转接口值', () => {
  it('丢掉空值键，非字符串按 JSON 转', () => {
    expect(toRenderValues({ a: 'x', b: undefined, c: null, d: 3 })).toEqual({ a: 'x', d: '3' })
  })
})
