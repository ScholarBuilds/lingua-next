# ADR-002：前端技术栈选择 React 18 + TypeScript + Vite

- 状态：accepted（2026-08-17 scholar 确认）
- 日期：2026-08-17
- 决策人：scholar

## 背景与约束

scholar 的全局偏好是 Vue 3 > React。本 ADR 明确偏离该默认偏好，偏离理由必须成立，否则回退 Vue 3。

## 驱动因素

DEC-NEXT-002 规定开源复用优先于自研。逐一盘点四大主链路计划借用的开源实现：

| 借用目标 | 技术栈 | 借用内容 |
| --- | --- | --- |
| qwerty-learner（背单词） | React + TS + Vite | 词库数据结构、练习交互、发音集成 |
| asbplayer（视频字幕学习） | React + TS | 字幕同步引擎、字幕点击跳转、挖词交互 |
| Readest（阅读器） | React（Next.js/Tauri） | foliate-js 集成方式、阅读器 UI 形态 |
| Lute v3（点词精读） | 服务端渲染 + jQuery | 只抄交互与数据模型思想，前端代码不可直接用 |

四个核心参考中三个是 React 代码库，可直接搬组件与逻辑；选 Vue 意味着全部重写，DEC-NEXT-002 失效大半。

## 候选方案

| 方案 | 优点 | 缺点 |
| --- | --- | --- |
| Vue 3 + Vite + Ant Design Vue | 符合个人默认偏好与既有经验 | 目标开源项目零复用，全部手工移植 |
| React 18 + TS + Vite | 参考项目代码可直接搬运二开；AI 生成 React 代码成熟度最高 | 偏离个人默认偏好 |
| Next.js（React） | Readest 同款 | 本产品无 SSR/SEO 诉求，纯 SPA 更简单 |

## 决定

**React 18 + TypeScript + Vite（SPA，不用 Next.js）**，配套：

- 样式：TailwindCSS + shadcn/ui（qwerty-learner 同款组合，组件代码可对拷）
- 状态：Zustand（轻量，参考项目同款）
- 服务端数据：TanStack Query
- 路由：React Router 7
- 长列表虚拟化：TanStack Virtual（词库万级词条列表）
- 阅读渲染：foliate-js（epub/mobi/azw3）、pdf.js（pdf）
- 视频播放：原生 `<video>` + 自研字幕层（移植 asbplayer 逻辑）
- 实时语音客户端：WebRTC（`RTCPeerConnection`）+ Web Audio

## 后果

- 收获三个可直接搬运代码的参考仓库，前端工作量大幅压缩。
- Vue 偏好在本项目内失效，需在项目规范中声明，避免后续 AI 协作时混入 Vue 惯例。
- shadcn/ui 采用源码分发模式，组件进仓库可随意改，符合"直接二开"策略。

## 验证与复审日期

- 验证：M1 用 foliate-js + 点词弹层做垂直切片，确认点词延迟与选区精度。
- 复审：仅当 React 生态出现阻断性问题时重开。
