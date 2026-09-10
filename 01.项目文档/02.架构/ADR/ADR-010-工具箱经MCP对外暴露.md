# ADR-010：工具箱经 MCP 对外暴露，manifest 只投影不复制

- 状态：accepted（2026-08-22，调研 §5.6）
- 日期：2026-08-22
- 决策人：scholar

## 背景与约束

M57 之后，创作工坊的每个可执行能力都在 `domain/tool_execution.py` 的 operation 注册表
登记一次：输入合同（pydantic 模型）、prepare、worker 分派、任务类型、恢复策略挂在同一个
`ToolOperationSpec` 上。REST（`POST /studio/tools/{tool_id}/runs`）、画布级联、DAG 节点、
任务中心重试和 arq 函数表全部从这张表派生。

缺的是**给别的 Agent 用的入口**。dsh、Claude Code、Codex 想调 lingua 的出图、视频、
工作流，只能各自照着 HTTP 文档手写客户端，而合同（尤其是十几个字段的 `ImageGenerateInput`）
是会变的。

硬约束：

- 不得出现第二份校验。合同的唯一事实源是注册表，别的地方只能读。
- 不改既有调用面：画布、REST、Agent 继续直调 `start_tool_operation`。
- 出图几十秒、视频几分钟，长任务不能占着一条同步连接等结果。
- 这是个人自用的单机部署，端点只对本机开放，密钥不进任何返回体。

## 选项对比

| 选项 | 优点 | 缺点 |
| --- | --- | --- |
| A. 让外部 Agent 直接调 REST | 零新增代码 | 每个客户端自己写一遍鉴权、轮询、产物解析；合同变了没人知道 |
| B. 生成 OpenAPI 客户端分发出去 | 有类型 | 生成物是快照，与注册表二次分叉；工具发现、超时、取消都要各自实现 |
| C. 嵌入 DeepSeek harness 做 Agent 宿主 | 自带会话与技能 | 它的 SDK 只有 `initialize / session.prompt / shutdown`，无 cancel、无审批回调，覆盖不了 PostgreSQL 台账与 arq 异步任务（调研 §1 已裁决不嵌入） |
| D. **官方 `mcp` Python SDK 起 streamable-http 端点** | 工具发现、schema、错误语义是协议的一部分；dsh（`dsh-mcp-client` 支持 streamable-http、`toolCallTimeoutMs` 可调到 600000）、Claude Code、Codex 都是现成客户端 | 多一个依赖；长任务要自己拆 submit/wait |

## 决策

**采纳 D：`server/app/mcp_server.py` 把 operation 注册表投影成一个 streamable-http
MCP server，挂在 FastAPI 的 `/mcp` 上。**

### MCP 是投影，不是新入口

- 工具清单来自 `list_operations()`；每个能力的 `inputSchema` **就是**
  `spec.input.model_json_schema()` 的原样拷贝，不写第二份。
- 调用链是 `parse_tool_operation_input` → `start_tool_operation`，与 REST 完全同一条。
  校验、建任务、提交事务、投递 worker 全在领域层，MCP 层只做协议搬运。
- 新接一个 operation，MCP 清单自动多一项，`app/mcp_server.py` 不用改。
  守卫在 `tests/test_mcp_server.py::test_new_operation_shows_up_without_touching_this_module`。

### 长任务拆 submit + wait

| 工具 | 作用 |
| --- | --- |
| `<operation>_submit` | 提交一次调用，返回 `task_id` 与初始状态；已终态的能力直接带回完整结果 |
| `task_wait` | 按 `task_id` 轮询到终态或超时；超时只是没等到，任务照跑 |
| `task_status` | 只读快照，不等待 |
| `list_capabilities` | 列出全部 operation、归属插件与输入输出合同 |

工具名把点号换成下划线（`image.generate` → `image_generate_submit`），MCP 的工具名不收点号。

产物一律以 TypedRef 返回（`asset:N` / `media:N` / `text:<task_id>`），不内联字节——
一次出图四张 4K 图塞进 JSON 对模型上下文是灾难。TypedRef 的解析口径复用
`domain/canvas_projector` 的 `task_node_type` / `task_items`，与画布落图是同一份规则。

### 鉴权：Bearer + 回环双闸，默认关闭

- `LINGUA_MCP_TOKEN` 是唯一开关。**不配就不挂载**，启动日志说明这一点；工具箱仍可经
  REST 与画布调用。
- 挂上之后两道闸：请求方必须是回环地址（`127.0.0.1` / `::1`），且
  `Authorization: Bearer <token>` 精确匹配（`secrets.compare_digest`）。
  另外开着 SDK 的 DNS rebinding 防护，`Host` / `Origin` 只认 localhost，浏览器页面
  拿不到这条端点。
- 没走 SDK 的 OAuth 资源服务器那套：那是给多租户发 token 用的，单机个人部署配一个
  静态 token 更直接，也不用再起授权服务器。

### 台账

MCP 发起的任务 `source_route` 记 `mcp:<client>`（客户端名取自 `initialize` 的
`clientInfo.name`），`source_context` 记 `{"source": "mcp", "client": ...}`，
prepare 期间的模型调用进 `invocation_context(source="mcp")`。任务中心与账本因此能按
来源筛出「哪些是外部 Agent 发起的」。

回给模型的所有文本与结构化内容先过 `domain.model_invocations.safe_payload`：密钥类键
`[REDACTED]`、`Bearer xxx` 与 `sk-…` 内联脱敏、超长字符串截断。校验失败的报错也走这条
——pydantic 的 `errors()` 会把用户传进来的值原样带出来。

## 不暴露什么

| 不给 MCP | 理由 |
| --- | --- |
| 凭据管理（`/config/credentials/*`） | 密钥永不出库、不回显是全项目铁律；让 Agent 有能力读写凭据等于把这条作废 |
| 配置写入（绑定、部署、图片默认值、预算） | 这些改的是全局行为，一次误调影响之后每一次出图；配置只在设置页由人改 |
| 删除类操作（画布回收站清空、资产删除） | 不可逆，且外部 Agent 没有确认交互 |
| 画布文档读写 | 画布是前端的编辑面，服务端 projector 已负责落图；开放整份文档只会多一条并发写入路径 |

MCP 只暴露「跑一次能力 + 查任务」这一面。要改配置的场景，让 Agent 引导人去设置页。

## 影响

- 新增依赖 `mcp>=2.0`（含 `mcp-types`、`sse-starlette`），登记进开源复用清单。
- `app/config.py` 新增 `mcp_token` / `mcp_path` / `mcp_wait_timeout` /
  `mcp_wait_max_timeout` / `mcp_poll_interval` 五项。
- `app/main.py` 加两行：`from app.mcp_server import mount_mcp` 与 `mount_mcp(app)`。
  `mount_mcp` 会把 streamable-http 的会话管理器接进 app 既有的 lifespan（不是替换）。
- `domain/tool_plugins.py` 的 `workflow-center` 认领 `flow.run` / `flow.resume` 两项能力
  ——以前没有任何插件声明它们，`require_tool_operation` 一律挡在门外。

## 遗留：flow.run / flow.resume 的分派

M62 给 DAG 引擎登记了 `flow.run` / `flow.resume` 两个 operation，但没声明 `task_types`：
引擎内部自己 `prepare()` 自己入队，功能完整；外部入口走 `start_tool_operation` 会卡在
`queue_call_for`。

投影层因此加了 `is_dispatchable`：没有 `task_types` 又不在 `ROUTER_OPERATIONS`（只做分流、
落库任务类型属于被分流能力的 `image.auto`）里的能力不投影——**宁可不列，也不暴露一个
调不通的工具**。`tool_execution.py` 给这两个 operation 补上 `task_types` 与 queue 之后，
它们自动出现在 MCP 清单里，本文件与投影层都不用改。这条链路已由
`tests/test_mcp_server.py::test_flow_run_is_submittable_once_dispatch_is_wired` 验证。

## 与 dsh 的位置

dsh 作为 agent provider（调研路线 C）仍待评估，取决于 P4 的 AgentLoop 落地后是否还需要
「编码型 Agent + 子代理 + skills」。无论走不走那条路，工具定义都只有这一份：dsh 经
MCP 客户端消费，lingua 自己的 Agent 经 `kernel.tools` 消费，两边读同一张注册表。

## 修订记录

**2026-09-02 修订 1（CR-009 §6 / CR-010 D-3、STD-SEC-005 提案）**：「`LINGUA_MCP_TOKEN` 不配就不挂载」改为「API 进程**总是**在回环地址挂载 `/mcp`，未配置固定令牌时用进程内随机 Bearer（`mcp_server.runtime_mcp_token`），令牌只注入贾维斯引擎子进程 env，不落盘、不回显」。原因：贾维斯执行内核（ADR-015）经 MCP 调工作台能力，没有出口它就只剩 shell。安全边界不变：回环 + Bearer + DNS rebinding 防护三道闸；CR-010 再加两个同样受 `LoopbackBearerGuard` 保护的门代理端点 `/mcp/desktop`（cua-driver 私有 bounded daemon）与 `/mcp/browser`（agent-browser core），每次工具调用过内核审批席位。「不暴露凭据管理 / 配置写入 / 删除类操作」清单对贾维斯这个新消费者继续成立；保险箱 fill-only 的原生执行者若要做，须再修订本 ADR。
