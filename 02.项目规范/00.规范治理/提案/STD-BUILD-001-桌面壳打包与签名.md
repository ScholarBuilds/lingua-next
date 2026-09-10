# 规范提案：桌面壳打包与签名

- ID：STD-BUILD-001
- 状态：proposed
- Owner：scholar
- 版本：0.1.0
- 创建日期：2026-09-02
- 来源：[CR-010](../../../00.需求文档/07.需求变更/10.CR-010-贾维斯可打断语音与常驻开关.md) D-7、[ADR-014](../../../01.项目文档/02.架构/ADR/ADR-014-本机代理进程与桌面壳选型.md)

## 背景

macOS 把麦克风 / 辅助功能 / 屏幕录制授权与登录项都绑在 app 的 code designation（bundle id + 签名身份 + 路径）上；未签名或 ad-hoc 签名的壳每次重建都是新身份，授权作废、登录项静默失败。本机 `/Applications/Lingua.app`（com.lingua.desktop，ad-hoc）就是这样一个过时包。

## 现有规范无法解决的问题

08.构建发布规范为空壳；desktop/ 只有 tsc 编译没有打包器。

## 适用与不适用范围

适用 desktop/ 的打包、签名与安装；不适用 web/ 与 server/ 的构建。

## 拟采用规则

1. appId 定死 `com.lingua.nexus`，productName `NEXUS`，安装路径 `/Applications/NEXUS.app`；之后不得更改 appId。
2. 官网分发禁止 ad-hoc 签名；本机验证使用 Apple Development，熟人内测允许通过独立 `friends` 命令生成 ad-hoc 包并附手动放行说明，正式分发使用 Developer ID + 公证。
3. `build/entitlements.mac.plist` 不得含 XML 注释（AMFIUnserializeXML 会报 syntax error）；hardenedRuntime 开启；只声明真正需要的权限（allow-jit、allow-unsigned-executable-memory、device.audio-input）。
4. 登录项只在 `app.isPackaged` 时注册，并用 `getLoginItemSettings()` 回读显示真实状态；未打包时界面禁用并说明原因（STD-UI-006）。
5. 登录项启动的 GUI 进程不继承 shell PATH，壳内所有子进程调用必须经统一的 PATH 解析。
6. 开发启动与发布构建分离：`launch_nexus.py` 默认只打开源码 Electron，不执行签名；`--installed` 才显式打开已安装包，`--dist` 仅保留为独立的历史本机构建入口。

## 正例与反例

- 正例：本机验证使用 `pnpm dist:mac:local`，熟人内测使用 `pnpm dist:mac:friends`，官网发布使用 `pnpm dist:mac`。
- 反例：把 ad-hoc 包标成正式版；`pnpm start` 跑 node_modules 里的 Electron.app 并注册登录项；改 appId 重新打包。

## 兼容性与迁移计划

CR-010 M5 落地；旧 `/Applications/Lingua.app` 提示后移除，麦克风授权重授一次。

## 自动检查与测试

desktop 探针新增登录项与 PATH 项；`codesign --verify` 进 `--dist` 流程。

## 风险和回滚

签名证书过期或更换会重置 TCC 与登录项，只能重新授权。熟人内测包每次更新也可能重新触发 Gatekeeper 或 TCC 授权；正式发布命令与内测命令彼此独立。

## 评审记录

- 2026-09-02：随 CR-010 M0 提出。
- 2026-09-03：增加熟人内测 ad-hoc 分发档，官网发布要求不变。
- 2026-09-03：CR-014 将日常开发启动与打包签名分离，不再默认使用已安装包。
