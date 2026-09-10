# 03.UI设计

- 状态：v0.1 已定基调（纸感阅读 + 现代工具壳，scholar 已确认）
- Owner：scholar

## 内容

| 文档 | 说明 |
| --- | --- |
| [01.设计系统](./01.设计系统.md) | 色彩/字体/标记体系/组件/动效规范；令牌事实来源是 `web/src/styles/tokens.css`（`design/mockups/tokens.css` 是 2026-08-17 的旧镜像，只供旧原型页用） |
| [02.信息架构与核心页面](./02.信息架构与核心页面.md) | 应用外壳、路由、六大页面布局与交互规范 |
| [03.组件库选型与组件规范](./03.组件库选型与组件规范.md) | 组件库分层策略、逐功能组件映射、按钮六层级体系 |
| [04.生活英语场景百科原型](./04.生活英语场景百科原型.md) | 场景词汇与表达手册的独立交互原型、运行方式和页面验收 |

## 高保真原型（design/mockups/）

浏览器直接打开 `design/mockups/index.html`（双击即可，深浅色右下角切换）：

- `workbench.html` 本地工作台全景（CR-006 / CR-007 提案：五组导航、今天、邮件、账号与凭据、语音助理 HUD、电脑操控、扩展、⌘K；令牌直接读 `web/src/styles/tokens.css`，须经 http 打开或从 index.html 进入）
- `reader.html` 精读工作台（核心页）· `shelf.html` 书架 · `vocab.html` 背单词 · `video.html` 视频学习 · `talk.html` AI 语音对话

## 维护要求

- 改视觉先改 `web/src/styles/tokens.css` 令牌，再同步设计系统文档；新原型页直接链接这一份（workbench.html 即如此），不再维护镜像。
- 新页面开发前先补原型或线框到本目录。
