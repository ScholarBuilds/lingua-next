# 规范提案：执行范围默认最小化

- ID：STD-SEC-001
- 状态：proposed
- Owner：scholar
- 版本：0.1.0
- 创建日期：2026-09-02
- 来源：CR-007 D5 安全铁律 / [CR-010](../../../00.需求文档/07.需求变更/10.CR-010-贾维斯可打断语音与常驻开关.md) D-3

## 背景

贾维斯能操作整台电脑；CR-007 D5-1 要求默认范围是浏览器窗口，桌面范围要显式开且权限齐全。

## 现有规范无法解决的问题

standards.yaml 没有任何安全族规则，引擎曾以 danger-full-access 跑。

## 适用与不适用范围

适用 server/domain/jarvis*.py、cua-driver 配置、agent-browser 配置；不适用纯阅读类工具。

## 候选方案与取舍

见 CR-010 §2 与执行计划的调研记录；本提案只登记拟采用的规则。

## 拟采用规则

引擎默认 permission profile 为受限档（workspace_roots 明确、受保护路径 deny、网络白名单）；原生桌面驱动默认 bounded + capability manifest（App bundle_id 白名单、terminate 只限自启进程、expires_after / idle_timeout 必填）；扩大范围必须经界面显式操作并留审计。

## 正例与反例

- 正例：新会话 thread/start 带 permissions='jarvis'；cua-driver 以 --permission-mode bounded 启动。
- 反例：sandbox_mode=danger-full-access；cua-driver --dangerously-bypass-approvals。

## 兼容性与迁移计划

CR-010 M3 迁移；探针若发现 permissions 参数不被接受，临时退 sandbox_mode=workspace-write 并登记限期例外。

## 自动检查与测试

tests/test_jarvis_config.py 逐键断言 -c 配置；tests/test_jarvis_gate.py 断言受保护路径被拒；启动脚本检测用户级 standard daemon 并警告。

## 风险和回滚

内核升级改动 permission 语义时退回旧沙箱并登记例外。

## 评审记录

- 2026-09-02：随 CR-010 M0 提出，待 scholar 评审后转 active 并登记 standards.yaml。
