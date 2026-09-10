# ADR-006：AI 解释与翻译结果按内容指纹持久化，一次生成永久复用

- 状态：accepted（2026-08-17 scholar 确认）
- 日期：2026-08-17
- 决策人：scholar

## 背景与约束

需求 FACT：AI 解释单词、语法分析、句子精讲的结果必须持久化——下次点击同一目标直接展示历史结果，不重复调用；支持手动"重新分析"。翻译结果同理（同一句子同一供应商不重复计费）。这是成本控制与体验（秒开）双重需求。

## 决定

统一一张**分析结果表**承载所有 AI/翻译产物，按内容指纹寻址：

```
analysis_result
├── id
├── scope            -- word | phrase | sentence | paragraph | document
├── content_hash     -- SHA-256(规范化目标文本)
├── context_hash     -- SHA-256(规范化上下文句)，词在句中释义时参与寻址；无上下文场景为空
├── kind             -- translate | word_explain | grammar | sentence_deep | summary ...
├── provider         -- bing | google | youdao | deepl | llm:<别名> ...
├── model            -- 实际模型名（LLM 时记录，供应商翻译为空）
├── lang_pair        -- en->zh 等
├── result           -- JSONB，按 kind 定义结构化 schema
├── version          -- 同一寻址键的第 N 次分析，重新分析递增，历史版本保留
├── is_active        -- 当前展示版本
└── created_at
```

- **寻址键**：`(scope, content_hash, context_hash, kind, provider, lang_pair)`。命中且存在 `is_active` 版本→直接返回；未命中→调用供应商→落库返回。
- **重新分析**：新增 version 并置为 active，旧版本保留可查（"查看历史分析"低优先级 UI）。
- **规范化**：目标文本做 Unicode NFC、trim、内部连续空白折叠、句末标点保留；单词额外做小写化（词形还原不参与寻址，避免歧义）。
- **文档级结果**（整篇翻译）体量大，result 存段落对齐数组，同表不分家，靠 scope 区分。
- 阅读器中的"已分析"标记：书籍分句入库时即建立 sentence 记录，前端按 content_hash 批量查询命中状态，已分析句子渲染角标。

## 后果

- 所有模块（书库、视频字幕、词库、划句翻译）共享同一缓存层，跨模块命中（书里查过的词，字幕里点击直接命中）。
- 换模型/换供应商天然产生新缓存行，不互相污染；对比不同模型的解释成为免费副产品。
- JSONB schema 需要按 kind 定义并版本化（放入接口规范文档）。

## 验证与复审日期

- 验证：M1 点词链路验证二次点击 P95 < 100ms（纯库查询）。
- 复审：若出现按用户维度隔离需求（多用户化）时补充 user_id 维度。
