# 桌面 YouTube 标签退场（2026-09-05）

视频页第三个 tab「YouTube」（壳内 BrowserView 隔离浏览 + 在线收藏，ADR-020）在正式提交前撤掉：
scholar 拍板，给朋友的安装包与本机都不需要在产品里嵌一个 YouTube 浏览器；导入 YouTube 链接
（`ImportDialog`）与频道发现页（`DiscoverPage`）不受影响。代码原样归档在此，不进 `src/`。

- `web/YoutubeBrowser.tsx`：视频页里的浏览器面板
- `desktop/youtube-view.ts`、`youtube-policy.ts`、`youtube-policy.test.ts`：壳里的隔离 WebContentsView、导航白名单与 IPC
- `ADR-020-桌面YouTube隔离浏览与在线收藏.md`：当时的决策记录（未验收）
