# 规范提案：危险动作分级必问且清单只增不减

- ID：STD-SEC-002
- 状态：proposed
- Owner：scholar
- 版本：0.1.0
- 创建日期：2026-09-02
- 来源：CR-007 D5 安全铁律 / [CR-010](../../../00.需求文档/07.需求变更/10.CR-010-贾维斯可打断语音与常驻开关.md) D-3

## 背景

CR-007 D5-2「发送 / 付款 / 删除 / 安装 / 提交表单前必问」在贾维斯引擎路径上曾被整体作废（approvalPolicy=never、requestApproval 一律 acceptForSession、未知请求回空对象）。

## 现有规范无法解决的问题

没有编号规则可引用，code-review 无据可依。

## 适用与不适用范围

适用一切能产生外部副作用的执行路径（引擎命令、文件变更、MCP 工具调用、浏览器动作）。

## 候选方案与取舍

见 CR-010 §2 与执行计划的调研记录；本提案只登记拟采用的规则。

## 拟采用规则

五类动作必须经审批席位（kernel.approval）弹卡后才执行：删除 / 清空、发送（邮件·消息·表单提交）、支付 / 下单、系统设置、对外写接口（非 GET HTTP、git push），另含安装、kill 非自启进程、浏览器 download / eval / auth；其余自动执行但只给 turn 级 accept，永不自动 acceptForSession；未知类型的审批请求一律 fail-closed；DANGER_WORDS 与 DANGER_PROGRAMS 只增不减，由守护测试锁定；语音只能表达拒绝，放行必须经界面点击。

## 正例与反例

- 正例：rm -rf 命中 → 落 awaiting 步骤、弹卡、超时 120s 自动拒绝。
- 反例：对 item/foo/requestApproval 兜底回 {}；把「无审批」写成测试断言。

## 兼容性与迁移计划

CR-010 M3：ApprovalBroker 替换 open_interpreter_app_server._handle_server_request 的一律放行；删除 test_runtime_has_no_per_step_approval_mode。

## 自动检查与测试

tests/test_jarvis_gate.py（danger 弹卡、benign 自动、unknown fail-closed、语音允许不生效）、test_danger_list_keeps_required_words。

## 风险和回滚

若审批卡误报过多，只能收窄分类规则，不能关门。

## 评审记录

- 2026-09-02：随 CR-010 M0 提出，待 scholar 评审后转 active 并登记 standards.yaml。
