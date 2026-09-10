# 规范提案：凭据只填不读，读出记台账

- ID：STD-SEC-003
- 状态：proposed
- Owner：scholar
- 版本：0.1.0
- 创建日期：2026-09-02
- 来源：CR-007 D5 安全铁律 / [CR-010](../../../00.需求文档/07.需求变更/10.CR-010-贾维斯可打断语音与常驻开关.md) D-3

## 背景

CR-007 D5-3：保险箱的值不进模型上下文，只有填充权，读出记 credential_access。

## 现有规范无法解决的问题

引擎在 danger-full-access 下可直接读 server/.env 拿到 Fernet 主密钥；驱动器的 clipboard_read 可把剪贴板里的密码回给模型。

## 适用与不适用范围

适用引擎 permission profile、MCP 门代理、agent-browser 配置。

## 候选方案与取舍

见 CR-010 §2 与执行计划的调研记录；本提案只登记拟采用的规则。

## 拟采用规则

受保护路径（server/.env、data/vault.key、data/computer-profile/**、~/Library/Keychains/**、~/.ssh/**、~/.aws/**、**/.env）在 permission profile 里一律 deny；子进程 env 剥离 LINGUA_ 前缀；门代理拒绝 clipboard_read / read_clipboard；网页登录只经 agent-browser Authentication Vault（密码不进模型）；原生 App 的 fill-only 执行者需先修订 ADR-010 再做。

## 正例与反例

- 正例：profile deny 下 cat server/.env 被沙箱拒绝。
- 反例：把 LINGUA_CONFIG_KEY 透传给引擎子进程。

## 兼容性与迁移计划

CR-010 M3 落地；无迁移期。

## 自动检查与测试

tests/test_jarvis_config.py 断言 env 无 LINGUA_CONFIG_KEY 且 profile deny 含全部受保护路径；test_jarvis_mcp_gate 断言 clipboard_read 被拒。

## 风险和回滚

误伤合法读取时只放宽具体路径，不整体放开。

## 评审记录

- 2026-09-02：随 CR-010 M0 提出，待 scholar 评审后转 active 并登记 standards.yaml。
