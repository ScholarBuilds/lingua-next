# ADR-004：LLM 接入采用 LiteLLM 统一网关，供应商运行时动态配置

- 状态：accepted（2026-08-17 scholar 确认）
- 日期：2026-08-17
- 决策人：scholar

## 背景与约束

需求 FACT：支持动态配置所有能接入的 LLM 供应商（OpenAI、Anthropic、Google、DeepSeek、通义、Kimi、豆包、本地 Ollama 等），运行时增删模型与密钥，不改代码。同时 AI 翻译、单词解释、语法分析、AI 陪读、语音对话文本侧全部消费 LLM 能力，需要统一的路由、重试、用量记录。

## 驱动因素

- 自研多供应商适配层是旧版踩过的深坑（每家 SDK、鉴权、流式格式都不同），业内已有成熟开源方案。
- 需要按"能力档位"路由：翻译用便宜快模型、语法精讲用强模型、陪读用长上下文模型——路由规则本身也要可配置。

## 候选方案

| 方案 | 评估 |
| --- | --- |
| A. 自研适配层（旧版路线） | 重复造轮子，明确否决 |
| B. new-api（Go，含管理 UI 的网关站） | 功能全但定位是"售卖分发 API 的站点"，多用户/计费/渠道概念对个人项目过重 |
| C. LiteLLM Proxy 独立容器 | 100+ 供应商统一成 OpenAI 格式；数据库驱动的运行时模型/密钥管理 + Admin UI；虚拟 Key、预算、用量、fallback、重试开箱即用；MIT 许可 |
| D. LiteLLM SDK 内嵌进 FastAPI | 少一个容器，但失去 Admin UI 与独立用量面板，配置管理要自研 |

## 决定

**方案 C：LiteLLM Proxy 独立容器**，配 PostgreSQL 持久化配置。

- 业务侧（api/worker）只面向一个 OpenAI 兼容 endpoint，模型名用**语义别名**：`translate-fast`、`explain-standard`、`grammar-deep`、`companion-long`、`realtime-voice`。别名到真实供应商模型的映射在 LiteLLM 后台随时改。
- 供应商增删、密钥轮换、fallback 链、预算上限全部走 LiteLLM Admin UI / API，业务代码零改动。
- 应用内"模型设置"页面直接调 LiteLLM 管理 API 做一层简化封装，scholar 不必离开产品界面。

## 后果

- "接入所有能接入的 LLM"退化为配置问题而非开发问题。
- 全部 LLM 用量集中在一处统计，成本可见。
- OpenAI Realtime（WebRTC 语音）不走文本网关，密钥签发由 `api` 服务单独处理（见 ADR-005），LiteLLM 只管文本/流式文本。
- 引入一个第三方管理面，升级跟随其版本节奏。

## 验证与复审日期

- 验证：M1 配置两家供应商 + 一条 fallback 链，验证别名切换不动业务代码。
- 复审：LiteLLM 若出现维护风险时评估 new-api / 自研收敛。
