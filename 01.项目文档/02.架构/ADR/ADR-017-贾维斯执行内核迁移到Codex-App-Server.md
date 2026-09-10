# ADR-017：贾维斯执行内核迁移到 Codex App Server

- 状态：superseded by [ADR-018](ADR-018-移除贾维斯专属运行时.md)
- 日期：2026-09-03
- 决策人：scholar
- 替代：[ADR-015](ADR-015-贾维斯执行内核选型.md)

## 决定

1. NEXUS 以官方 `codex app-server --stdio` 作为贾维斯的默认执行子进程。`JarvisManager`、Mission、审批门、持久事件、记忆和 MCP 门代理仍由 NEXUS 管理，不用 `jarvis-codex` 替换整个本体。
2. App Server stdio 客户端改为中性 `AppServerClient`，旧类名仅作迁移兼容。桌面安装包只复制 Codex arm64 vendor 运行时，不再携带 Open Interpreter standalone。
3. 开发档 `auto` 先找 Codex，找不到时可回落旧 `interpreter`；发布档强制 `codex`。该回落只用于迁移排障，不是发布依赖。
4. 执行模型仍走 NEXUS 的 BYOK 能力绑定，通过自定义 model provider 注入 Codex；ChatGPT 订阅登录不是安装包的前置条件。
5. 稳定语音主路保留现有火山全双工/半双工管线。Codex `thread/realtime/*` 依赖 ChatGPT 身份且属实验协议，不在 BYOK 主路中伪装成可用；将来只能作通过账号与能力探针后的可选传输。

## 产品边界

| 责任 | 归属 |
| --- | --- |
| 实时理解、推理、通用工具规划与代码执行 | Codex；可用稳定公开接口时也优先复用其原生 Voice |
| 工作台业务数据、个人身份、长期记忆和跨入口上下文 | NEXUS Kernel |
| 可恢复任务、审批策略、证据、审计和紧急停止 | NEXUS Mission 与工具层 |
| 唤醒、贾维斯形象、活动投影和本地权限引导 | NEXUS 桌面产品层 |

若需求仅为“和 Codex 说话并让它操作电脑”，直接使用 ChatGPT 桌面端的 Voice in Codex；NEXUS 不重复实现这一通用产品。NEXUS 贾维斯只承载工作台专属上下文、持久任务、治理策略和用户可控的本地集成。

## 原因

- Codex App Server 已提供 NEXUS 使用的 initialize、thread、turn、item、审批和 MCP 协议，无需继续发布 fork 运行时。
- `jarvis-codex` 的 WebRTC 实现验证了 Codex Realtime 的可行性，但它不提供 NEXUS 已有的持久 Mission、分级审批、业务事实工具、断线恢复和证据日志。
- 直接换成该项目会丢失业务语义层，也会把实验性语音与执行生命周期绑死。
- [ChatGPT 桌面端已经提供 Voice in Work/Codex](https://help.openai.com/en/articles/20001275-chatgpt-work-and-codex)，但该产品能力不等于面向第三方客户端的稳定嵌入契约。[公开 App Server 文档](https://developers.openai.com/codex/app-server)尚未列出 `thread/realtime/*`；本机 Codex 0.149.1 将 `realtime_conversation` 标记为 `under development` 且默认关闭。

## 边界

- NEXUS 拒绝 App Server 的无沙箱直通方法；有副作用的动作仍经自定义 permission profile 和 `ApprovalBroker`。
- 桌面、浏览器和工作台能力仍按结构化 API → MCP → DOM/CDP → macOS AX → 视觉操作的顺序选择。
- Codex 二进制版本、Apache-2.0 许可和打包组件必须进入 SBOM。

## 验证

- 实机 `initialize` 和 `account/read` 握手成功，返回 `accountType=chatgpt`。
- 用本地 0.149.1 协议 schema 核对 `thread/start`、`turn/start`、`turn/steer`、`turn/interrupt`、`thread/queue/add` 和审批请求。
- 假 App Server 回归覆盖流式、排队、打断、超时、崩溃恢复、审批与未知请求拒绝。
