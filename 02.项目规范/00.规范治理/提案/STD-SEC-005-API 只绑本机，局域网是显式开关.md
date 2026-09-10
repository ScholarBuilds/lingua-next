# 规范提案：API 只绑本机，局域网是显式开关

- ID：STD-SEC-005
- 状态：proposed
- Owner：scholar
- 版本：0.1.0
- 创建日期：2026-09-02
- 来源：CR-007 D5 安全铁律 / [CR-010](../../../00.需求文档/07.需求变更/10.CR-010-贾维斯可打断语音与常驻开关.md) D-3

## 背景

CR-007 D5-5 与 ADR-013：API 只绑 127.0.0.1；ADR-010：MCP 出口回环 + Bearer。

## 现有规范无法解决的问题

CR-009 把 Lingua MCP 改成「总是挂载 + 进程内随机 Bearer」而 ADR-010 未修订；门代理再加两个 MCP 端点。

## 适用与不适用范围

适用 server/app/main.py、mcp_server.py、jarvis_mcp_gate.py、launch_nexus.py。

## 候选方案与取舍

见 CR-010 §2 与执行计划的调研记录；本提案只登记拟采用的规则。

## 拟采用规则

API 与全部 MCP 端点（/mcp、/mcp/desktop、/mcp/browser）只监听回环并经 LoopbackBearerGuard；Bearer 只注入引擎子进程 env，不落盘、不回显；局域网访问保留为显式开关。

## 正例与反例

- 正例：mount_gated_mcp 复用 LoopbackBearerGuard。
- 反例：把 /mcp/desktop 挂成无鉴权路由。

## 兼容性与迁移计划

ADR-010 补修订记录；CR-010 M3。

## 自动检查与测试

tests/test_mcp_server.py 的 401/403 用例覆盖新端点。

## 风险和回滚

无。

## 评审记录

- 2026-09-02：随 CR-010 M0 提出，待 scholar 评审后转 active 并登记 standards.yaml。
