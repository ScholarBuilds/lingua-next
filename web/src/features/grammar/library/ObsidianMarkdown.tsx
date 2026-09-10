/* Obsidian 讲义正文渲染：react-markdown + GFM + callout + wikilink + mermaid。

   管线选型（禁止重复造轮子）：
   - remark-gfm            表格/删除线/任务列表，仓库既有
   - remark-obsidian-callout  Obsidian callout 语法（1,555 处）
   - remark-wiki-link      [[双链]]（12 篇用到），点击转内部跳转
   - rehype-raw            **必须**——callout 插件把标题图标当原生 HTML 节点
                           输出，react-markdown 默认丢弃 HTML 节点，没有它
                           所有 callout 都是无头的
   - mermaid（懒加载）     293 张图

   词点击切分是 rehype 插件（word-click.ts）：在树上做而不是渲染后改 DOM，
   React 全程拥有 DOM——首版渲染后用 TreeWalker 改 DOM，父组件一重渲染
   React 协调就撞上被替换的文本节点，整页白屏。memo 只为省重渲染开销。 */

import { memo, useCallback, useMemo, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import rehypeRaw from 'rehype-raw'
import remarkGfm from 'remark-gfm'
import remarkObsidianCallout from 'remark-obsidian-callout'
import remarkWikiLink from 'remark-wiki-link'

import { Overlay } from '@/components/Overlay'
import { docsApi } from '@/lib/api-grammar-docs'

import type { AnnotationMark } from './annotate'
import { rehypeAnnotations } from './annotate'
import { highlightLines, normalizeCallouts } from './doc-model'
import { Mermaid } from './Mermaid'
import type { WordScope } from './word-click'
import { rehypeClickableWords, sentenceContext, WORD_CLASS } from './word-click'

const WIKI_PREFIX = '#glib-wiki:'

/* 稳定空数组：默认值写成字面量的话，memo 每次都判定 props 变了 */
const EMPTY_ANNS: AnnotationMark[] = []

/* rehype-raw 会把讲义里的原生 HTML 一并放行。语料是本人笔记，
   但 AI 完善预览也走这条管线——能执行或外联的标签一律画掉 */
const BLOCKED = () => null

interface Props {
  markdown: string
  onWikiLink: (target: string) => void
  onWordClick: (word: string, context: string) => void
  /** 'all' = 代码块与引用里的词也可点（默认）；'prose' = 只切散文 */
  wordScope?: WordScope
  /** 要标出来的批注。锚点是引文+前后文，锚不上的自动跳过 */
  annotations?: AnnotationMark[]
  onAnnotationClick?: (id: number) => void
  documentPath?: string
  softwareId?: string
}

function hasLang(className: unknown, lang: string): boolean {
  return typeof className === 'string' && className.includes(`language-${lang}`)
}

/* ```text {1-3} 的花括号 meta 在 hast 里放在 code 元素的 data.meta 上，
   而 rehype-raw 会把整棵树过 parse5 重建，凡不是真 HTML 属性的字段全丢。
   所以在 rehype-raw 之前把 meta 抄进 data-meta 属性——它是合法 HTML 属性，
   能活过重建，组件里再读回来 */
interface HastNode {
  type?: string
  tagName?: string
  value?: string
  data?: { meta?: unknown }
  properties?: Record<string, unknown>
  children?: HastNode[]
}

function rehypeKeepCodeMeta() {
  const walk = (node: HastNode): void => {
    if (node.tagName === 'code' && typeof node.data?.meta === 'string') {
      node.properties = { ...node.properties, dataMeta: node.data.meta }
    }
    for (const child of node.children ?? []) walk(child)
  }
  return (tree: HastNode) => walk(tree)
}

/** 组件侧读回 meta：属性名经 hast 规整可能是 dataMeta 或 data-meta */
function metaOf(node: unknown): string | undefined {
  const props = (node as HastNode | undefined)?.properties
  const v = props?.dataMeta ?? props?.['data-meta']
  return typeof v === 'string' ? v : undefined
}

/** pre 的第一个子元素是不是 mermaid 代码块（这时 pre 要让位给图容器） */
function isMermaidPre(node: unknown): boolean {
  const first = (node as { children?: { properties?: { className?: unknown } }[] } | undefined)
    ?.children?.[0]
  const cls = first?.properties?.className
  return Array.isArray(cls) && cls.includes('language-mermaid')
}

/** hast 子树里的纯文本。**不能用 `String(children)`**：切词插件会把文本
    拆成一串 span，那时 children 是数组，String() 出来是 `[object Object]`。 */
function textOf(node: HastNode | undefined): string {
  if (node === undefined) return ''
  if (node.type === 'text') return (node as { value?: string }).value ?? ''
  return (node.children ?? []).map(textOf).join('')
}

/* ```text {1-3} 的行高亮：在管线里把代码块的文本切成一行一个 span，
   **必须排在切词之前**——放在组件里做的话，切词插件已经把文本拆成 span，
   组件再按纯文本重建就会把词的可点性整块抹掉（例句块正是最想查词的地方）。 */
function rehypeHighlightLines() {
  const walk = (node: HastNode): void => {
    if (node.tagName === 'code') {
      const meta = metaOf(node)
      const marks = highlightLines(meta)
      if (marks.size > 0) {
        const text = textOf(node).replace(/\n$/, '')
        node.children = text.split('\n').map((line, i) => ({
          type: 'element',
          tagName: 'span',
          properties: {
            className: marks.has(i + 1) ? ['glib-line', 'glib-line-hl'] : ['glib-line'],
          },
          children: [{ type: 'text', value: `${line}\n` } as HastNode],
        }))
        return
      }
    }
    for (const child of node.children ?? []) walk(child)
  }
  return (tree: HastNode) => walk(tree)
}


/* ---- 渲染器 ----

   > [!danger] `components` 里的组件必须身份恒定
   >
   > 原来整个 `components={{...}}` 连同里面的箭头函数都写在 render 里，
   > 于是每渲染一次就是一组**全新的组件类型**。react-markdown 把它们当元素类型用，
   > 类型变了 React 就不是更新而是**卸载重建整棵正文**——
   > 滚动时大纲高亮每变一次，34KB 的正文连同 6 张 mermaid 全部推倒重来
   > （实测：滚 1200px，6 个图表容器全换成新 DOM 节点、6 张图重画）。
   > 表现就是「滚动时窗口一直在抖」。
   >
   > 所以纯组件提到模块级；要用 props 的那个（`a` 里的 `onWikiLink`）走 ref，
   > 让组件本身不依赖 props 身份。 */

const PreBlock = ({ node, children, ...props }: any) =>
  isMermaidPre(node) ? <>{children}</> : <pre {...props}>{children}</pre>

const CodeBlock = ({ node, className, children, ...props }: any) => {
  if (hasLang(className, 'mermaid')) return <Mermaid code={textOf(node as HastNode)} />
  return (
    <code className={className} {...props}>
      {children}
    </code>
  )
}

const TableBlock = ({ node: _n, ...props }: any) => (
  <div className="glib-table-wrap">
    <table {...props} />
  </div>
)

/* remark 插件不依赖任何 props，提出来免得每次渲染都换一组新数组
   （换了数组 react-markdown 会把整篇重新解析一遍） */
const REMARK_PLUGINS: any[] = [
  remarkGfm,
  remarkObsidianCallout,
  [
    remarkWikiLink,
    {
      aliasDivider: '|',
      pageResolver: (name: string) => [name],
      hrefTemplate: (permalink: string) => `${WIKI_PREFIX}${permalink}`,
    },
  ],
]

export const ObsidianMarkdown = memo(function ObsidianMarkdown({
  markdown,
  onWikiLink,
  onWordClick,
  wordScope = 'all',
  annotations = EMPTY_ANNS,
  onAnnotationClick,
  documentPath,
  softwareId,
}: Props) {
  const text = useMemo(() => normalizeCallouts(markdown), [markdown])
  const [zoom, setZoom] = useState<{ src: string; alt: string; file: string } | null>(null)

  /* 回调走 ref：组件身份不能跟着 props 变，否则又回到「重建整棵正文」。
     ref 每次渲染更新，读到的永远是最新的那个函数。 */
  const wikiRef = useRef(onWikiLink)
  wikiRef.current = onWikiLink

  const AnchorBlock = useMemo(
    () =>
      ({ node: _n, href, children, ...props }: any) => {
        if (typeof href === 'string' && href.startsWith(WIKI_PREFIX)) {
          const target = decodeURIComponent(href.slice(WIKI_PREFIX.length))
          return (
            <a
              {...props}
              href="#"
              className="glib-wiki"
              onClick={(e: React.MouseEvent) => {
                e.preventDefault()
                wikiRef.current(target)
              }}
            >
              {children}
            </a>
          )
        }
        return (
          <a {...props} href={href} target="_blank" rel="noreferrer noopener">
            {children}
          </a>
        )
      },
    [],
  )

  const components = useMemo(
    () => {
      const ImageBlock = ({ src, alt }: { src?: string; alt?: string }) => {
        if (!src) return <span className="glib-image-error">图片地址无效</span>
        if (!softwareId || !documentPath) return <img src={src} alt={alt ?? ''} />
        const resolved = documentPath.split('/').slice(0, -1)
        for (const part of src.split('/')) {
          if (part === '' || part === '.') continue
          if (part === '..') resolved.pop()
          else resolved.push(part)
        }
        const marker = resolved.indexOf('_assets')
        if (marker < 0 || resolved[marker + 1] !== 'screenshots' || resolved.length <= marker + 2) {
          return <span className="glib-image-error">图片路径不在当前软件截图目录：{src}</span>
        }
        const file = resolved.slice(marker + 2).join('/')
        const url = docsApi.softwareAssetUrl(softwareId, file)
        return <button className="glib-md-image" onClick={() => setZoom({ src: url, alt: alt ?? file, file })}><img src={url} alt={alt ?? file} onError={event => event.currentTarget.closest('button')?.classList.add('failed')} /><span>图片加载失败：{file}</span></button>
      }
      return ({
      script: BLOCKED,
      iframe: BLOCKED,
      object: BLOCKED,
      embed: BLOCKED,
      style: BLOCKED,
      link: BLOCKED,
      meta: BLOCKED,
      a: AnchorBlock,
      pre: PreBlock,
      code: CodeBlock,
      table: TableBlock,
      img: ImageBlock,
    })},
    [AnchorBlock, documentPath, softwareId],
  )

  /* 这两个插件带参数，参数变了才该换数组 */
  const rehypePlugins = useMemo(
    () => [
      rehypeKeepCodeMeta,
      rehypeRaw,
      rehypeHighlightLines,
      // 批注要排在切词之前：切完词引文已被拆成一串 span，接不上了
      [rehypeAnnotations, annotations],
      [rehypeClickableWords, wordScope],
    ],
    [annotations, wordScope],
  )

  const openFromEvent = useCallback(
    (t: HTMLElement) => {
      onWordClick(t.textContent ?? '', sentenceContext(t))
    },
    [onWordClick],
  )

  return (
    <div
      className="glib-md"
      onClick={(e) => {
        const t = e.target as HTMLElement
        if (t.classList.contains(WORD_CLASS)) {
          openFromEvent(t)
          return
        }
        // 词在批注里面时，点词优先；点到批注的空白处才当作打开批注
        const m = t.closest<HTMLElement>('mark.glib-ann')
        if (m !== null && onAnnotationClick !== undefined) {
          onAnnotationClick(Number(m.dataset.ann))
        }
      }}
    >
      <ReactMarkdown
        remarkPlugins={REMARK_PLUGINS}
        rehypePlugins={rehypePlugins as any}
        components={components as any}
      >
        {text}
      </ReactMarkdown>
      {zoom && <Overlay onClose={() => setZoom(null)} card="glib-image-overlay"><div className="overlay-head"><b>{zoom.alt}</b><button className="icon-btn" onClick={() => setZoom(null)}>关闭</button></div><img src={zoom.src} alt={zoom.alt} /><p>{zoom.file}</p></Overlay>}
    </div>
  )
})
