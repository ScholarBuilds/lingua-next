# Lingua 画布工具 · Photoshop UXP 面板

把 Photoshop 接入 Lingua 创作工坊。插件不保存 API Key，模型部署、密钥、任务与生成资产全部复用 Lingua Web 的配置和后端。

## 功能

- 浏览 Lingua 图片资产、画布引用资产和网页采集素材，并置入 Photoshop 图层。
- 把当前文档或当前图层导出为 PNG，上传到 Lingua 统一素材库。
- 使用 Lingua 已启用的图片模型直接生成，参考图编辑走持久任务队列。
- 运行 Lingua 中配置的 RunningHub / ComfyUI 工作流。
- 使用 Lingua GPT 持久对话；`chat-general` 负责对话，`image-free` 负责 Agent 出图。
- 选区模式可上传当前矩形选区，并把生成结果缩放、贴回原位置。

## 安装

面板不走 Creative Cloud / Adobe Exchange 分发，就必须用 UXP Developer Tool 加载，
这一步消不掉。Lingua 的「创作工坊 → 连接器」页面会显示同样三步，并给出本机
`manifest.json` 的绝对路径可一键复制。

1. 安装 Adobe UXP Developer Tool，并打开 Photoshop 24.0 或更高版本。
2. 在 UXP Developer Tool 里选择 `Add Plugin`，加载本目录的 `manifest.json`。
3. 点击 `Load`，从 Photoshop 的「增效工具」菜单打开「Lingua 画布工具」。

运行 `./start-nexus.sh` 启动 NEXUS 前端、后端和 worker 后，在面板设置里填写地址并点「连接」：

- 本机：`127.0.0.1:5173`
- 局域网：运行 Lingua 的 Mac IP，例如 `192.168.1.10:5173`

连上后工坊连接器页面会显示「已连接」。

面板访问的是 Vite Web 地址；`/api` 会代理到本机 `8100` 后端，因此局域网不必单独暴露后端端口。

## 打包分发

    python3 tools/package_connectors.py

产物固定落在 `tools/dist/`：

| 产物 | 用途 |
| --- | --- |
| `lingua-photoshop-connector/` | 干净的可加载目录，UDT `Add Plugin` 选里面的 manifest.json |
| `lingua-photoshop-connector.zip` | 拷给别人，对方解压后同样用 UDT 加载 |

脚本不产出 `.ccx`：Creative Cloud 能双击安装的 `.ccx` 必须由 UXP Developer Tool 的
`Package` 动作签名产出，签名密钥在本机 UDT 里。放一个同名的未签名压缩包只会骗人，
具体做法见 `tools/dist/README.md`。

## 接口契约

| 用途 | 方法 / 路径 |
| --- | --- |
| 读取资产、画布和工作流目录 | `GET /api/studio/connectors/catalog` |
| 导入图片、视频、音频或文件 | `POST /api/studio/connectors/import` |
| UXP 图片兼容转码 | `GET /api/studio/connectors/images/{id}/jpeg` |
| 参考图编辑任务 | `POST /api/studio/connectors/edit-job` |
| 普通图片生成 | `POST /api/images/jobs` |
| 工作流运行 | `POST /api/studio/workflows/{id}/runs` |
| GPT 对话 | `/api/studio/gpt-chats` |
| 连接状态（只读） | `GET /api/studio/connectors/status` |

## 限制

- Photoshop UXP 运行时只能在真实 Photoshop 中完成端到端验证；仓库检查只能覆盖 JavaScript 语法、manifest 和后端协议测试。
- Agent 使用 Lingua 的语义模型绑定，不在插件里单独选择或保存模型密钥。
- 素材与画布使用 `WS /api/studio/connectors/events` 实时同步；后端从持久化数据判定变化，Web、worker、Chrome 或 Photoshop 从任意入口写入都会刷新面板。
- 面板连接后每 45 秒向 `GET /api/studio/connectors/status` 报一次心跳，工坊连接器页面据此显示连接状态。面板版本写在 `js/state.js` 的 `DX.VERSION`，UXP 运行时读不到自己的 manifest，改版本号要两处一起改（有测试拦）。
- 视频和音频可在 Lingua 素材库中管理，但 Photoshop 面板只把图片置入图层。

## 文件结构

```text
index.html       面板结构
style.css        UXP 面板样式
js/state.js      状态与本地设置键
js/net.js        Lingua HTTP、上传和图片兼容层
js/sources.js    图片 / 画布 / 网页采集素材适配器
js/ps.js         Photoshop 导出、置入和选区操作
js/socket.js     低频素材同步
js/generate.js   图片模型与工作流执行
js/agent.js      Lingua GPT 持久对话
js/app.js        面板初始化与交互
```
