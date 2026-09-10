import { requestJson } from './http'

/* 语法讲义文档服务（模块 15 · 讲义库）。

   与 api-grammar 的分工：那边是「概念/题目」等结构化数据，
   这边是**整篇 Obsidian 讲义原文**——树、正文、全库搜索、AI 完善与回写。
   improve 走 SSE 流式（产出是长 Markdown，非流式要干等十几秒）。 */

export class ApiDocsError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message)
    this.name = 'ApiDocsError'
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  return requestJson<T>(`/api${path}`, init, (status, message) => new ApiDocsError(status, message))
}

function jsonBody(method: string, body: unknown): RequestInit {
  return { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
}

export interface DocRef {
  path: string
  name: string
}

export type DocCollection = 'grammar' | 'vocabulary' | 'patterns' | 'scenes' | 'software'

export interface SoftwareLibrarySummary {
  software_id: string
  software_name: string
  platform: string
  version: string
  captured_at: string
  cover: string
  status: string
  screenshots: number
  documents: number
  outline: string
}

export interface DocTree {
  chapters: { name: string; docs: DocRef[] }[]
  loose: DocRef[]
}

export interface DocProps {
  title?: string | null
  date?: string | null
  description?: string | null
  categories?: string | null
  tags: string[]
}

export interface DocContent {
  path: string
  name: string
  props: DocProps
  /** 文件原始全文（含 front matter）。写回拼接的基底，body 是它的后缀 */
  raw: string
  body: string
  mtime: string
  words: number
  prev: DocRef | null
  next: DocRef | null
}

export interface DocSearchHit {
  line: number
  text: string
}

export interface DocSearchItem {
  path: string
  name: string
  /** 根目录直属文档没有章节 */
  chapter: string | null
  n: number
  hits: DocSearchHit[]
}

export interface GrammarLibraryStatus {
  root: string
  exists: boolean
  documents: number
  runtime_profile: string
}

export interface GrammarLibraryImportResult {
  source: string
  target: string
  discovered: number
  copied: number
  unchanged: number
  conflicts: string[]
}

export const docsApi = {
  tree: (collection: DocCollection = 'grammar', library?: string) => request<DocTree>(`/grammar/docs/tree?collection=${collection}${library ? `&library=${encodeURIComponent(library)}` : ''}`),
  library: (collection: DocCollection = 'grammar', library?: string) => request<GrammarLibraryStatus>(`/grammar/docs/library?collection=${collection}${library ? `&library=${encodeURIComponent(library)}` : ''}`),
  importLibrary: (sourcePath: string, collection: DocCollection = 'grammar') =>
    request<GrammarLibraryImportResult>(
      `/grammar/docs/library/import?collection=${collection}`,
      jsonBody('POST', { source_path: sourcePath }),
    ),
  content: (path: string) =>
    request<DocContent>(`/grammar/docs/content?path=${encodeURIComponent(path)}`),
  search: (q: string, collection: DocCollection = 'grammar', library?: string) =>
    request<{ items: DocSearchItem[] }>(`/grammar/docs/search?q=${encodeURIComponent(q)}&collection=${collection}${library ? `&library=${encodeURIComponent(library)}` : ''}`),
  softwareLibraries: () => request<{ items: SoftwareLibrarySummary[] }>('/grammar/docs/software/libraries'),
  resolveLegacySoftwareSource: (params: URLSearchParams) =>
    request<{ found: boolean; library?: string; document?: string; anchor?: string; message?: string }>(`/grammar/docs/software/resolve-legacy-source?${params}`),
  softwareAssetUrl: (softwareId: string, relativePath: string) =>
    `/api/grammar/docs/assets/${encodeURIComponent(softwareId)}/${relativePath.split('/').map(encodeURIComponent).join('/')}`,
  apply: (path: string, content: string, baseMtime: string) =>
    request<{ ok: boolean; backup: string }>(
      '/grammar/docs/apply',
      jsonBody('POST', { path, content, base_mtime: baseMtime }),
    ),
}

/* ---- AI 完善流：delta 为 Markdown 文本增量，done 落定全文 ---- */

export interface ImproveHandlers {
  onDelta: (text: string) => void
  onDone: (text: string, model: string) => void
  onError: (message: string) => void
}

export async function streamImprove(
  body: {
    path: string
    selection?: string
    instruction?: string
    /** 输入框上带的图片资产 id，走多模态 */
    ref_asset_ids?: number[]
    /** 其它文件资产 id，服务端尽力抽正文 */
    file_asset_ids?: number[]
  },
  handlers: ImproveHandlers,
  signal: AbortSignal,
): Promise<void> {
  await readSse('/api/grammar/docs/improve?stream=true', body, handlers, signal)
}

/** SSE 读取：按帧切、跨块的半帧留到下一块。improve 与批注分析共用 */
async function readSse(
  url: string,
  body: unknown,
  handlers: ImproveHandlers,
  signal: AbortSignal,
): Promise<void> {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    })
    if (!res.ok || res.body === null) {
      handlers.onError(`HTTP ${res.status}`)
      return
    }
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buf = ''
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      // SSE 帧以空行分隔；最后半帧留在 buf 里等下一块
      const frames = buf.split('\n\n')
      buf = frames.pop() ?? ''
      for (const frame of frames) {
        const data = frame
          .split('\n')
          .filter((l) => l.startsWith('data:'))
          .map((l) => l.slice(5).trimStart())
          .join('\n')
        if (data === '') continue
        let ev: { type: string; text?: string; model?: string; message?: string }
        try {
          ev = JSON.parse(data)
        } catch {
          continue
        }
        if (ev.type === 'delta' && ev.text !== undefined) handlers.onDelta(ev.text)
        else if (ev.type === 'done') handlers.onDone(ev.text ?? '', ev.model ?? '')
        else if (ev.type === 'error') handlers.onError(ev.message ?? '生成失败')
      }
    }
  } catch (e) {
    if (!signal.aborted) handlers.onError((e as Error).message)
  }
}

/* ---- 批注 ----

   锚点存的是引文 + 前后文（TextQuoteSelector），不是字符偏移：
   讲义可以被 AI 改写并写回，偏移当场全错。 */

export type AnnColor = 'yellow' | 'green' | 'blue' | 'pink'

export interface DocAnnotation {
  id: number
  doc_path: string
  quote: string
  prefix: string
  suffix: string
  start_hint: number
  note: string | null
  color: AnnColor
  ai_kind: string | null
  ai_result: { text: string; model: string; at: string } | null
  resolved_start: number | null
  resolved_end: number | null
  created_at: string
  updated_at: string
}

export type AnalyzeKind = 'grammar' | 'explain' | 'translate'

export const annApi = {
  list: (path: string) =>
    request<{ items: DocAnnotation[] }>(
      `/grammar/docs/annotations?path=${encodeURIComponent(path)}`,
    ),
  create: (body: {
    path: string
    quote: string
    prefix: string
    suffix: string
    start_hint: number
    color?: AnnColor
    note?: string
  }) => request<DocAnnotation>('/grammar/docs/annotations', jsonBody('POST', body)),
  update: (id: number, body: { note?: string; color?: AnnColor }) =>
    request<DocAnnotation>(`/grammar/docs/annotations/${id}`, jsonBody('PATCH', body)),
  remove: (id: number) =>
    request<{ ok: boolean }>(`/grammar/docs/annotations/${id}`, { method: 'DELETE' }),
}

/** 批注的 AI 分析流。事件形状与 improve 一致，共用同一个 SSE 读法 */
export async function streamAnnAnalyze(
  id: number,
  body: { kind: AnalyzeKind; refresh?: boolean },
  handlers: ImproveHandlers,
  signal: AbortSignal,
): Promise<void> {
  await readSse(`/api/grammar/docs/annotations/${id}/analyze?stream=true`, body, handlers, signal)
}
