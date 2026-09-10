/* 图片编辑器的渲染冒烟：八个页签逐个真渲染一遍。
 *
   要拦的是「重构得很好看，但某个页签点了没反应」——面板整层 return null、
   导入环触发 TDZ、必需的 provider 缺失，这三样在纯函数测试里全看不见，
   在浏览器里则是白屏或空面板，而 console 一声不吭（本仓已经吃过一次）。

   两处替身，都不改被测行为：
   - `Overlay` 走 `createPortal`，而 react-dom/server 不支持 portal，换成朴素 div；
   - 本仓 vitest 跑在 node 里没有 jsdom，所以只能 `renderToStaticMarkup`：
     effect 不跑、图片加载不了，量到的是**首帧**。首帧能不能出东西正是这里要问的。 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createElement } from 'react'
import type { ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

vi.mock('../../components/Overlay', () => ({
  Overlay: ({ children }: { children: ReactNode }) => createElement('div', { className: 'overlay' }, children),
  useEscapeClose: () => undefined,
  useOverlayOpen: () => true,
  overlayDepth: () => 1,
}))

const { CanvasEditor } = await import('./CanvasEditor')
import type { CanvasEditorMode } from './CanvasEditor'
import type { ImageAsset } from '../../lib/api-image'

function asset(id: number, w = 1024, h = 768): ImageAsset {
  return {
    id,
    display_name: null,
    sha: `sha-${id}`,
    url: `/api/images/assets/${id}/display`,
    thumb_url: `/api/images/assets/${id}/thumb`,
    full_url: `/api/images/assets/${id}/full`,
    width: w,
    height: h,
    bytes: 1024,
    mime: 'image/png',
    target_key: 'free',
    style_key: null,
    prompt: '',
    prompt_structure: null,
    brief: null,
    alias: null,
    model: null,
    size_req: null,
    quality: null,
    usage: null,
    subject_domain: null,
    subject_id: null,
    run_id: null,
    step: null,
    source: 'generate',
    group_id: null,
  } as unknown as ImageAsset
}

const MODES: CanvasEditorMode[] = [
  'preview',
  'crop',
  'annotate',
  'mask',
  'outpaint',
  'resize',
  'split',
  'join',
]

function render(node: JSX.Element): string {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return renderToStaticMarkup(createElement(QueryClientProvider, { client }, node))
}

function open(mode: CanvasEditorMode, count = 3): string {
  const items = Array.from({ length: count }, (_, i) => asset(100 + i))
  return render(
    createElement(CanvasEditor, {
      open: { items, startIndex: 0, mode },
      onDone: () => undefined,
      onClose: () => undefined,
    }),
  )
}

describe('八个页签各自渲染出东西', () => {
  for (const mode of MODES) {
    it(`${mode} 页签的面板与右栏都在`, () => {
      const html = open(mode)
      // 舞台 + 右侧参数栏是每个页签的骨架，缺一说明整层 return 了 null
      expect(html).toContain('sced-body')
      if (mode === 'preview') {
        // 预览没有「保存」，它的右栏是信息 + 下载
        expect(html).toContain('下载原图')
      } else {
        expect(html).toContain('sced-side')
        expect(html).toContain('sced-act')
      }
    })
  }

  it('每个页签的标题就是那个页签的名字', () => {
    expect(open('crop')).toContain('裁剪')
    expect(open('join')).toContain('宫格拼接')
    expect(open('outpaint')).toContain('AI 扩图')
  })
})

describe('页签可用性', () => {
  it('只有一张图时拼接页签禁用，并说清为什么', () => {
    const html = open('preview', 1)
    expect(html).toContain('拼接至少要两张图')
  })

  it('两张以上时拼接页签解禁', () => {
    expect(open('preview', 2)).not.toContain('拼接至少要两张图')
  })
})

describe('弹窗内切图', () => {
  it('多张图时显示序号与总数', () => {
    expect(open('preview', 5)).toContain('1 / 5')
  })

  it('只有一张时不显示翻页条——没有可切的东西', () => {
    expect(open('preview', 1)).not.toContain('sced-flip-num')
  })

  it('起始下标越界时夹回范围内，而不是白屏', () => {
    const items = [asset(1), asset(2)]
    const html = render(
      createElement(CanvasEditor, {
        open: { items, startIndex: 99, mode: 'preview' as const },
        onDone: () => undefined,
        onClose: () => undefined,
      }),
    )
    expect(html).toContain('2 / 2')
  })

  it('第一张时「上一张」置灰、「下一张」可点', () => {
    const html = open('preview', 3)
    const prev = html.indexOf('aria-label="上一张"')
    const next = html.indexOf('aria-label="下一张"')
    expect(prev).toBeGreaterThan(-1)
    expect(next).toBeGreaterThan(-1)
    // 属性顺序是 aria-label → title → disabled，往后看一小段就够
    expect(html.slice(prev, prev + 120)).toContain('disabled')
    expect(html.slice(next, next + 120)).not.toContain('disabled')
  })
})

describe('旧的开图方式（asset + siblings）照常工作', () => {
  it('不传 open 也能渲染，并把 siblings 算进翻页', () => {
    const html = render(
      createElement(CanvasEditor, {
        asset: asset(7),
        siblings: [asset(7), asset(8)],
        initialMode: 'preview' as const,
        onDone: () => undefined,
        onClose: () => undefined,
      }),
    )
    // siblings 里含当前张时不能算两遍
    expect(html).toContain('1 / 2')
  })

  it('siblings 不含当前张时也合得对', () => {
    const html = render(
      createElement(CanvasEditor, {
        asset: asset(7),
        siblings: [asset(8)],
        initialMode: 'preview' as const,
        onDone: () => undefined,
        onClose: () => undefined,
      }),
    )
    expect(html).toContain('1 / 2')
  })

  it('一张图都没有时给一句话，而不是崩在渲染里', () => {
    const html = render(
      createElement(CanvasEditor, {
        open: { items: [], mode: 'preview' as const },
        onDone: () => undefined,
        onClose: () => undefined,
      }),
    )
    expect(html).toContain('没有可编辑的图')
  })
})

describe('宫格拼接首帧就有版式', () => {
  it('四张图默认排 2 列，画板与格子都画出来了', () => {
    const items = Array.from({ length: 4 }, (_, i) => asset(200 + i))
    const html = render(
      createElement(CanvasEditor, {
        open: { items, mode: 'join' as const },
        onDone: () => undefined,
        onClose: () => undefined,
      }),
    )
    expect(html).toContain('sced-joinboard')
    expect(html.match(/sced-tile/g)?.length).toBeGreaterThanOrEqual(4)
    expect(html).toContain('2 列 × 2 行')
    expect(html).toContain('拼接 4 张并保存')
  })

  it('分组来源会在说明里点明', () => {
    const items = [asset(1), asset(2)]
    const html = render(
      createElement(CanvasEditor, {
        open: { items, mode: 'join' as const, scope: 'group' as const },
        onDone: () => undefined,
        onClose: () => undefined,
      }),
    )
    expect(html).toContain('这一组来自整个分组')
  })
})

describe('扩图页首帧', () => {
  it('默认「两侧同时扩」是勾上的——项目主人要的就是这个手感', () => {
    const html = open('outpaint')
    const at = html.indexOf('两侧同时扩')
    expect(at).toBeGreaterThan(-1)
    expect(html.slice(Math.max(0, at - 200), at)).toContain('checked')
  })

  it('一键外扩的七个比例都列出来了', () => {
    const html = open('outpaint')
    for (const r of ['1:1', '4:3', '3:4', '16:9', '9:16', '3:2', '2:3']) {
      expect(html).toContain(`>${r}</button>`)
    }
  })

  it('还没扩时提交被拦住，并说清差什么', () => {
    const html = open('outpaint')
    expect(html).toContain('先拖边框决定往外扩多少')
    expect(html).toContain('<button class="btn btn-primary" disabled=""')
  })

  it('双向/单侧的手势写在界面上，不只藏在 tooltip 里', () => {
    expect(open('outpaint')).toContain('拖任一手柄：两侧同时等量外扩。按住 ⌥/Alt 改成只扩这一侧。')
  })

  it('提示词有预置的那一句，不用用户自己想', () => {
    expect(open('outpaint')).toContain('Remove the white area and continue the scene naturally')
  })

  /* 外扩框与八个手柄要等图片真的加载出来才画（`img !== null`），
     而 node 里没有图片加载这回事——**手柄的位置与拖拽只能在浏览器里验**，
     这里能钉住的是「首帧不是空的、该拦的拦住了」。 */
  it('图还没到时舞台给的是加载提示而不是空白', () => {
    expect(open('outpaint')).toContain('图片加载中…')
  })
})

describe('遮罩页首帧', () => {
  it('笔刷 / 橡皮 / 撤销 / 重做 / 清空 五件都在工具条上', () => {
    const html = open('mask')
    for (const label of ['笔刷', '橡皮', '撤销', '重做', '清空']) {
      expect(html).toContain(`>${label}</button>`)
    }
    expect(html).toContain('已涂 0 笔')
  })

  it('一笔没涂时撤销与清空都置灰', () => {
    const html = open('mask')
    const at = html.indexOf('>撤销</button>')
    expect(html.slice(Math.max(0, at - 120), at)).toContain('disabled')
  })

  it('没写提示词时先催提示词，不是先催涂', () => {
    // 遮罩的提示词没有预置值，缺的是它
    expect(open('mask')).toContain('先写一句话说要画成什么')
  })
})

describe('预览页的这一组', () => {
  it('每张一个缩略图，当前那张描边', () => {
    const html = open('preview', 4)
    // 选中那张的类是 "sced-cell sced-cell-on"，按 class= 开头数才不会数两遍
    expect(html.match(/class="sced-cell/g)?.length).toBe(4)
    expect(html).toContain('sced-cell sced-cell-on')
    expect(html).toContain('← / → 也能切')
  })
})

describe('起始页签', () => {
  it('open.mode 压过 initialMode', () => {
    const html = render(
      createElement(CanvasEditor, {
        asset: asset(1),
        initialMode: 'crop' as const,
        open: { items: [asset(1)], mode: 'resize' as const },
        onDone: () => undefined,
        onClose: () => undefined,
      }),
    )
    expect(html).toContain('缩放并另存')
  })
})
