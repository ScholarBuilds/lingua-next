# ADR-019：桌面 SQLite 作为默认开发运行档

- 状态：accepted
- 日期：2026-09-03
- 决策人：scholar
- 补充：ADR-013、ADR-014；替代 ADR-016 中“开发默认 PostgreSQL + Redis”的部分

## 决定

源码开发和安装包统一采用 `desktop` 领域运行档：SQLite 持久化、数据库任务队列、API 进程内消费者。本地一键启动不要求 Docker、PostgreSQL、Redis 或独立 Arq worker。

服务器和需要多进程压力验证的开发场景保留 `developer` 档，使用 PostgreSQL、Redis 和独立 Arq worker。两种运行档共享领域模型、路由和任务实现，通过数据库与 QueuePort 选择基础设施。

讲义 Markdown 在 desktop 档复制到托管数据目录。外部 Obsidian 目录只作为导入源，导入不覆盖冲突文件；正文、SQLite、媒体和凭据主密钥因此能遵循同一套桌面备份边界。

## 原因

- 日常开发应覆盖最终安装包真实运行路径，避免“开发档正常、sidecar 失败”的双重语义。
- 单人本地工作台不需要 PostgreSQL/Redis 的常驻成本；进程更少也缩短启动和故障定位链路。
- PostgreSQL 仍适合服务端部署、多 worker 和数据库专项验证，不应从仓库删除。
- 外部绝对路径无法随安装包迁移；托管副本能让首次设置、备份和恢复具有明确边界。

## 后果

- SQLite schema 必须有独立基线和可移植的前向迁移，不能直接重放 PostgreSQL 专属历史迁移。
- 需要 PostgreSQL 行为、LISTEN/NOTIFY 或多 worker 并发时必须显式选择 `--mode developer`。
- Obsidian 后续修改不会自动同步到托管副本；需要再次导入，同名冲突由用户处理。
