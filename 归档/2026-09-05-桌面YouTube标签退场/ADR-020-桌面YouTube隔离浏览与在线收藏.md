# ADR-020：桌面 YouTube 隔离浏览与在线收藏

- 状态：accepted，运行验证未完成
- 日期：2026-09-04
- 补充：ADR-014、ADR-019

## 决定

使用 Electron 37 的 `WebContentsView` 提供单个 YouTube 浏览视图，由主进程持有。React 经既有 `lib/shell` 请求有限的前进、后退、导航、刷新、显示、隐藏和状态操作，不使用 `<webview>`，不把远程网页注入应用渲染器。

独立 `persist:nexus-youtube` 分区与应用凭据、preload 隔离。禁用 Node、开启沙箱及上下文隔离；拒绝权限请求、下载和新窗口。导航限定 HTTPS YouTube 域名，子资源只允许媒体播放所需域名族，禁止本地 API、file 和任意外部域名。每次 IPC 校验应用主窗口及主框架来源，尺寸须有限且限制在窗口范围内。

沿用客户端全局代理设置，同步到此分区，不修改操作系统代理。浏览区域跟随可见裁剪范围更新；本地 Dialog、词卡和音色浮层出现时隐藏原生视图。离开时静音并暂停媒体，五分钟闲置后关闭视图，返回不自动恢复播放。

在线收藏只存规范化来源和引用，用户／视频标识唯一。授权本地媒体可以关联同一视频条目，保留笔记和出处。不从其他浏览器读取登录信息，不接入既有 Cookie 导出工具，不保证 Google 登录及地区／嵌入受限内容可用。

## 后果与限制

- 原生视图不参与 DOM 层叠，单独提高 `z-index` 无效。必须验证隐藏、键盘焦点、缩放、滚动裁剪与窗口释放。
- 单元测试可以校验导航和资源边界，不能证明真实 YouTube 播放、全局代理切换和登录兼容。
- 浏览不等于授权下载。旧管线和旧本地条目继续兼容，新在线预览不自动调用旧片段下载接口。
- 域名白名单可能导致部分远程功能失败，应明确报错，不通过关闭 webSecurity 放行。
- 当前远程播放、弹窗遮挡和资源释放仍待真机验收，不作为发布就绪证明。

## 依据

- [Electron Web Embeds](https://www.electronjs.org/docs/latest/tutorial/web-embeds)
- [Electron Security](https://www.electronjs.org/docs/latest/tutorial/security)
- [Google OAuth policies](https://developers.google.com/identity/protocols/oauth2/policies)
- [YouTube caption download](https://developers.google.com/youtube/v3/docs/captions/download)
- [YouTube developer policies](https://developers.google.com/youtube/terms/developer-policies)
