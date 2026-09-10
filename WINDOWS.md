# Windows 打开 NEXUS

这是从源码启动 Electron 桌面窗口的入口，不是安装版 EXE。推荐 Windows 11 x64。

首次使用，在 PowerShell 安装工具：

```powershell
winget install --id OpenJS.NodeJS.LTS -e
winget install --id astral-sh.uv -e
```

重新打开 PowerShell，安装 pnpm：

```powershell
npm install -g pnpm@11
```

下载或克隆仓库，解压后双击根目录的 `start-nexus.bat`。首次联网下载 Python 3.12、依赖与 Electron，之后自动打开桌面窗口。依赖使用项目锁文件，运行需要 Node.js 22 或更高兼容版本。

默认使用本地 SQLite，无需 Docker、PostgreSQL、Redis。公开版本随附的阅读、示例视频和讲义自动导入；AI 服务请自行在设置里填写密钥。个人学习数据保存在 `data/desktop`，不要删除这个目录。

在仓库目录的 PowerShell 中也可以运行：

```powershell
.\start-nexus.bat
.\start-nexus.bat --status
.\start-nexus.bat --stop
```

关掉窗口后若要同时停掉后台服务，使用 `--stop`。启动失败时查看 `data/logs/api.log`、`web.log`、`desktop.log`。首次下载请保持网络连接；改完依赖环境后重新打开终端。不要把 macOS 的 `.venv` 或 `node_modules` 复制到 Windows。

`--browser` 可只打开浏览器；macOS 的 `--installed`、`--dist` 不适用于 Windows。本机 macOS 声音不可在 Windows 使用，其他平台专属功能仍受原有可用性提示约束。

Windows CI 验证源码启动链路与进程存活，不代表所有音频、外设和桌面交互都完成 Windows 实机验收。
