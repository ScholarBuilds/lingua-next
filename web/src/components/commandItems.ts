/* ⌘K 命令面板的静态条目（CR-006 D6）。

   页面与命令都在这里登记，面板只负责渲染与过滤。列进来的每一条都必须真的能跑：
   写了跳转目标就必须有那条路由，写了动作就必须接了处理器——列一个点了没反应的
   条目比不列更糟（帮助面板那条教训）。 */

import { defaultFilter } from 'cmdk'

export interface PaletteCommand {
  id: string
  label: string
  /** 右侧的小字：快捷键、类别 */
  hint?: string
  /** 额外的匹配词（拼音、英文、旧称），不显示 */
  keywords?: string
  run: () => void
}

export interface PageEntry {
  id: string
  label: string
  to: string
  keywords: string
}

/** 一级页面。与 App.tsx 的导航同一份目的地，改路由两边一起改 */
export const PAGES: ReadonlyArray<PageEntry> = [
  { id: 'today', label: '今天', to: '/', keywords: 'home today 首页' },
  { id: 'read', label: '阅读', to: '/read', keywords: 'books shelf read 书架 内容库 书' },
  { id: 'video', label: '视频', to: '/video', keywords: 'video youtube 视频库' },
  { id: 'vocab', label: '词汇', to: '/vocab', keywords: 'vocab words 单词 词库 词表' },
  { id: 'dict', label: '查词', to: '/dict', keywords: 'dict lookup search 查词 词典 查单词 翻译' },
  { id: 'grammar', label: '英语讲义', to: '/grammar', keywords: 'grammar 讲义 语法 词汇 句型 场景' },
  { id: 'talk', label: '对话', to: '/talk', keywords: 'talk speak 口语 场景 陪练' },
  { id: 'studio', label: '工坊', to: '/studio', keywords: 'studio canvas image 画布 生图' },
  { id: 'tasks', label: '任务', to: '/tasks', keywords: 'tasks pipeline 管线 队列' },
  { id: 'software-english', label: '软件英语', to: '/grammar?tab=software', keywords: 'software settings 软件 界面 截图 系统设置 讲义' },
  { id: 'mail', label: '邮件', to: '/mail', keywords: 'mail gmail inbox 邮箱 收件箱' },
  { id: 'accounts', label: '账号与凭据', to: '/accounts', keywords: 'vault credentials key password 保险箱 密码 凭据' },
  { id: 'extensions', label: '扩展', to: '/extensions', keywords: 'extensions plugins mcp routines 扩展 插件 例程' },
]

/** 面板关掉 cmdk 内置过滤之后（服务端联想的词条不能被它按 value 再筛一遍），静态四组自己筛：
    空串保持登记顺序，否则按 cmdk 同一套打分留下命中的、高分在前 */
export function filterPalette<T extends { label: string; keywords?: string }>(
  items: T[],
  search: string,
): T[] {
  const q = search.trim()
  if (q === '') return items
  return items
    .map((item) => ({ item, score: defaultFilter(`${item.label} ${item.keywords ?? ''}`, q) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((x) => x.item)
}

export interface CommandContext {
  navigate: (to: string) => void
  openSettings: (section?: string) => void
  toggleTheme: () => void
  toggleNav: () => void
}

export function pageCommands(ctx: CommandContext): PaletteCommand[] {
  return PAGES.map((page) => ({
    id: `page:${page.id}`,
    label: page.label,
    keywords: page.keywords,
    run: () => ctx.navigate(page.to),
  }))
}

export function actionCommands(ctx: CommandContext): PaletteCommand[] {
  return [
    { id: 'act:import-read', label: '导入书或文章…', keywords: 'import epub pdf url 导入', run: () => ctx.navigate('/read') },
    { id: 'act:import-video', label: '导入视频链接…', keywords: 'import youtube 导入', run: () => ctx.navigate('/video') },
    { id: 'act:review', label: '开始复习到期词', keywords: 'review fsrs 复习 背单词', run: () => ctx.navigate('/vocab?v=review') },
    { id: 'act:new-canvas', label: '新建画布', keywords: 'canvas studio 画布', run: () => ctx.navigate('/studio/canvas') },
    { id: 'act:routines', label: '例程与时间表', keywords: 'routines schedule cron 例程 定时 早报', run: () => ctx.navigate('/extensions?tab=routines') },
    { id: 'act:settings-models', label: '设置 · 模型服务', keywords: 'settings models api key 设置 模型', run: () => ctx.openSettings('models') },
    { id: 'act:theme', label: '切换深浅色', keywords: 'theme dark light 主题 深色 浅色', run: ctx.toggleTheme },
    { id: 'act:nav', label: '收起 / 展开导航', keywords: 'sidebar rail 侧栏 导航', run: ctx.toggleNav },
  ]
}
