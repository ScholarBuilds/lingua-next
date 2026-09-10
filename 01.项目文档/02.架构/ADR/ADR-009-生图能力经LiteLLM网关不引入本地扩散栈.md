# ADR-009：生图能力经 LiteLLM 网关，不引入 ComfyUI 或本地扩散栈

- 状态：accepted（2026-08-20 scholar 确认，需求驱动）
- 日期：2026-08-20
- 决策人：scholar

## 背景与约束

产品里至少六处需要图，目前全在用替代物兜底：单词本封面是 emoji + 确定性渐变、
书籍缺封面时退化成排版式书名页、对话场景卡与场景短文根本没有图。

scholar 的要求是「抄开源不要重复造轮子，能起现成服务就起」，同时明确指出
gpt 中转里已有 `gpt-image-2` 可用，且「后面会不断加入更多生图模型」。

硬约束：

- 开发机是 macOS，无 NVIDIA 显卡
- 密钥永不入库、不回显；业务代码禁止硬编码供应商与模型名（CLAUDE.md 原则 5）
- Compose 已有 postgres / redis / litellm / nginx 四个服务，不想再加

## 选项对比

| 选项 | 事实 | 缺点 |
| --- | --- | --- |
| A. ComfyUI 跑本地扩散模型 | 需要 torch + CUDA，模型权重按 GB 计 | macOS 无 N 卡，跑不动；与「用 gpt-image-2」的诉求根本不是一回事 |
| B. ComfyUI 的 Partner Nodes 调托管模型 | 官方文档明写：**必须登录 Comfy 账号且账号积分 > 0**，闭源模型「不支持免费使用」（docs.comfy.org/tutorials/partner-nodes/overview） | **用不了 scholar 自己的 gpt 中转 key**——钱要经 Comfy 再花一次。直接否决 |
| C. Fooocus / InvokeAI / SwarmUI / A1111 | 同为本地扩散 UI | 与 A 同样的问题 |
| D. 自己写各供应商适配 | 完全可控 | 每加一个供应商写一遍鉴权、参数映射、错误分型——正是要避免的重复造轮子 |
| E. **LiteLLM 网关（已在栈内）** | 已支持 `/v1/images/generations`，覆盖 OpenAI、Gemini/Imagen、Stability、Recraft、Black Forest Labs、Bedrock Nova、Vertex、RunwayML、OpenRouter；注册时 `model_info.mode: image_generation` 即可 | 上游行为差异要自己吃（见「待验证」） |

## 决策

**采纳 E：生图与 LLM 共用同一个 LiteLLM 网关，按语义别名路由。**

三个别名 `image-cover` / `image-illustration` / `image-free`，与既有六个 LLM 别名
同住网关，唯一差别是注册时带 `model_info: {"mode": "image_generation"}`。

### 绑定的是既有 LLM 凭据，不新建一套

实测 scholar 的「gpt 中转」凭据模型列表里就有 `gpt-image-1` / `gpt-image-1.5` /
`gpt-image-2`——生图模型与聊天模型住在同一个 OpenAI 兼容端点后面。逼用户再录一遍
同一把 key 没有道理。能力绑定的可选凭据范围因此放宽到 `kind ∈ (llm, image)`，
`image` 这个 kind 留给将来只有生图能力的供应商。

### 提示词模板方法论抄本机 skill

`~/.claude/skills/gpt-image-2` 的七段式 JSON 骨架（`type / goal / subject / scene /
layout / style / constraints`）与「必问 / 可默认 / 可随机」参数三分类直接复用，
适配是把「问用户」换成「问 LLM」——平台已经握有场景本的标题、描述、关键词、CEFR。

## 理由

零新增基础设施：LiteLLM 在 `deploy/docker-compose.yml` 里已经跑着，
`STORE_MODEL_IN_DB=True` 已开，`POST /model/new` 已被 `domain/litellm_admin.py` 封装。
用量与预算统计因此天然覆盖生图——模块 10 的 `/spend/logs` 按别名聚合，不用另建一套。

「后面不断加入更多生图模型」这条需求由网关兜住：换模型 = 在配置中心改一次绑定；
换供应商 = LiteLLM 已支持的直接选。业务代码里不会出现任何模型名。

## 影响

- `domain/credentials.py` 增 `IMAGE_CAPABILITIES`，`sync_llm_binding` 增 `mode` 形参
- `domain/litellm_admin.py` 的 `add_model` 增 `model_info` 形参
- 配置中心增「生图服务」分区（不复用 `BindingCard`，理由见下）
- 新增 `image_asset` / `image_job` 两表与 `wordlist.cover_key` 一列
- Pillow 从 dev 组提到主依赖

## 待验证 / 已实测

以下三条是 2026-08-20 用 gpt 中转 + gpt-image-2 实测的，都不是从文档能推出来的：

| 事实 | 实测 | 影响 |
| --- | --- | --- |
| **`size` 参数不决定出图比例，提示词里写的画布才决定** | 同样请求 1536x608：提示词带 `layout.canvas` 的回 1994x789（2.527:1）；手写提示词没带的回 1536x1024（1.500:1） | 手写提示词路径必须补画布句（`image_prompts.ensure_canvas`），否则封面静默变形 |
| 上游不返回精确像素，按自己的档位放大 | 请求 1024x1024 回 1254x1254 | `size_req` 与实际 `width/height` 必须分开存 |
| 该中转不回 `model` 字段 | `ImagesResponse.model` 为 None | `model_reported` 允许为空，别拿它做判据 |

「测一下」按钮不复用 LLM 那套：它打的是 `chat/completions`，生图别名走那条必炸；
且一次出图是真花钱的，端到端验证改成用户显式点的「试出一张图」。
