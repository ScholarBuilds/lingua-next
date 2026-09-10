# ADR-007：视频字幕 ASR 管线采用「large-v3 转写 → LLM 标点恢复 → CTC 强制对齐 → 三级分句」

- 状态：accepted（2026-08-17 scholar 确认方向，实测数据支撑）；**转写一环于 2026-08-30 由 [ADR-012](ADR-012-转写外包给火山极速版并下线本地音素模型.md) 修订**——默认改走火山极速版 ASR，本地 large-v3 保留为回落。标点恢复、CTC 强制对齐、三级分句三环不变
- 日期：2026-08-17
- 决策人：scholar

## 背景与约束

字幕是视频学习模块所有功能的地基：听写、跟读、中译英、句收藏、词组高亮、AI 陪读、卡拉OK 高亮全部建立其上。真实使用暴露两个问题：

1. cue（字幕行）与句子边界无关，15 号视频 71 条 cue 中 52 条断在半句、46 条以小写承接上条；
2. 部分视频转写整段无标点，pysbd 切不出句（5 号 81 cue 仅 17 句，最长句 3977 字符）。

约束：开发机为 Apple M1 Max（10 核，无 CUDA，CTranslate2/onnxruntime 走 CPU）；scholar 明确要求业内最佳实践、一劳永逸、不接受补丁式优化；token 消耗不是约束。

## 关键实测（5 号视频「哈佛女生的高效早晨日常」，14.4 分钟，全库最坏案例）

### 否定项：三条看似合理的路都被数据否掉

| 假设 | 实测结果 | 结论 |
| --- | --- | --- |
| small → large-v3 能解决无标点 | 句末标点 17 → 19 个，最长句 3977 → 3866 字符 | ❌ 无效，标点是解码策略问题不是模型能力问题 |
| `condition_on_previous_text=False` 阻断沿袭 | 快 40%（RTF 0.96→0.58），但丢 96 词（-7.7%）、改 49 词（`bling→ring`、`looking→loving`，整段丢失 `going to be in the description box`） | ❌ 内容完整性优先于速度 |
| LLM 标点恢复直接救 YouTube auto/en 轨（免去全库转写） | 14 号奥巴马演讲 7 块仅 1 块通过词序列校验，输出丢词（`lived overseas. country some of you…`） | ❌ auto 字幕滚动机制带重复词，LLM 顺手去重 |

无标点的真实成因：whisper 的 `condition_on_previous_text` 沿袭失效。5 号视频 0-207s 标点完全正常，207s 处丢一次标点后，模型以无标点前文为条件，**后续 82% 的段全部沿袭无标点小写，一路到底**（段 18-44、46-87 两个连续无标点区，整片仅 21 个标点 / 88 段）。

### 采纳项

| 阶段 | 方案 | 实测 |
| --- | --- | --- |
| 转写 | faster-whisper **large-v3**，`condition_on_previous_text` 保持默认 True | RTF 0.96；相比 small 词更准（`6 a.m.` vs `6am`、`morning workout in` vs `morning work out`） |
| 标点恢复 | **LLM**（别名 `explain-standard`）按 segment 边界分块 ≤1600 字符、并发 6，**词序列一致性校验** | 整片 6 块 **9 秒**，校验 **6/6 通过**；句末标点 19 → 96 个 |
| 词级时间戳 | **ctc-forced-aligner**（MMS-300M CTC 强制对齐，许可见下方勘误） | RTF 0.215；词跨度中位 **0.220s → 0.120s**（收紧 45%） |
| 分语法句 | pysbd（复用 `domain/segmentation.py`） | 18 句（最长 3866 字符）→ **92 句**（中位 72、最长 316） |
| 学习句 | 二次切分：>7s 或 >84 字符时按 句中标点 > 词间停顿≥300ms > 从属连词 | **174 句**，中位 46 字符 / 2s，P90 75 字符 / 4s；仅 3.4% 仍超限 |

全链路耗时：830 + 9 + 186 = **1025 秒**（14.4 分钟音频）；全库 123 分钟音频约 2.4 小时，一次性。

## 决策

**采纳上表五阶段管线**，其中两个非显然的选择需要说明：

**为什么标点恢复用 LLM 而不是专用模型**（deepmultilingualpunctuation 等）：项目已有 LiteLLM 网关与语义别名体系，零新模型零新依赖；9 秒的代价相对 830 秒转写可忽略；且**词序列一致性校验**使其安全 —— 归一化后逐词比对，不一致即回退原文，LLM 改词风险被完全堵死。该校验已在实践中证明价值：正是它拦下了 YouTube auto 轨的丢词输出。

**为什么词级时间戳用 CTC 强制对齐而不是 WhisperX**：WhisperX 的 wav2vec2 对齐有多个未解 issue（长音频漂移、时间戳偶发偏 20s、句首落在词中间），且只能在转写时内部对齐，不能独立重对齐任意字幕。Subtitle Edit 正将 CTC 强制对齐作为一等公民集成，CrisperWhisper 维护者亦推荐 transcribe → force-align 工作流。（原文此处称「由 faster-whisper 核心开发者 MahmoudAshraf 维护」，与实际锁定的包不符，见下方勘误。）

**为什么不上 Parakeet v3**（Open ASR Leaderboard WER 6.34 优于 large-v3-turbo 7.8）：NeMo 全家桶依赖重，在无 CUDA 的 M1 上无收益，而 CTranslate2 的 ARM CPU 优化正好对口。列为将来上带卡服务器时的备选。

## 回填期实测修正（2026-08-17 全库回填）

**标点退化具有随机性，不是 large-v3 必然无效。** 5 号视频（最坏案例）在选型实测中
large-v3 只切出 18 句、最长 3866 字符；全库回填时同一视频同一模型却切出 99 句、
平均 80 字符、最长 278，标点完全正常。唯一变量是回填给 whisper 加了 `cpu_threads=4`
——线程数改变浮点累加顺序，进而改变 beam search 路径。

结论不变但理由要更准确：**不能靠模型或参数「保证」标点**，所以标点恢复这道保险
仍然必要。它在这次回填里的判断也是对的——按标点密度自适应判定"无需恢复"并跳过，
省掉一次 LLM 调用。同一条管线对退化与不退化两种情况都正确处理，这正是把恢复做成
自适应而非无条件执行的价值。

同批修正的还有两处实现细节：

- **CTC 分块必须按词流而非 cue 边界**：whisper 的 segment 内部也含长静音，5 号有三个
  单 cue 就跨 62-70 秒，自成一块时块内静音照样把词摊开（实测最大偏移 58.6s）。改按
  词间静音 ≥1s 切块后，最大偏移降到 2.28s，重定时覆盖率 73/88 → 88/88 cue。
- **模型名会触发 HuggingFace 下载**：`whisper_model` 填 `large-v3` 会走 HF 拉取，
  国内单线程 1.3MB/s 且会停滞，回填进程卡在网络上不动。改为指向已落盘目录
  （`LINGUA_WHISPER_MODEL=/path/to/faster-whisper-large-v3`）。

## 影响

- 英文源只能是 whisper 轨：YouTube auto/en 全小写无标点且带重复词，两条路都不通（pysbd 切不动、LLM 恢复不过校验）。
- 中文一律由 `translate_track` 基于 whisper 轨自建，与语法句一一对应；YouTube auto/zh 不参与双语渲染（详见需求文档 v3 第 12 节）。
- 新增依赖：`ctc-forced-aligner`（含隐性依赖 `unidecode`，该包未声明）、MMS-300M ONNX 模型 1.2GB。
- 数据模型由两级变三级（cue / 语法句 / 学习句），详见需求文档 v3 第 9 节。

## 待验证

`ctc-forced-aligner` 在 Docker linux/arm64 下的 onnxruntime 可用性（本机 macOS arm64 已验证：加载 1.8s，CPUExecutionProvider）。

---

## 勘误（2026-08-19 核实）

本 ADR 原文对 `ctc-forced-aligner` 的两条陈述与实际锁定的包不符：

| 原文 | 实际 |
| --- | --- |
| 许可 MIT | `pyproject.toml` 锁的 `ctc-forced-aligner>=1.0.2` 是 **PyPI 上 deskpai 的分支**，GitHub 仓库**未声明 license**；README 自述「incorporates code from MahmoudAshraf97」，包本身为 BSD-2 + DOSL-1.0 混合，**模型侧 MMS_FA 是 CC-BY-NC 4.0**（非商业） |
| 由 MahmoudAshraf 维护 | MahmoudAshraf97 本人的仓库是另一个包（552 star，2026-07 仍活跃，版本 0.3.0，只能 git 安装）。我们用的 `AlignmentSingleton` 是 **deskpai 独有 API**，可确认走的是 deskpai 分支 |

**供应链风险**：deskpai 分支 11 star、单人维护、最后代码 push **2025-02-09**（一年半未更新）、
无 license 声明，而它是字幕管线的关键件。

**处置建议**（未执行，待决策）：

1. 维持现状但记录风险 —— 功能已验证可用，锁死版本号不动。
2. 迁到 MahmoudAshraf97 上游（需改 `AlignmentSingleton` 调用、改为 git 依赖）。
3. 模型许可若在意（MMS_FA 为 CC-BY-NC），个人自用无影响，对外提供服务前需重新评估。

另注：模块 13 的音素级评测会复用这套对齐管线（换 tokenizer 即可做音素级强制对齐），
届时这条依赖的重要性还会上升，建议在那之前把 1 或 2 定下来。
