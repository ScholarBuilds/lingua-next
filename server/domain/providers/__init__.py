"""供应商 adapter：把各家线协议翻译成 ``domain.kernel.llm_types`` 的中立词汇。

adapter 只做翻译，不做策略：重试、超时、取消归一由运行时负责。
"""
