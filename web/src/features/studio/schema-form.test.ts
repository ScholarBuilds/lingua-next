/* SchemaForm：控件判定、渲染与校验。

   契约取自 pydantic `model_json_schema()` 的真实形状——可选字段是 `anyOf` 带 null 分支，
   嵌套模型走 `$ref`/`$defs`，`Literal` 落成 enum。这几种壳子拆错的话，
   表单不会报错，只会静默把一个本该出选择器的字段渲染成 JSON 文本框。

   本仓 vitest 跑在 node 环境（没有 jsdom），所以渲染断言走 `renderToStaticMarkup`：
   够验证「哪个字段出哪个控件、约束有没有落到 DOM 属性上」，不涉及交互。 */

import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import {
  SchemaForm,
  constraintHint,
  describeSchema,
  isExpression,
  resolveSchema,
  schemaDefaults,
  validateFields,
} from './SchemaForm'
import type { JsonSchema, SchemaFieldSpec, SchemaIssue } from './SchemaForm'

const CONTRACT: JsonSchema = {
  type: 'object',
  title: 'ImageGenerateInput',
  $defs: {
    Layout: {
      type: 'object',
      title: 'Layout',
      properties: {
        canvas: { type: 'string', title: '画布', default: '1:1' },
        margin: { type: 'integer', title: '留白', minimum: 0, maximum: 64 },
      },
      required: ['margin'],
    },
  },
  properties: {
    prompt: { type: 'string', title: '提示词', minLength: 2, maxLength: 800 },
    title: { type: 'string', title: '标题', maxLength: 40, pattern: '^[A-Za-z ]+$' },
    quality: {
      anyOf: [{ type: 'string', enum: ['low', 'medium', 'high'] }, { type: 'null' }],
      title: '质量',
      default: 'high',
    },
    count: { type: 'integer', title: '张数', minimum: 1, maximum: 8, default: 1 },
    scale: { type: 'number', title: '倍率', minimum: 0.5, maximum: 2 },
    transparent: { type: 'boolean', title: '透明底', default: false },
    tags: { type: 'array', items: { type: 'string' }, title: '标签', maxItems: 3 },
    ref_asset_ids: { type: 'array', items: { type: 'integer' }, title: '参考图' },
    cover_media_asset_id: {
      anyOf: [{ type: 'integer' }, { type: 'null' }],
      title: '封面视频',
      description: 'media: 取一条已入库视频',
    },
    layout: { $ref: '#/$defs/Layout', title: '版式' },
    extra: { anyOf: [{ type: 'string' }, { type: 'object' }], title: '附加' },
  },
  required: ['prompt', 'count', 'ref_asset_ids'],
}

const FILLED: Record<string, unknown> = {
  prompt: '一只在窗台上的橘猫',
  title: 'Orange Cat',
  quality: 'high',
  count: 2,
  scale: 1.5,
  transparent: true,
  tags: ['sky', 'cat'],
  ref_asset_ids: [7],
  cover_media_asset_id: 31,
  layout: { canvas: '9:16', margin: 12 },
  extra: { note: '手写' },
}

function render(
  schema: JsonSchema | undefined,
  value: Record<string, unknown>,
  issues: SchemaIssue[] = [],
): string {
  return renderToStaticMarkup(
    createElement(SchemaForm, { schema, value, issues, onChange: () => undefined }),
  )
}

function field(key: string): SchemaFieldSpec {
  const found = describeSchema(CONTRACT).find((item) => item.key === key)
  if (found === undefined) throw new Error(`契约里没有字段 ${key}`)
  return found
}

describe('控件判定', () => {
  it('按 pydantic 契约拆出六类控件，拆不动的落 json', () => {
    expect(describeSchema(CONTRACT).map((item) => [item.key, item.control])).toEqual([
      ['prompt', 'multiline'],
      ['title', 'text'],
      ['quality', 'enum'],
      ['count', 'number'],
      ['scale', 'number'],
      ['transparent', 'boolean'],
      ['tags', 'chips'],
      ['ref_asset_ids', 'reference'],
      ['cover_media_asset_id', 'reference'],
      ['layout', 'object'],
      ['extra', 'json'],
    ])
  })

  it('anyOf 的 null 分支只影响可空，不影响控件', () => {
    const quality = field('quality')
    expect(quality.nullable).toBe(true)
    expect(quality.required).toBe(false)
    expect(quality.options).toEqual(['low', 'medium', 'high'])
    expect(quality.fallback).toBe('high')
  })

  it('$ref 展开成嵌套字段，路径带上父级', () => {
    const layout = field('layout')
    expect(layout.label).toBe('版式')
    expect(layout.fields.map((item) => [item.path, item.control])).toEqual([
      ['layout.canvas', 'text'],
      ['layout.margin', 'number'],
    ])
  })

  it('引用型按 x-ref、描述前缀与字段名三级判定', () => {
    expect(field('ref_asset_ids').reference).toBe('asset')
    expect(field('ref_asset_ids').multiple).toBe(true)
    expect(field('cover_media_asset_id').reference).toBe('media')
    expect(field('cover_media_asset_id').multiple).toBe(false)
    const marked = describeSchema({
      type: 'object',
      properties: { cover: { type: 'integer', 'x-ref': 'asset' } },
    })
    expect(marked[0].reference).toBe('asset')
  })

  it('剩多个非 null 分支就不猜，留给 JSON 文本框', () => {
    const resolved = resolveSchema(
      { anyOf: [{ type: 'string' }, { type: 'object' }] },
      CONTRACT,
    )
    expect(resolved.ambiguous).toBe(true)
    expect(field('extra').control).toBe('json')
  })

  it('默认值只铺 default 与必填空壳，可选项一律缺省', () => {
    expect(schemaDefaults(describeSchema(CONTRACT))).toEqual({
      prompt: '',
      quality: 'high',
      count: 1,
      transparent: false,
      ref_asset_ids: [],
      layout: { canvas: '1:1', margin: 0 },
    })
  })

  it('约束摘要只讲这个控件用得上的那几条', () => {
    expect(constraintHint(field('count'))).toBe('1 ~ 8')
    expect(constraintHint(field('title'))).toBe('最多 40 字 · ^[A-Za-z ]+$')
    expect(constraintHint(field('quality'))).toBe('可留空')
    expect(constraintHint(field('tags'))).toBe('最多 3 项')
  })
})

describe('渲染', () => {
  const html = render(CONTRACT, FILLED)

  it('长文本出多行框，短文本出单行并带上长度上限', () => {
    expect(html).toContain('<textarea class="sfm-textarea"')
    expect(html).toContain('一只在窗台上的橘猫')
    expect(html).toContain('<input class="sfm-input" maxLength="40" value="Orange Cat"/>')
  })

  it('枚举出选择器，数值出带区间与步进的数字框', () => {
    expect(html).toContain('role="combobox"')
    expect(html).toContain('aria-label="质量"')
    expect(html).toContain('<input class="sfm-input" type="number" min="1" max="8" step="1" value="2"/>')
    expect(html).toContain('step="0.1"')
  })

  it('布尔出开关，列表出芯片', () => {
    expect(html).toContain('<label class="sfm-bool"><input type="checkbox" checked=""/><span>开</span>')
    expect(html).toContain('<span class="sfm-chip">sky')
    expect(html).toContain('<span class="sfm-chip">cat')
    expect(html).toContain('placeholder="输入后回车"')
  })

  it('引用型出取图按钮与已选 id', () => {
    expect(html).toContain('<div class="sfm-ref">')
    expect(html).toContain('<span class="sfm-chip">#7')
    expect(html).toContain('选图')
    expect(html).toContain('选媒体')
  })

  it('嵌套对象折叠成一段，子字段照常出控件', () => {
    expect(html).toContain('<details class="sfm-object"><summary>版式 · 2 个子字段</summary>')
    expect(html).toContain('value="9:16"')
    expect(html).toContain('max="64"')
  })

  it('未知类型回落 JSON 文本框，整份 schema 没字段时整表单回落', () => {
    expect(html).toContain('<div class="sfm-json">')
    expect(html).toContain('placeholder="留空 = 不传这个字段"')

    const bare = render({ type: 'object' }, { anything: 1 })
    expect(bare).toContain('<p class="sfm-empty">这个能力没有声明字段，直接写 JSON</p>')
    expect(bare).toContain('&quot;anything&quot;: 1')

    const missing = render(undefined, {})
    expect(missing).toContain('class="sfm-empty"')
  })

  it('值是上游引用时切引用模式，不拿控件洗掉表达式', () => {
    const expressed = render(CONTRACT, { ...FILLED, count: { $node: 'draft', path: 'count' } })
    expect(expressed).toContain('sfm-mode sfm-mode-on')
    expect(expressed).toContain('&quot;$node&quot;: &quot;draft&quot;')
    expect(expressed).not.toContain('type="number" min="1" max="8" step="1"')
  })

  it('校验结果按 path 挂到对应字段下', () => {
    const marked = render(CONTRACT, FILLED, [
      { path: 'count', label: '张数', message: '不能大于 8' },
    ])
    expect(marked).toContain('<p class="sfm-error">不能大于 8</p>')
  })
})

describe('校验', () => {
  const fields = describeSchema(CONTRACT)
  const check = (value: Record<string, unknown>): SchemaIssue[] => validateFields(fields, value)

  it('必填缺失逐条报出来，可选项缺省不算错', () => {
    expect(check({}).map((issue) => [issue.path, issue.message])).toEqual([
      ['prompt', '必填'],
      ['count', '必填'],
      ['ref_asset_ids', '必填'],
    ])
  })

  it('文本按长度、枚举、正则判', () => {
    const issues = check({ ...FILLED, prompt: 'a', title: '中文名', quality: 'ultra' })
    expect(issues.map((issue) => issue.message)).toEqual([
      '至少 2 个字符',
      '不符合格式 ^[A-Za-z ]+$',
      '取值必须是 low / medium / high',
    ])
  })

  it('数值判区间与整数', () => {
    expect(check({ ...FILLED, count: 12 })[0].message).toBe('不能大于 8')
    expect(check({ ...FILLED, count: 1.5 })[0].message).toBe('应为整数')
    expect(check({ ...FILLED, scale: '1.5' })[0].message).toBe('应为数字')
  })

  it('布尔与列表判类型、元素与数量', () => {
    expect(check({ ...FILLED, transparent: 'yes' })[0].message).toBe('应为开关值')
    expect(check({ ...FILLED, tags: [1, 2] })[0].message).toBe('每一项都应是文本')
    expect(check({ ...FILLED, tags: ['a', 'b', 'c', 'd'] })[0].message).toBe('最多 3 项')
    expect(check({ ...FILLED, ref_asset_ids: [1.5] })[0].message).toBe('每一项都应是整数')
    expect(check({ ...FILLED, cover_media_asset_id: 'abc' })[0].message).toBe('资产 id 应为数字')
  })

  it('嵌套对象的错带完整路径', () => {
    expect(check({ ...FILLED, layout: '9:16' })).toEqual([
      { path: 'layout', label: '版式', message: '应为对象' },
    ])
    expect(check({ ...FILLED, layout: { canvas: '9:16', margin: 999 } })).toEqual([
      { path: 'layout.margin', label: '留白', message: '不能大于 64' },
    ])
  })

  it('表达式一律放行——真值要等运行时解析才知道', () => {
    expect(isExpression({ $input: 'prompt' })).toBe(true)
    expect(isExpression({ $incoming: 'asset_ids' })).toBe(true)
    expect(isExpression({ prompt: 'x' })).toBe(false)
    expect(check({
      prompt: { $input: 'prompt' },
      count: { $node: 'plan', path: 'count' },
      ref_asset_ids: { $incoming: 'asset_ids' },
      tags: [{ $item: 'tag' }],
      layout: { canvas: { $input: 'canvas' }, margin: { $input: 'margin' } },
    })).toEqual([])
  })
})
