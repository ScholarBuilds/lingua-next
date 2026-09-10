/* 编排页的草稿 ↔ 定义互转。

   两个约束在这里钉住：
   - 序列化向后兼容：工具节点不写 `kind`，没设的策略字段一个都不写进 JSON，
     旧定义读进来再存回去不会凭空长出字段；
   - 服务端 `model_dump` 会把没设的字段写成 null（retry / over / flow_id / name …），
     读的一侧直接 `String(null)` 会在表单里显示成 "null"，改一下再存就把脏值落库了。 */

import { describe, expect, it } from 'vitest'

import {
  blankDraft,
  definitionOf,
  draftToNode,
  expressionText,
  nodeToDraft,
  resumeShape,
} from './FlowComposerPage'
import type { DraftNode } from './FlowComposerPage'
import type { StudioFlowNode } from '../../lib/api-studio'

function draft(patch: Partial<DraftNode>): DraftNode {
  return { ...blankDraft(1), ...patch }
}

/** 服务端读回来的节点：pydantic 把没设的字段一律 dump 成 null */
function dumped(node: Record<string, unknown>): StudioFlowNode {
  return {
    id: 'step-1',
    kind: 'tool',
    tool_id: null,
    operation: null,
    input: {},
    source_context: {},
    when: null,
    on_failure: 'fail_run',
    retry: null,
    timeout_s: null,
    over: null,
    template: null,
    flow_id: null,
    inputs: null,
    name: null,
    schema: null,
    value: null,
    ...node,
  } as unknown as StudioFlowNode
}

describe('草稿 → 定义', () => {
  it('工具节点不写 kind，缺省策略字段一个都不写', () => {
    expect(draftToNode(draft({ id: 'gen', toolId: 'infinite-canvas', operation: 'image.generate' })))
      .toEqual({
        id: 'gen',
        tool_id: 'infinite-canvas',
        operation: 'image.generate',
        input: { prompt: { $input: 'prompt' } },
      })
  })

  it('执行策略只写用户真的改过的那几项', () => {
    const node = draftToNode(draft({
      id: 'gen',
      when: '$input.retouch',
      onFailure: 'skip_downstream',
      retryMax: '2',
      retryBackoff: '1500',
      timeoutS: '600',
    }))
    expect(node).toMatchObject({
      when: '$input.retouch',
      on_failure: 'skip_downstream',
      retry: { max: 2, backoff_ms: 1500 },
      timeout_s: 600,
    })
  })

  it('批量展开把工具字段挪进 template', () => {
    const node = draftToNode(draft({
      id: 'fan',
      kind: 'map',
      over: '{"$input":"items"}',
      operation: 'image.generate',
      rawInput: true,
      inputText: '{"prompt":{"$item":"text"}}',
    }))
    expect(node).toEqual({
      id: 'fan',
      kind: 'map',
      over: { $input: 'items' },
      template: {
        id: 'fan',
        tool_id: 'infinite-canvas',
        operation: 'image.generate',
        input: { prompt: { $item: 'text' } },
      },
    })
  })

  it('子工作流、运行参数与运行产出各写各的字段', () => {
    expect(draftToNode(draft({ id: 'sub', kind: 'subflow', flowId: '12', inputsText: '{"a":1}' })))
      .toEqual({ id: 'sub', kind: 'subflow', flow_id: 12, inputs: { a: 1 } })
    expect(draftToNode(draft({
      id: 'ask',
      kind: 'input',
      name: 'prompt',
      schemaText: '{"type":"string","title":"提示词"}',
    }))).toEqual({
      id: 'ask',
      kind: 'input',
      name: 'prompt',
      schema: { type: 'string', title: '提示词' },
    })
    expect(draftToNode(draft({
      id: 'out',
      kind: 'output',
      name: 'assets',
      valueText: '{"$node":"gen","path":"asset_ids"}',
    }))).toEqual({
      id: 'out',
      kind: 'output',
      name: 'assets',
      value: { $node: 'gen', path: 'asset_ids' },
    })
  })

  it('缺了这一类节点的必填项就直接拒，不要生成半个定义', () => {
    expect(() => draftToNode(draft({ id: '  ' }))).toThrow('节点 id 不能为空')
    expect(() => draftToNode(draft({ kind: 'map', over: '' }))).toThrow('展开来源不能为空')
    expect(() => draftToNode(draft({ kind: 'subflow', flowId: 'abc' }))).toThrow('必须是正整数')
    expect(() => draftToNode(draft({ kind: 'input', name: '' }))).toThrow('字段名不能为空')
    expect(() => draftToNode(draft({ kind: 'output', name: 'x', valueText: '' })))
      .toThrow('产出取值不能为空')
    expect(() => draftToNode(draft({ rawInput: true, inputText: '{oops' }))).toThrow('JSON 无法解析')
  })
})

describe('定义 → 草稿', () => {
  it('服务端 dump 的 null 不会渗进表单文本', () => {
    const back = nodeToDraft(dumped({ tool_id: 'infinite-canvas', operation: 'image.generate' }))
    expect(back).toMatchObject({
      kind: 'tool',
      when: '',
      retryMax: '',
      retryBackoff: '',
      timeoutS: '',
      over: '',
      flowId: '',
      name: '',
      valueText: '',
      inputsText: '{}',
    })
    expect(back.schemaText).toContain('文本参数')
    // source_context 是 default_factory=dict，dump 出来是 {}；老行可能是 null，两种都不该留下 null
    expect(nodeToDraft(dumped({ source_context: null })).sourceContext).toBeUndefined()
  })

  it('没有 kind 的历史定义按工具节点读，转一圈存回去还是原样', () => {
    const legacy: StudioFlowNode = {
      id: 'gen',
      tool_id: 'infinite-canvas',
      operation: 'image.generate',
      input: { prompt: '一只橘猫' },
    }
    expect(draftToNode(nodeToDraft(legacy))).toEqual(legacy)
  })

  it('五类节点转一圈都不变形', () => {
    const nodes: StudioFlowNode[] = [
      { id: 'ask', kind: 'input', name: 'prompt', schema: { type: 'string' } },
      {
        id: 'gen',
        tool_id: 'infinite-canvas',
        operation: 'image.generate',
        input: { prompt: { $input: 'prompt' } },
        retry: { max: 1, backoff_ms: 0 },
      },
      {
        id: 'fan',
        kind: 'map',
        over: { $input: 'items' },
        template: {
          id: 'fan',
          tool_id: 'infinite-canvas',
          operation: 'image.generate',
          input: {},
        },
      },
      { id: 'sub', kind: 'subflow', flow_id: 3, inputs: {} },
      { id: 'out', kind: 'output', name: 'assets', value: { $node: 'gen' } },
    ]
    const edges = [{ from: 'ask', to: 'gen' }]
    expect(definitionOf(nodes.map(nodeToDraft), edges)).toEqual({ nodes, edges })
  })

  it('map 的工具字段从 template 上取', () => {
    const back = nodeToDraft({
      id: 'fan',
      kind: 'map',
      over: { $input: 'items' },
      template: { tool_id: 'infinite-canvas', operation: 'chat.general', input: { text: 'x' } },
    })
    expect(back.operation).toBe('chat.general')
    expect(back.input).toEqual({ text: 'x' })
    expect(back.over).toBe('{\n  "$input": "items"\n}')
  })
})

describe('等待输入的表单形状', () => {
  it('单值 schema 包一层，提交前按 unwrap 拆回去', () => {
    expect(resumeShape({ type: 'string', title: '改写后的文案' }, 'copy')).toEqual({
      schema: {
        type: 'object',
        properties: { copy: { type: 'string', title: '改写后的文案' } },
        required: ['copy'],
      },
      unwrap: 'copy',
    })
  })

  it('本身就是对象契约的原样用', () => {
    const schema = { type: 'object', properties: { a: { type: 'string' } } }
    expect(resumeShape(schema, 'ask')).toEqual({ schema, unwrap: null })
  })
})

describe('表达式文本', () => {
  it('会被重新解析成别的类型的字符串要补引号', () => {
    expect(expressionText('$input.items')).toBe('$input.items')
    expect(expressionText('123')).toBe('"123"')
    expect(expressionText('true')).toBe('"true"')
    expect(expressionText(undefined)).toBe('')
    expect(expressionText({ $node: 'gen' })).toBe('{\n  "$node": "gen"\n}')
  })
})
