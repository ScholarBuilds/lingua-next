/* JSON Schema 表单。
 *
 * 工具能力的 `input_schema` 由服务端 pydantic 模型直出（`model_json_schema()`），
 * 所以这里要吃的是 pydantic 的真实形状：可选字段是 `anyOf:[{...},{type:'null'}]`，
 * 嵌套模型是 `$ref:'#/$defs/Xxx'`，`Literal` 是分支里的 `enum`。先把这些拆平，
 * 再决定用哪个控件——控件只有六类，其余一律回落到 JSON 文本框，
 * 宁可让人手写也不猜错（BR-110 不伪造）。
 *
 * DAG 节点的输入里混着表达式（`{"$input":"prompt"}`、`{"$node":...}`），
 * 它们不是字面值，任何控件都表达不了。所以每个字段都能切到「引用」模式，
 * 切过去就是一个原样 JSON 输入框，表单不会把表达式洗成空字符串。
 *
 * 校验自己写：schema 只用到 enum / 长度 / 数值区间 / 正则 / 元素类型这几条，
 * 为此引 ajv（含依赖 ~120KB）不划算，而且 ajv 的错误信息是英文 JSON Pointer，
 * 还得再翻一层。
 */

import { useMemo, useState } from 'react'
import { Braces, ImagePlus, Sigma, Video, X } from '@/components/NexusIcon'

import { Picker } from '@/components/ui/picker'

import { AssetPicker } from './AssetPicker'
import { MediaAssetPicker } from './MediaAssetPicker'

export type JsonSchema = Record<string, unknown>

export type SchemaControl =
  | 'text'
  | 'multiline'
  | 'enum'
  | 'number'
  | 'boolean'
  | 'chips'
  | 'object'
  | 'reference'
  | 'json'

export interface SchemaFieldSpec {
  key: string
  /** 点分路径，嵌套对象里用来定位错误 */
  path: string
  label: string
  description: string
  control: SchemaControl
  required: boolean
  nullable: boolean
  /** schema 里的 default，没有则 undefined */
  fallback: unknown
  options: string[]
  integer: boolean
  minimum: number | null
  maximum: number | null
  step: number | null
  minLength: number | null
  maxLength: number | null
  minItems: number | null
  maxItems: number | null
  pattern: string
  format: string
  itemKind: 'string' | 'integer' | 'number' | null
  reference: 'asset' | 'media' | null
  /** 列表型：reference 可多选、chips 恒为 true */
  multiple: boolean
  fields: SchemaFieldSpec[]
  schema: JsonSchema
}

export interface SchemaIssue {
  path: string
  label: string
  message: string
}

/** 超过这个长度的字符串按段落输入，短的用单行 */
const MULTILINE_AT = 400

/** DAG 表达式的保留键。命中任一即视为引用，不做字面校验 */
const EXPRESSION_KEYS = ['$input', '$node', '$incoming', '$artifacts', '$item', '$index']

function asRecord(value: unknown): JsonSchema | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as JsonSchema)
    : null
}

function readString(schema: JsonSchema, key: string): string {
  const value = schema[key]
  return typeof value === 'string' ? value : ''
}

function readNumber(schema: JsonSchema, key: string): number | null {
  const value = schema[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/** 表达式值不是字面量，表单不碰也不校验 */
export function isExpression(value: unknown): boolean {
  const record = asRecord(value)
  if (record === null) return false
  return EXPRESSION_KEYS.some((key) => key in record)
}

/** 展开 `$ref` 与单元素 `allOf`；同名键以引用点上的为准（pydantic 在这里放 default/title） */
export function resolveRef(schema: JsonSchema, root: JsonSchema): JsonSchema {
  let current = schema
  for (let hop = 0; hop < 8; hop += 1) {
    const ref = current.$ref
    if (typeof ref !== 'string' || !ref.startsWith('#/$defs/')) break
    const defs = asRecord(root.$defs)
    const target = defs === null ? null : asRecord(defs[ref.slice('#/$defs/'.length)])
    if (target === null) break
    const merged: JsonSchema = { ...target }
    for (const [key, value] of Object.entries(current)) {
      if (key !== '$ref') merged[key] = value
    }
    current = merged
  }
  const all = current.allOf
  if (Array.isArray(all) && all.length === 1) {
    const single = asRecord(all[0])
    if (single !== null) {
      const merged: JsonSchema = { ...resolveRef(single, root) }
      for (const [key, value] of Object.entries(current)) {
        if (key !== 'allOf') merged[key] = value
      }
      current = merged
    }
  }
  return current
}

export interface ResolvedSchema {
  schema: JsonSchema
  nullable: boolean
  /** 去掉 null 分支后还剩多个分支（`str | dict | None` 这种），控件表达不了 */
  ambiguous: boolean
}

/** 拆 `anyOf`/`oneOf`：只剩一个非 null 分支时把它提上来，同时记住这个字段可空 */
export function resolveSchema(raw: JsonSchema, root: JsonSchema): ResolvedSchema {
  const schema = resolveRef(raw, root)
  const branches = Array.isArray(schema.anyOf)
    ? schema.anyOf
    : Array.isArray(schema.oneOf)
      ? schema.oneOf
      : null
  if (branches === null) {
    return { schema, nullable: schema.type === 'null', ambiguous: false }
  }
  const kept: JsonSchema[] = []
  let nullable = false
  for (const branch of branches) {
    const item = asRecord(branch)
    if (item === null) continue
    const resolved = resolveRef(item, root)
    if (resolved.type === 'null') {
      nullable = true
      continue
    }
    kept.push(resolved)
  }
  if (kept.length !== 1) return { schema, nullable, ambiguous: true }
  const merged: JsonSchema = { ...kept[0] }
  for (const [key, value] of Object.entries(schema)) {
    if (key !== 'anyOf' && key !== 'oneOf') merged[key] = value
  }
  return { schema: merged, nullable, ambiguous: false }
}

/** 资产引用字段：显式 `x-ref` 优先，其次描述里的 `asset:` / `media:`，最后按字段名兜底 */
export function referenceKind(key: string, schema: JsonSchema): 'asset' | 'media' | null {
  const marker = readString(schema, 'x-ref')
  if (marker === 'asset' || marker === 'media') return marker
  const description = readString(schema, 'description')
  if (description.includes('media:')) return 'media'
  if (description.includes('asset:')) return 'asset'
  if (/media_asset_ids?$/.test(key)) return 'media'
  if (/asset_ids?$/.test(key)) return 'asset'
  return null
}

function enumOptions(schema: JsonSchema): string[] {
  const values = schema.enum
  if (Array.isArray(values)) {
    return values
      .filter((item): item is string | number => typeof item === 'string' || typeof item === 'number')
      .map((item) => String(item))
  }
  const single = schema.const
  return typeof single === 'string' || typeof single === 'number' ? [String(single)] : []
}

function itemKindOf(schema: JsonSchema, root: JsonSchema): 'string' | 'integer' | 'number' | null {
  const items = asRecord(schema.items)
  if (items === null) return null
  const resolved = resolveSchema(items, root)
  if (resolved.ambiguous) return null
  const type = resolved.schema.type
  return type === 'string' || type === 'integer' || type === 'number' ? type : null
}

function controlOf(
  resolved: ResolvedSchema,
  options: string[],
  reference: 'asset' | 'media' | null,
  itemKind: 'string' | 'integer' | 'number' | null,
): SchemaControl {
  if (resolved.ambiguous) return 'json'
  const schema = resolved.schema
  const type = typeof schema.type === 'string' ? schema.type : ''
  if (options.length > 0) return 'enum'
  if (type === 'boolean') return 'boolean'
  if (type === 'integer' || type === 'number') return reference === null ? 'number' : 'reference'
  if (type === 'string') {
    const maxLength = readNumber(schema, 'maxLength')
    return maxLength !== null && maxLength >= MULTILINE_AT ? 'multiline' : 'text'
  }
  if (type === 'array') {
    if (reference !== null && itemKind === 'integer') return 'reference'
    return itemKind === null ? 'json' : 'chips'
  }
  if (type === 'object') {
    const properties = asRecord(schema.properties)
    return properties !== null && Object.keys(properties).length > 0 ? 'object' : 'json'
  }
  return 'json'
}

function fieldOf(
  key: string,
  raw: JsonSchema,
  root: JsonSchema,
  required: boolean,
  prefix: string,
): SchemaFieldSpec {
  const resolved = resolveSchema(raw, root)
  const schema = resolved.schema
  const options = enumOptions(schema)
  const reference = referenceKind(key, schema)
  const itemKind = itemKindOf(schema, root)
  const control = controlOf(resolved, options, reference, itemKind)
  const integer = schema.type === 'integer' || itemKind === 'integer'
  const path = prefix === '' ? key : `${prefix}.${key}`
  const multiple = schema.type === 'array'
  return {
    key,
    path,
    label: readString(schema, 'title') || key,
    description: readString(schema, 'description'),
    control,
    required,
    nullable: resolved.nullable,
    fallback: 'default' in schema ? schema.default : undefined,
    options,
    integer,
    minimum: readNumber(schema, 'minimum') ?? readNumber(schema, 'exclusiveMinimum'),
    maximum: readNumber(schema, 'maximum') ?? readNumber(schema, 'exclusiveMaximum'),
    step: readNumber(schema, 'multipleOf') ?? (integer ? 1 : 0.1),
    minLength: readNumber(schema, 'minLength'),
    maxLength: readNumber(schema, 'maxLength'),
    minItems: readNumber(schema, 'minItems'),
    maxItems: readNumber(schema, 'maxItems'),
    pattern: readString(schema, 'pattern'),
    format: readString(schema, 'format'),
    itemKind,
    reference,
    multiple,
    fields: control === 'object' ? describeSchema(schema, root, path) : [],
    schema,
  }
}

/** 顶层对象 schema → 字段列表。不是对象、或没有 properties 时返回空数组 */
export function describeSchema(
  schema: JsonSchema | undefined,
  root?: JsonSchema,
  prefix = '',
): SchemaFieldSpec[] {
  if (schema === undefined) return []
  const scope = root ?? schema
  const properties = asRecord(schema.properties)
  if (properties === null) return []
  const requiredKeys = new Set(
    (Array.isArray(schema.required) ? schema.required : []).filter(
      (item): item is string => typeof item === 'string',
    ),
  )
  const fields: SchemaFieldSpec[] = []
  for (const [key, value] of Object.entries(properties)) {
    const child = asRecord(value)
    if (child === null) continue
    fields.push(fieldOf(key, child, scope, requiredKeys.has(key), prefix))
  }
  return fields
}

function emptyValue(field: SchemaFieldSpec): unknown {
  switch (field.control) {
    case 'text':
    case 'multiline':
      return ''
    case 'enum':
      return field.options[0] ?? ''
    case 'number':
      return field.minimum ?? 0
    case 'boolean':
      return false
    case 'chips':
      return []
    case 'reference':
      return field.multiple ? [] : null
    case 'object':
      return schemaDefaults(field.fields)
    default:
      return {}
  }
}

/** 表单初值。schema 给了 default 就用 default；没有 default 的必填项给一个空壳，
 *  可选项一律缺省——少写一个键比写一个 null 更贴近「用上游默认」的语义 */
export function schemaDefaults(fields: SchemaFieldSpec[]): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const field of fields) {
    if (field.fallback !== undefined && field.fallback !== null) {
      out[field.key] = field.fallback
      continue
    }
    if (field.control === 'object') {
      const nested = schemaDefaults(field.fields)
      if (Object.keys(nested).length > 0 || field.required) out[field.key] = nested
      continue
    }
    if (field.required) out[field.key] = emptyValue(field)
  }
  return out
}

function checkNumber(field: SchemaFieldSpec, raw: unknown, label: string): string {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return `${label}应为数字`
  if (field.integer && !Number.isInteger(raw)) return `${label}应为整数`
  if (field.minimum !== null && raw < field.minimum) return `${label}不能小于 ${field.minimum}`
  if (field.maximum !== null && raw > field.maximum) return `${label}不能大于 ${field.maximum}`
  return ''
}

function checkString(field: SchemaFieldSpec, raw: unknown): string {
  if (typeof raw !== 'string') return '应为文本'
  if (field.options.length > 0 && !field.options.includes(raw)) {
    return `取值必须是 ${field.options.join(' / ')}`
  }
  if (field.minLength !== null && raw.length < field.minLength) {
    return `至少 ${field.minLength} 个字符`
  }
  if (field.maxLength !== null && raw.length > field.maxLength) {
    return `最多 ${field.maxLength} 个字符`
  }
  if (field.pattern !== '') {
    let matched = true
    try {
      matched = new RegExp(field.pattern).test(raw)
    } catch {
      matched = true
    }
    if (!matched) return `不符合格式 ${field.pattern}`
  }
  return ''
}

function checkList(field: SchemaFieldSpec, raw: unknown): string {
  if (!Array.isArray(raw)) return '应为列表'
  if (field.minItems !== null && raw.length < field.minItems) return `至少 ${field.minItems} 项`
  if (field.maxItems !== null && raw.length > field.maxItems) return `最多 ${field.maxItems} 项`
  for (const item of raw) {
    if (isExpression(item)) continue
    if (field.itemKind === 'string') {
      if (typeof item !== 'string') return '每一项都应是文本'
      continue
    }
    if (typeof item !== 'number' || !Number.isFinite(item)) return '每一项都应是数字'
    if (field.itemKind === 'integer' && !Number.isInteger(item)) return '每一项都应是整数'
  }
  return ''
}

/** 表单值校验。表达式一律放行——它的真值要等运行时解析才知道 */
export function validateFields(
  fields: SchemaFieldSpec[],
  value: Record<string, unknown>,
): SchemaIssue[] {
  const issues: SchemaIssue[] = []
  const push = (field: SchemaFieldSpec, message: string): void => {
    if (message !== '') issues.push({ path: field.path, label: field.label, message })
  }
  for (const field of fields) {
    const raw = value[field.key]
    if (isExpression(raw)) continue
    if (raw === undefined || raw === null) {
      if (field.required && !field.nullable) push(field, '必填')
      continue
    }
    switch (field.control) {
      case 'text':
      case 'multiline':
      case 'enum':
        push(field, checkString(field, raw))
        break
      case 'number':
        push(field, checkNumber(field, raw, ''))
        break
      case 'boolean':
        if (typeof raw !== 'boolean') push(field, '应为开关值')
        break
      case 'chips':
        push(field, checkList(field, raw))
        break
      case 'reference':
        if (field.multiple) push(field, checkList(field, raw))
        else push(field, checkNumber(field, raw, '资产 id '))
        break
      case 'object': {
        const nested = asRecord(raw)
        if (nested === null) {
          push(field, '应为对象')
          break
        }
        issues.push(...validateFields(field.fields, nested))
        break
      }
      default:
        break
    }
  }
  return issues
}

/** 约束摘要，挂在标签后面当提示 */
export function constraintHint(field: SchemaFieldSpec): string {
  const parts: string[] = []
  if (field.control === 'number' || (field.control === 'reference' && !field.multiple)) {
    if (field.minimum !== null && field.maximum !== null) {
      parts.push(`${field.minimum} ~ ${field.maximum}`)
    } else if (field.minimum !== null) parts.push(`≥ ${field.minimum}`)
    else if (field.maximum !== null) parts.push(`≤ ${field.maximum}`)
  }
  if (field.control === 'text' || field.control === 'multiline') {
    if (field.maxLength !== null) parts.push(`最多 ${field.maxLength} 字`)
    if (field.format !== '') parts.push(field.format)
    if (field.pattern !== '') parts.push(field.pattern)
  }
  if (field.maxItems !== null) parts.push(`最多 ${field.maxItems} 项`)
  if (field.nullable && !field.required) parts.push('可留空')
  return parts.join(' · ')
}

export function toJsonText(value: unknown): string {
  if (value === undefined) return ''
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return ''
  }
}

/* ==================== 控件 ==================== */

function JsonBox({
  value,
  onChange,
  rows = 4,
  placeholder,
}: {
  value: unknown
  onChange: (next: unknown) => void
  rows?: number
  placeholder?: string
}): JSX.Element {
  const [text, setText] = useState(() => toJsonText(value))
  const [mirror, setMirror] = useState<unknown>(value)
  const [error, setError] = useState('')
  // 外部换了值（切节点、载入模板）才重置文本；自己发出去的那次不重置，否则打字会被吞
  if (!Object.is(mirror, value)) {
    setMirror(value)
    setText(toJsonText(value))
    setError('')
  }

  const commit = (next: string): void => {
    setText(next)
    if (next.trim() === '') {
      setError('')
      setMirror(undefined)
      onChange(undefined)
      return
    }
    try {
      const parsed: unknown = JSON.parse(next)
      setError('')
      setMirror(parsed)
      onChange(parsed)
    } catch (issue) {
      setError(issue instanceof Error ? issue.message : String(issue))
    }
  }

  return (
    <div className="sfm-json">
      <textarea
        value={text}
        rows={rows}
        spellCheck={false}
        placeholder={placeholder}
        onChange={(event) => commit(event.target.value)}
      />
      {error !== '' ? <p className="sfm-error">JSON 无法解析：{error}</p> : null}
    </div>
  )
}

function ChipList({
  field,
  value,
  onChange,
}: {
  field: SchemaFieldSpec
  value: unknown
  onChange: (next: unknown) => void
}): JSX.Element {
  const [draft, setDraft] = useState('')
  const items = Array.isArray(value) ? value : []

  const add = (): void => {
    const text = draft.trim()
    if (text === '') return
    if (field.itemKind === 'string') {
      onChange([...items, text])
    } else {
      const parsed = Number(text)
      if (!Number.isFinite(parsed)) return
      onChange([...items, field.itemKind === 'integer' ? Math.trunc(parsed) : parsed])
    }
    setDraft('')
  }

  return (
    <div className="sfm-chips">
      {items.map((item, index) => (
        <span className="sfm-chip" key={`${index}-${String(item)}`}>
          {typeof item === 'object' ? toJsonText(item) : String(item)}
          <button
            type="button"
            aria-label={`移除第 ${index + 1} 项`}
            onClick={() => onChange(items.filter((_, current) => current !== index))}
          >
            <X />
          </button>
        </span>
      ))}
      <input
        value={draft}
        placeholder={field.itemKind === 'string' ? '输入后回车' : '数字，回车追加'}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={add}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ',') {
            event.preventDefault()
            add()
          }
          if (event.key === 'Backspace' && draft === '' && items.length > 0) {
            onChange(items.slice(0, -1))
          }
        }}
      />
    </div>
  )
}

function ReferenceField({
  field,
  value,
  onChange,
}: {
  field: SchemaFieldSpec
  value: unknown
  onChange: (next: unknown) => void
}): JSX.Element {
  const [picking, setPicking] = useState(false)
  const items = field.multiple
    ? (Array.isArray(value) ? value : [])
    : (typeof value === 'number' ? [value] : [])

  const take = (id: number): void => {
    if (field.multiple) onChange([...items, id])
    else onChange(id)
  }

  return (
    <div className="sfm-ref">
      <div className="sfm-chips">
        {items.map((item, index) => (
          <span className="sfm-chip" key={`${index}-${String(item)}`}>
            #{String(item)}
            <button
              type="button"
              aria-label={`移除 ${String(item)}`}
              onClick={() => {
                if (field.multiple) onChange(items.filter((_, current) => current !== index))
                else onChange(undefined)
              }}
            >
              <X />
            </button>
          </span>
        ))}
        <button type="button" className="sfm-chip-add" onClick={() => setPicking(true)}>
          {field.reference === 'media' ? <Video /> : <ImagePlus />}
          选{field.reference === 'media' ? '媒体' : '图'}
        </button>
      </div>
      {picking && field.reference === 'media' ? (
        <MediaAssetPicker onClose={() => setPicking(false)} onPick={(asset) => take(asset.id)} />
      ) : null}
      {picking && field.reference !== 'media' ? (
        <AssetPicker onClose={() => setPicking(false)} onPick={(asset) => take(asset.id)} />
      ) : null}
    </div>
  )
}

function FieldControl({
  field,
  value,
  onChange,
  issues,
}: {
  field: SchemaFieldSpec
  value: unknown
  onChange: (next: unknown) => void
  issues: SchemaIssue[]
}): JSX.Element {
  switch (field.control) {
    case 'multiline':
      return (
        <textarea
          className="sfm-textarea"
          value={typeof value === 'string' ? value : ''}
          rows={3}
          onChange={(event) => onChange(event.target.value)}
        />
      )
    case 'enum': {
      const options = field.options.map((option) => ({ value: option, label: option }))
      const list = field.required && !field.nullable
        ? options
        : [{ value: '', label: '（不指定）' }, ...options]
      return (
        <Picker
          className="sfm-picker"
          aria-label={field.label}
          value={typeof value === 'string' ? value : ''}
          options={list}
          onChange={(next) => onChange(next === '' ? undefined : next)}
        />
      )
    }
    case 'number':
      return (
        <input
          className="sfm-input"
          type="number"
          value={typeof value === 'number' ? String(value) : ''}
          min={field.minimum ?? undefined}
          max={field.maximum ?? undefined}
          step={field.step ?? undefined}
          onChange={(event) => {
            const text = event.target.value
            if (text === '') {
              onChange(undefined)
              return
            }
            const parsed = Number(text)
            onChange(Number.isFinite(parsed) ? parsed : text)
          }}
        />
      )
    case 'boolean':
      return (
        <label className="sfm-bool">
          <input
            type="checkbox"
            checked={value === true}
            onChange={(event) => onChange(event.target.checked)}
          />
          <span>{value === true ? '开' : '关'}</span>
        </label>
      )
    case 'chips':
      return <ChipList field={field} value={value} onChange={onChange} />
    case 'reference':
      return <ReferenceField field={field} value={value} onChange={onChange} />
    case 'object':
      return (
        <details className="sfm-object" open={field.required}>
          <summary>{field.label} · {field.fields.length} 个子字段</summary>
          <SchemaForm
            schema={field.schema}
            value={asRecord(value) ?? {}}
            onChange={(next) => onChange(next)}
            issues={issues}
            path={field.path}
          />
        </details>
      )
    case 'json':
      return <JsonBox value={value} onChange={onChange} placeholder="留空 = 不传这个字段" />
    default:
      return (
        <input
          className="sfm-input"
          value={typeof value === 'string' ? value : ''}
          maxLength={field.maxLength ?? undefined}
          onChange={(event) => onChange(event.target.value)}
        />
      )
  }
}

export interface SchemaFormProps {
  schema: JsonSchema | undefined
  value: Record<string, unknown>
  onChange: (next: Record<string, unknown>) => void
  /** 由 validateFields 得到，按 path 匹配到字段上 */
  issues?: SchemaIssue[]
  /** 嵌套时的路径前缀，顶层留空 */
  path?: string
  /** schema 没有 properties 时的空态文案 */
  emptyHint?: string
}

export function SchemaForm({
  schema,
  value,
  onChange,
  issues = [],
  path = '',
  emptyHint = '这个能力没有声明字段，直接写 JSON',
}: SchemaFormProps): JSX.Element {
  const fields = useMemo(() => describeSchema(schema, undefined, path), [schema, path])
  // 用户主动切到「引用」的字段。值本身已经是表达式的自然进引用模式，不必登记
  const [expressed, setExpressed] = useState<string[]>([])

  if (fields.length === 0) {
    return (
      <div className="sfm-form">
        <p className="sfm-empty">{emptyHint}</p>
        <JsonBox
          value={value}
          rows={6}
          onChange={(next) => onChange(asRecord(next) ?? {})}
        />
      </div>
    )
  }

  const patch = (key: string, next: unknown): void => {
    const draft: Record<string, unknown> = { ...value }
    if (next === undefined) delete draft[key]
    else draft[key] = next
    onChange(draft)
  }

  return (
    <div className="sfm-form">
      {fields.map((field) => {
        const current = value[field.key]
        const expression = isExpression(current) || expressed.includes(field.key)
        const hint = constraintHint(field)
        const failed = issues.filter((issue) => issue.path === field.path)
        return (
          <div className="sfm-field" key={field.path}>
            <div className="sfm-head">
              <span className="sfm-label">
                {field.label}
                {field.required ? <b aria-label="必填">*</b> : null}
              </span>
              <button
                type="button"
                className={expression ? 'sfm-mode sfm-mode-on' : 'sfm-mode'}
                title="在字面值与上游引用之间切换"
                onClick={() => {
                  if (expression) {
                    setExpressed((old) => old.filter((key) => key !== field.key))
                    if (isExpression(current)) patch(field.key, undefined)
                  } else {
                    setExpressed((old) => [...old, field.key])
                  }
                }}
              >
                {expression ? <Sigma /> : <Braces />}
                {expression ? '引用' : '值'}
              </button>
            </div>
            {expression ? (
              <JsonBox
                value={current}
                rows={2}
                onChange={(next) => patch(field.key, next)}
                placeholder='{"$input":"prompt"}'
              />
            ) : (
              <FieldControl
                field={field}
                value={current}
                issues={issues}
                onChange={(next) => patch(field.key, next)}
              />
            )}
            {field.description !== '' || hint !== '' ? (
              <p className="sfm-hint">{[field.description, hint].filter((item) => item !== '').join(' · ')}</p>
            ) : null}
            {failed.map((issue) => (
              <p className="sfm-error" key={`${issue.path}-${issue.message}`}>{issue.message}</p>
            ))}
          </div>
        )
      })}
    </div>
  )
}
