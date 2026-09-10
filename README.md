# lingua-next（产品名 NEXUS）

## 开源版开箱内容

默认桌面启动 `./start-nexus.sh --browser` 会自动导入经过白名单导出的学习内容：

- 40 本经典英文书，含已解析章节、段落与句子，可直接阅读。
- 338 篇英语讲义，包含软件英语文字教程。
- 1 段原创入门视频，带英文字幕和中文翻译，可直接播放。

初始数据约 43 MB 压缩包，随 Git 仓库提供；导入无需 AI 密钥，不会覆盖用户已有的讲义编辑。
首次安装需 Python 3.12、Node.js 22、uv、pnpm；启动器会安装项目依赖。语音、AI、转写等额外能力
需要使用者配置自己的服务或下载相应模型。没有随仓库提供任何可用的服务密钥或账号。

软件教程中涉及个人信息的原始截图未公开，原位置有明确提示。第三方视频保留公开来源链接，
未再分发下载的视频和字幕。内容许可见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
MIT 适用于本项目原创代码，第三方依赖与素材保留各自许可。

内容包有逐文件 SHA-256 清单；首次导入和重复启动均校验完整性。书籍或视频 ID 与用户已有内容
冲突时保留用户数据并报告冲突，不会把书籍章节或视频字幕挂到错误的对象上。

仓库、包名、环境变量、数据库沿用 `lingua` 标识；用户看到的名字与图标是 NEXUS（蓝色连接小精灵，`web/public/brand/`、`desktop/assets/icon.png`）。

装在自己电脑上的个人工作台：学英语（词库背单词 · 书库精读点译 · 视频字幕学习 · AI 实时语音对话）、管理账号与邮件、编排日常任务。单人、无登录；默认桌面开发档使用 SQLite 与进程内任务队列，PostgreSQL + Redis/Arq 作为服务器和专项开发档保留（ADR-019）。

## 快速启动

一键启动：双击 macOS 的 `Start NEXUS.command`（或终端 `./start-nexus.sh`，Windows 用 `start-nexus.bat`）。
每次执行都是**重启一遍**：把上一次的 API / worker / Web / 桌面壳停掉，默认使用
`data/desktop/` 下的 SQLite 与 API 内置任务消费者，再打开当前源码的 Electron 桌面壳。API、Web
或桌面壳任一启动失败时，脚本会报错并清理这一轮已拉起的进程，不会把半套服务报成可用。
服务脱离终端跑，日志在 `data/logs/`，pid 在 `data/run/`；改了代码忘记重启，再双击一次就行。
桌面壳只在 TypeScript 源码或构建配置变更时重新编译；日常本地启动不打包、签名或覆盖
`/Applications/NEXUS.app`。

```bash
./start-nexus.sh               # desktop + SQLite，开源码 Electron 壳
./start-nexus.sh --browser     # 显式改开浏览器
./start-nexus.sh --no-open     # 只起 API 内置队列和 Web
./start-nexus.sh --installed   # 用开发服务打开已安装的 /Applications/NEXUS.app
./start-nexus.sh --status      # 看各进程与健康状态
./start-nexus.sh --stop        # 停 API / worker / Web / 壳（容器留着）
./start-nexus.sh --mode developer # PostgreSQL + Redis/Arq 专项开发档
./start-nexus.sh --mode docker # 全容器拓扑，入口 http://127.0.0.1:8080
```

全容器部署首次使用时先复制部署配置：

```bash
cp deploy/.env.example deploy/.env
docker compose -f deploy/docker-compose.yml up -d
```

打开即用，没有登录页（ADR-013）；局域网访问是显式开关。

开发模式：

```bash
# 服务端（需 uv）
cd server && uv sync && uv run uvicorn app.main:app --reload --port 8100

# worker
cd server && uv run arq worker.main.WorkerSettings

# 前端（需 pnpm）
cd web && pnpm install && pnpm dev
```

## 目录

| 目录 | 内容 |
| --- | --- |
| `web/` | React 18 + TS + Vite SPA |
| `server/` | Python 3.12：FastAPI api + arq worker 共用代码库 |
| `deploy/` | docker-compose、nginx、环境变量模板 |
| `desktop/` | Electron 壳与探针（装现有 SPA，只贡献系统入口） |
| `design/mockups/` | 高保真 UI 原型（浏览器直接打开 index.html） |
| `00.需求文档/` `01.项目文档/` `02.项目规范/` | 项目治理三根目录（需求/架构/规范的事实来源） |

## 文档入口

- [产品愿景](00.需求文档/00.产品总览/01.产品愿景与范围.md) · [功能需求](00.需求文档/02.功能需求/README.md) · [MVP 路线图](00.需求文档/00.产品总览/02.MVP与路线图.md)
- [系统架构](01.项目文档/02.架构/01.系统架构总览.md) · [ADR](01.项目文档/02.架构/ADR/) · [技术栈](01.项目文档/01.技术栈与版本/01.技术栈清单.md)
- [UI 设计](01.项目文档/03.UI设计/README.md)

Windows 源码桌面启动：双击 `start-nexus.bat`，首次准备步骤见 [Windows 启动说明](WINDOWS.md)。
