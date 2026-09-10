/* 讲义文档纯逻辑（doc-model）。

   callout 规整错了不报错，只会让 39 处同段落 callout 的粗体静默消失；
   大纲提取把代码块里的 # 当标题会让 TOC 序号整体错位、点击跳错节。
   这两类静默错必须钉在单测里。 */

import { describe, expect, it } from 'vitest'

import {
  activeHeadingAt,
  highlightLines,
  matchTrailingNewlines,
  normalizeCallouts,
  searchBlocks,
  sectionSlice,
  tocFromMarkdown,
} from './doc-model'

describe('normalizeCallouts', () => {
  it('标题行后紧跟正文时补一个引用空行', () => {
    const md = '> [!abstract] 本章导读\n> 英语句子由**五大句型**衍生。'
    expect(normalizeCallouts(md)).toBe(
      '> [!abstract] 本章导读\n>\n> 英语句子由**五大句型**衍生。',
    )
  })

  it('无标题 callout 同样处理', () => {
    expect(normalizeCallouts('> [!tip]\n> 内容')).toBe('> [!tip]\n>\n> 内容')
  })

  it('已有空行分隔的不重复插入', () => {
    const md = '> [!warning] 注意\n>\n> 正文'
    expect(normalizeCallouts(md)).toBe(md)
  })

  it('嵌套缩进的 callout 保持缩进插行', () => {
    expect(normalizeCallouts('  > [!note] 嵌套\n  > 内容')).toBe(
      '  > [!note] 嵌套\n  >\n  > 内容',
    )
  })

  it('普通引用块不动', () => {
    const md = '> 普通引用\n> 第二行'
    expect(normalizeCallouts(md)).toBe(md)
  })

  it('可折叠标记 [!tip]- 也识别', () => {
    expect(normalizeCallouts('> [!tip]- 收起\n> 内容')).toBe(
      '> [!tip]- 收起\n>\n> 内容',
    )
  })
})

describe('tocFromMarkdown', () => {
  it('按出现顺序编号并给出层级与行号', () => {
    const md = '# 总标题\n\n## 1. 概念\n\n### 1.1 定义\n\n## 2. 用法'
    expect(tocFromMarkdown(md)).toEqual([
      { level: 1, text: '总标题', index: 0, line: 0 },
      { level: 2, text: '1. 概念', index: 1, line: 2 },
      { level: 3, text: '1.1 定义', index: 2, line: 4 },
      { level: 2, text: '2. 用法', index: 3, line: 6 },
    ])
  })

  it('代码块里的 # 不是标题', () => {
    const md = '## 真标题\n\n```bash\n# 注释不是标题\n```\n\n## 又一个'
    expect(tocFromMarkdown(md).map((e) => e.text)).toEqual(['真标题', '又一个'])
  })

  it('mermaid 围栏同样跳过', () => {
    const md = '```mermaid\nflowchart TB\n```\n\n# 标题'
    expect(tocFromMarkdown(md)).toEqual([{ level: 1, text: '标题', index: 0, line: 4 }])
  })

  it('标题里的内联标记剥掉', () => {
    expect(tocFromMarkdown('## **粗体** 与 `代码`')[0].text).toBe('粗体 与 代码')
  })

  /* 下面三条是复查抓到的真 bug 钉的：开关式围栏解析会把栏内的另一种
     围栏当闭栏，产出假标题——大纲错位事小，节段写回会把围栏切掉半个 */

  it('~~~ 栏内的 ``` 是内容不是闭栏', () => {
    const md = '~~~\n```\n# 假标题\n```\n~~~\n# 真标题'
    expect(tocFromMarkdown(md).map((e) => e.text)).toEqual(['真标题'])
  })

  it('```` 教学围栏内嵌 ``` 不提前闭合', () => {
    const md = '````markdown\n```\n# 假标题\n```\n````\n# 真标题'
    expect(tocFromMarkdown(md).map((e) => e.text)).toEqual(['真标题'])
  })

  it('闭栏长度必须不小于开栏', () => {
    const md = '````\n```\n# 仍在栏内\n````\n# 出栏了'
    expect(tocFromMarkdown(md).map((e) => e.text)).toEqual(['出栏了'])
  })
})

describe('matchTrailingNewlines', () => {
  it('LLM 剥掉的尾换行按原切片补齐', () => {
    expect(matchTrailingNewlines('## A\n内容\n\n', '## A\n改进内容')).toBe('## A\n改进内容\n\n')
  })

  it('末节无尾换行时不多补', () => {
    expect(matchTrailingNewlines('## B\n更多', '## B\n改\n\n')).toBe('## B\n改')
  })
})

describe('sectionSlice', () => {
  const md = '# 总\n\n## A\n\nA 的内容\n\n### A.1\n\n细节\n\n## B\n\nB 的内容'
  const toc = tocFromMarkdown(md)

  it('节段到下一个同级标题前为止，子标题算在内', () => {
    const slice = sectionSlice(md, toc, 1)
    expect(slice?.text).toBe('## A\n\nA 的内容\n\n### A.1\n\n细节\n\n')
    // 偏移量精确可拼接：切出去再拼回来必须还原原文
    expect(md.slice(0, slice?.start) + slice?.text + md.slice(slice?.end)).toBe(md)
  })

  it('末节到文件尾（无尾随换行也不越界）', () => {
    const slice = sectionSlice(md, toc, 3)
    expect(slice?.text).toBe('## B\n\nB 的内容')
    expect(slice?.end).toBe(md.length)
  })

  it('序号不存在返回 null', () => {
    expect(sectionSlice(md, toc, 99)).toBeNull()
  })
})

describe('highlightLines', () => {
  it('解析区间与并列', () => {
    expect([...highlightLines('text {1-3}')]).toEqual([1, 2, 3])
    expect([...highlightLines('text {2,4}')]).toEqual([2, 4])
    expect([...highlightLines('text {1-2, 5}')]).toEqual([1, 2, 5])
  })

  it('无 meta 或非法 meta 返回空集', () => {
    expect(highlightLines(undefined).size).toBe(0)
    expect(highlightLines('text').size).toBe(0)
    expect(highlightLines('{a-b}').size).toBe(0)
  })
})

describe('searchBlocks', () => {
  const blocks = ['动词不定式的形式', 'to + 动词原形', '不带 to 的不定式']

  it('大小写不敏感命中块序号', () => {
    expect(searchBlocks(blocks, 'TO')).toEqual([1, 2])
  })

  it('空查询返回空', () => {
    expect(searchBlocks(blocks, '  ')).toEqual([])
  })
})

describe('activeHeadingAt', () => {
  // 一篇真实讲义的形状：25 个标题，位置递增
  const tops = [0, 120, 480, 900, 1500, 2200, 3000]

  it('还没滚到第一个标题时停在第 0 条', () => {
    expect(activeHeadingAt(tops, -50)).toBe(0)
    expect(activeHeadingAt(tops, 0)).toBe(0)
  })

  it('取最后一个越过判定线的标题', () => {
    expect(activeHeadingAt(tops, 119)).toBe(0)
    expect(activeHeadingAt(tops, 120)).toBe(1)
    expect(activeHeadingAt(tops, 1499)).toBe(3)
    expect(activeHeadingAt(tops, 1500)).toBe(4)
  })

  it('滚到底停在最后一条', () => {
    expect(activeHeadingAt(tops, 99999)).toBe(6)
  })

  it('没有标题时不炸', () => {
    expect(activeHeadingAt([], 500)).toBe(0)
  })

  it('与逐个扫描的结果一致（二分不能改判定口径）', () => {
    const naive = (list: number[], line: number) => {
      let cur = 0
      list.forEach((t, i) => {
        if (t <= line) cur = i
      })
      return cur
    }
    for (let line = -100; line < 3200; line += 7) {
      expect(activeHeadingAt(tops, line)).toBe(naive(tops, line))
    }
  })
})
