# ADR-003：后端技术栈选择 Python FastAPI 单主栈 + 异步任务 Worker

- 状态：accepted（2026-08-17 scholar 确认）
- 日期：2026-08-17
- 决策人：scholar

## 背景与约束

scholar 明确允许多服务、多语言（Java/Python/Rust/Go 均可），目标是最好的性能与业内最佳实践。"允许多语言"不等于"应当多语言"——每多一种语言就多一套构建、依赖、调试与 AI 协作上下文，个人项目的最佳实践是**按依赖生态选语言，按负载特征拆服务**。

## 驱动因素

盘点各能力模块的关键依赖归属生态：

| 能力 | 关键开源依赖 | 生态 |
| --- | --- | --- |
| YouTube 下载 | yt-dlp | Python |
| ASR 字幕转写（词级时间戳） | faster-whisper / whisperX | Python |
| 免费多音色 TTS | edge-tts | Python |
| 本地 TTS（可选） | kokoro | Python |
| 免费翻译聚合（Bing/Google/有道等） | translators | Python |
| FSRS 间隔重复调度 | py-fsrs | Python |
| LLM 多供应商编排 | LiteLLM | Python |
| 实时语音管线（自建备选） | pipecat / livekit-agents | Python |
| epub 解析（服务端侧） | ebooklib | Python |

九项核心依赖全部原生 Python。选 Java/Go/Rust 做主服务意味着每一项都要跨进程封装或找质量更低的移植品。Web 框架本身的吞吐差异（FastAPI vs Spring vs Go）在本产品毫无意义：瓶颈全在外部 API 延迟和 whisper 推理，单用户 QPS 个位数。

真正需要隔离的是**负载特征**：HTTP API（毫秒级、常驻）与媒体处理（分钟级、吃满 CPU/GPU）不能同进程。

## 候选方案

| 方案 | 评估 |
| --- | --- |
| A. Java Spring Boot 主服务 + Python 工具服务 | 所有 Python 依赖都要包一层 HTTP/gRPC，纯增熵 |
| B. Go/Rust 主服务 + Python 工具服务 | 同上；性能收益在本场景不存在 |
| C. Python FastAPI 主服务 + 同代码库异步 Worker | 依赖零封装直用；一套语言一套模型定义；进程级隔离负载 |
| D. 微服务全家桶（网关/多服务/K8s） | 旧版已明确教训：为未来规模提前引入复杂度是反模式 |

## 决定

**方案 C**。服务拆分以 Docker Compose 为编排单位：

| 服务 | 技术 | 职责 |
| --- | --- | --- |
| `api` | FastAPI + SQLAlchemy 2 + Pydantic v2（uv 管理，Python 3.12+） | 全部业务 API：词库、书库、学习记录、翻译编排、AI 解释持久化、TTS 编排、实时语音会话签发 |
| `worker` | 同代码库 + arq（Redis 队列） | yt-dlp 下载、whisper 转写、epub 解析入库、整篇翻译、TTS 批量合成 |
| `litellm` | LiteLLM Proxy（现成镜像） | LLM 供应商动态配置与统一转发（详见 ADR-004） |
| `postgres` | PostgreSQL 16 | 结构化数据 + 全文检索 |
| `redis` | Redis 7 | 任务队列、缓存、进度发布 |
| `web` | Nginx（静态托管前端构建产物，反代 api） | 入口 |

媒体文件（视频、音频、书籍原件）存本地卷，由 `api` 提供 HTTP Range 流式访问，不引入 MinIO（个人部署无必要）。

## 后果

- 一套 Python 代码库（monorepo 内 `server/`），API 与 Worker 共享模型与服务层，无跨语言契约维护成本。
- whisper 转写吃 CPU/GPU 时不影响 API 响应（进程隔离 + 队列削峰）。
- 若未来某模块确有极端性能需求（如自建实时语音网关），再按 ADR 流程单独引入 Go/Rust 服务，本 ADR 不预设。
- Java/Spring 偏好在本项目后端不适用，需在项目规范中声明。

## 验证与复审日期

- 验证：M1 完成 `api`+`worker`+`postgres`+`redis` Compose 骨架，跑通"导入 epub → 解析入库 → 点词翻译落库"链路。
- 复审：实时语音自建管线立项时。
