# 规范提案：每步可回放且单会话有上限

- ID：STD-SEC-004
- 状态：proposed
- Owner：scholar
- 版本：0.1.0
- 创建日期：2026-09-02
- 来源：CR-007 D5 安全铁律 / [CR-010](../../../00.需求文档/07.需求变更/10.CR-010-贾维斯可打断语音与常驻开关.md) D-3

## 背景

CR-007 D5-4：每步截图与动作落盘 7 天可回放，单会话步数与时长有上限。

## 现有规范无法解决的问题

Rust 链路只落四类 item，截图产出没有保证；turn 超时 300s 只活在代码常量里。

## 适用与不适用范围

适用 computer_step 写入、门代理、质量属性基线。

## 候选方案与取舍

见 CR-010 §2 与执行计划的调研记录；本提案只登记拟采用的规则。

## 拟采用规则

每个引擎 item / MCP 工具调用完成后落 computer_step（delta 只进内存 hub）；门代理把 get_desktop_state 等图像结果落 kind=image 步骤，截图 7 天清；turn 超时、启动超时、自动恢复次数写进质量属性基线并由配置项承载；崩溃与急停时在飞步骤以 failed 落库，不留空洞。

## 正例与反例

- 正例：crash 剧本下半截输出以 status=failed 落库。
- 反例：delta 每 50ms 一条落库。

## 兼容性与迁移计划

CR-010 M1 / M3 落地。

## 自动检查与测试

tests/test_jarvis.py crash flush 与 step_count 时机；purge 用例迁入。

## 风险和回滚

无。

## 评审记录

- 2026-09-02：随 CR-010 M0 提出，待 scholar 评审后转 active 并登记 standards.yaml。
