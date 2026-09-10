# NEXUS Desktop

Electron 壳负责加载工作台、启动打包内的本地 sidecar、处理外链与下载、提供托盘入口和安装更新。贾维斯辅助窗口、常听唤醒、Codex 与 CuaDriver 运行时已按 CR-016 退场。

## 本地开发

仓库根目录运行 `./Start NEXUS.command`，默认以 `desktop + SQLite` 开发档启动 API、进程内任务队列、Web 和 Electron，不要求 Docker、PostgreSQL 或 Redis。需要验证服务器拓扑时使用 `./start-nexus.sh --mode developer`。桌面目录中的常用命令：

```bash
pnpm build
pnpm test
pnpm probe
```

探针需要 API 与 Web 已运行，验证主窗口、preload 合同、外链、下载、文件拖放、麦克风 API、全屏、录音格式、画布和托盘。

## 桌面运行时

`pnpm runtime:prepare` 生成：

- Web 静态产物；
- Python sidecar；
- SQLite 基线；
- 口语场景数据；
- 合规清单与运行时 manifest。

- 内容种子：词典 / 查词索引 / 音标 / 语法 / 内置书从 `data/desktop/nexus.sqlite3` 拷进基线（`NEXUS_CONTENT_DB` 可换，`none` 出空库），内置书与封面、讲义正文、faster-whisper small、ffmpeg 与 deno 分别放 `media-seed` / `grammar-seed` / `models-seed` / `bin`，壳首启铺到用户目录。内容戳 `runtime/content-stamp.json`（基线库 + 三个种子目录的哈希）决定要不要重铺：壳按戳铺种子，sidecar 启动见用户目录的戳与包内不同就把基线合并进用户库（只补缺，用户数据不动）。
- 配置随包：开发库的凭据 / 模型部署 / 能力绑定 / 按词音色 / 设置项导出成 `bundle-config.sqlite3`，敏感字段换成随机包密钥 `bundle-vault.key`；sidecar 启动按两个文件的哈希合并进用户库（只补缺）再换成本机主密钥。`NEXUS_BUNDLE_CONFIG=0` 出不带配置的包，`NEXUS_BUNDLE_PERSONAL_ACCOUNTS=1` 才带 Gmail 账号；`network` 代理设置永远不带。

安装包不依赖源码目录、Python、uv、Docker、PostgreSQL、Redis、Homebrew 或网络（模型 / 密钥相关功能除外）。首次运行的数据写入 `~/Library/Application Support/NEXUS`，缓存写入 `~/Library/Caches/NEXUS`。

## 分发

- `pnpm dist:mac:friends`：熟人内测的 ad-hoc 构建。
- `pnpm dist:mac`：Developer ID、公证与签名更新源的正式构建。

发布配置与签名要求由 `scripts/release-mac.mjs` 和 `scripts/sign-mac.cjs` 校验。
