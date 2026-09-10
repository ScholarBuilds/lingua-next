# 对话数字人资源

`partner.vrm` 是 VRoid 的 AvatarSample_A：完整骨骼、MToon 材质、元音口型、眨眼、表情与头发弹簧骨。运行时使用 `@pixiv/three-vrm` 3.5.5（MIT），模型和纹理随包提供，不访问外部人物服务。

## 来源与许可

- [官方人物页面](https://hub.vroid.com/en/characters/2843975675147313744/models/5644550979324015604)。
- [VRoidPreset A-Z 使用条款](https://vroid.pixiv.help/hc/en-us/articles/4402394424089-VRoidPreset-A-Z)。人物不是 CC0；模型内的 `licenseName=Other` 不代表无条件开放。
- [固定版本的分发副本](https://raw.githubusercontent.com/madjin/vrm-samples/e16eb187100149a315ad92c3c9968f1d5baa6c7d/vroid/stable/AvatarSample_A.vrm)。文件保持原样，不更改作者或许可元数据。
- SHA-256：`b86b0b8a66d48911431d6f920a5211a974226f83aa672eca3f3dfade58ac346e`。
- 文件大小：15,096,320 字节。

官方条款允许作为应用中的 avatar 使用及修改、分发，但禁止将模型数据付费再分发、提供角色制作服务、标为 CC0 或暗示 pixiv 背书。当前用途是本地免费口语伙伴，不提供模型销售、导出或角色编辑服务；付费安装包或角色服务发布前须重新确认素材授权，必要时换为有明确商业分发授权的模型。渲染代码的 MIT 许可不覆盖人物素材。

## 运行边界

口型由同一个 PCM 播放器的实际输出音量及频谱重心驱动 `aa/ih/ou` 表情，是近似音频驱动，不是逐音素识别。停止播放立即收口；麦克风不会驱动人物嘴部。倾听、思考、眨眼、视线及轻微呼吸在本地完成，减少动态效果偏好会关闭附加动作。人物显示不改变语音音色、场景角色或网络代理。

渲染限为 30 FPS、DPR 上限 1.5，隐藏页面暂停；切换简洁模式释放资源。资源加载或 WebGL 失败时可重试，语音和字幕仍可继续。VRM 模块按需加载，不进入非对话页面的初始化路径。

## 验证

开发服务的 `/tests/fixtures/talk-avatar.html` 提供合成音频、打断、思考和反复装卸测试；`?session` 使用真实对话组件验证布局，`?session&fail` 注入资源失败。入口不连接语音服务或采集麦克风，不进入生产构建。真实语音回合与主观人物审美需分别验收。
