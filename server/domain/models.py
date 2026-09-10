from datetime import datetime

from sqlalchemy import (
    JSON,
    BigInteger,
    Boolean,
    DateTime,
    Float,
    ForeignKey,
    Index,
    Integer,
    SmallInteger,
    String,
    Text,
    UniqueConstraint,
    false,
    func,
    text,
    true,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship

JSONVariant = JSON().with_variant(JSONB(), "postgresql")
BigIntegerPK = BigInteger().with_variant(Integer(), "sqlite")


class Base(DeclarativeBase):
    pass


class DictEntry(Base):
    """ECDICT 词典条目，本地词典兜底（模块 01）。"""

    __tablename__ = "dict_entry"

    word: Mapped[str] = mapped_column(String(128), primary_key=True)
    phonetic: Mapped[str | None] = mapped_column(String(128))
    definition: Mapped[str | None] = mapped_column(Text)  # 英文释义
    translation: Mapped[str | None] = mapped_column(Text)  # 中文释义
    pos: Mapped[str | None] = mapped_column(String(64))
    collins: Mapped[int | None] = mapped_column(Integer)
    oxford: Mapped[int | None] = mapped_column(Integer)
    tag: Mapped[str | None] = mapped_column(String(128))  # 考纲标签：cet4/cet6/ky/ielts/toefl
    bnc: Mapped[int | None] = mapped_column(Integer)
    frq: Mapped[int | None] = mapped_column(Integer)  # COCA 词频位次
    exchange: Mapped[str | None] = mapped_column(Text)  # 词形变化


# 查词侧表的键列：PG 上 COLLATE "C" 让 `lc >= q AND lc < q_hi` 这种前缀范围谓词吃 btree，
# SQLite 本来就是 BINARY 排序。别拿这两列做展示排序——它们是纯小写检索键
LcString = String(160).with_variant(String(160, collation="C"), "postgresql")
GlossString = String(64).with_variant(String(64, collation="C"), "postgresql")


class DictHead(Base):
    """查词联想索引（FR-508）：`dict_entry` 的检索投影，seed 脚本整表重建。

    `dict_entry.word` 主键是 BINARY 排序，SQLite 上 `LIKE 'q%'` 在它上面是全表扫描，
    也没地方放预算好的 brief / 音标 / 层级 / 原形，所以另建一张只读侧表。三张查词侧表
    都不建外键：它们是导出物，随时 `DELETE` 重灌。
    """

    __tablename__ = "dict_head"

    word: Mapped[str] = mapped_column(String(128), primary_key=True)
    lc: Mapped[str] = mapped_column(LcString, nullable=False)  # 小写、折叠空白
    # 1 学习者层（有词频 / 考纲 / 柯林斯 / 牛津标记）· 2 常用词组 · 3 其余单 token 词
    tier: Mapped[int] = mapped_column(SmallInteger, nullable=False)
    frq_rank: Mapped[int | None] = mapped_column(Integer)  # NULLIF(frq,0) 兜底 NULLIF(bnc,0)
    lemma: Mapped[str | None] = mapped_column(String(128))  # exchange 的 0: 段且 != word
    proper: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default=false())
    brief: Mapped[str | None] = mapped_column(String(24))
    tags: Mapped[str | None] = mapped_column(String(64))
    phonetic: Mapped[str | None] = mapped_column(String(64))

    __table_args__ = (
        Index("ix_dict_head_lc", "lc"),
        Index("ix_dict_head_tier_frq", "tier", "frq_rank"),
    )


class DictGloss(Base):
    """汉英反查索引（FR-509）：中文义项 → 词，只收学习者层与常用词组的原形行。"""

    __tablename__ = "dict_gloss"

    gloss: Mapped[str] = mapped_column(GlossString, primary_key=True)
    word: Mapped[str] = mapped_column(String(128), primary_key=True)
    tier: Mapped[int] = mapped_column(SmallInteger, nullable=False)
    sense_idx: Mapped[int] = mapped_column(SmallInteger, nullable=False)  # 义项序，域标签行 +100
    pos: Mapped[str | None] = mapped_column(String(8))
    frq_rank: Mapped[int | None] = mapped_column(Integer)

    __table_args__ = (
        Index("ix_dict_gloss_gloss", "gloss"),
        Index(
            "ix_dict_gloss_learner_cover", "tier", "sense_idx", "frq_rank", "gloss", "word", "pos"
        ),
    )


class DictRelated(Base):
    """同义 / 反义 / 派生（FR-510）：WordNet 3.0 离线算好，只收学习者层内的词。"""

    __tablename__ = "dict_related"

    word: Mapped[str] = mapped_column(String(128), primary_key=True)
    kind: Mapped[str] = mapped_column(String(8), primary_key=True)  # syn | ant | deriv
    related: Mapped[str] = mapped_column(String(128), primary_key=True)
    rank: Mapped[int] = mapped_column(SmallInteger, nullable=False)  # WordNet 义项序 ≈ 频度序

    __table_args__ = (Index("ix_dict_related_word", "word", "kind", "rank"),)


class DeckScene(Base):
    """**某一本**里某个词的场景归属（模块 01 考纲本按场景学）。

    > [!danger] 分组必须按本，不能全局共享
    >
    > 第一版把场景做成按词的全局属性（想省掉 62% 的重复），结果是
    > **场景表被第一本冻结、又被后面的大本打碎**：
    > 中考跑完是 30 组、中位 60 词；等八本跑完变成 **143 组、中位 6 词**，
    > 只有 30/143 还在 18~95 的区间里——大本拆分过大组时把中考的词一起拆散了。
    > 更糟的是 `family` 词根轨全库 0 个：后面的本沿用已有表，
    > 从没机会提出自己的词根族，连 GRE 都没有。
    >
    > 「一本分成多少组」是**本**的属性不是词的属性：
    > 中考 1,603 词该分 27 组，GRE 7,504 词该分 125 组，同一个词在两本里
    > 完全可以归进粗细不同的组。所以主键是 (deck, word)。

    例句仍按词存在 `WordScene`——那是词的属性，跨本共用一句就够了。
    """

    __tablename__ = "deck_scene"

    deck: Mapped[str] = mapped_column(String(32), primary_key=True)  # zk/gk/cet4/…
    word: Mapped[str] = mapped_column(String(128), primary_key=True)
    scene: Mapped[str] = mapped_column(String(48), index=True)
    track: Mapped[str] = mapped_column(String(8))  # scene|family|theme
    root: Mapped[str | None] = mapped_column(String(32))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )


class WordScene(Base):
    """按词的 AI 例句（模块 01 考纲本按场景学）。

    按词存、跨本共用一句：八本考纲词次合计 38,855，去重后只有 14,942（重叠率 62%，
    一个词的 tag 常见形如 `gk cet4 cet6 ky toefl ielts gre`）。按本存等于同一句
    生成、存储、维护六遍，六份还会不一致。

    场景归属则按本存（见 `DeckScene`）——那是本的属性，这是词的属性。
    """

    __tablename__ = "word_scene"

    word: Mapped[str] = mapped_column(String(128), primary_key=True)
    example_en: Mapped[str | None] = mapped_column(Text)
    example_zh: Mapped[str | None] = mapped_column(Text)
    model: Mapped[str | None] = mapped_column(String(64))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )


class DeckCover(Base):
    """按 deck key 寻址的封面（FR-420a）。

    生词本与八个考纲本都是**虚拟本**：没有 wordlist 行，`wordlist.cover_key`
    这条路走不通（`domain/decks.exam_deck` 因此一直不传 cover_url）。
    这里按 deck key 存，真实本继续用 wordlist.cover_key，两边在
    `decks._cover_url` 汇合成同一个 URL 形状。
    """

    __tablename__ = "deck_cover"

    key: Mapped[str] = mapped_column(String(64), primary_key=True)  # cet4 / gre / vocab
    storage_key: Mapped[str] = mapped_column(String(512))  # media_root 下的相对路径
    asset_id: Mapped[int | None] = mapped_column(Integer)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )


class WordVoice(Base):
    """按词钉死的发音音色（FR-495）。

    合成错的词（重音位置、异读）换个供应商往往就对了，但场景绑定是全局一把音色，
    没法只给这一个词换。这里按词存用户挑定的 voice（带前缀，可直接回填 `?voice=`）
    与语速；缓存键已含音色，所以不需要另建缓存。前端拿到整张表后在 `ttsUrl` 里
    显式带 `voice=`——TTS 文件响应带 7 天浏览器缓存，服务端在同一 URL 上悄悄
    换音色的话，用户换完听到的还是旧声。
    """

    __tablename__ = "word_voice"

    word: Mapped[str] = mapped_column(String(64), primary_key=True)  # 小写去空格
    voice: Mapped[str] = mapped_column(String(128))
    rate: Mapped[int] = mapped_column(Integer, default=0)  # 百分比，同绑定的 params.rate
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )


class DeckAiRun(Base):
    """本级 AI 补全的一次运行（FR-502）：把本内每个词的语境释义与拆开记跑完。

    产物落 `analysis_result`（词卡按同一指纹命中），这里只记进度。`cursor` 是分片续跑的
    游标：desktop 档队列 3600 秒租约会把长任务重派、arq 到点直接取消，一本上万次调用
    不能塞在一个作业里，连续完成的前缀即时写回 cursor，片末重新入队。取消只写
    `cancel_requested_at`，任务停止补位，在飞的调用返回并落库后收口。
    """

    __tablename__ = "deck_ai_run"

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[str] = mapped_column(String(36))
    deck_key: Mapped[str] = mapped_column(String(64), index=True)
    kinds: Mapped[list] = mapped_column(JSONVariant, default=list)  # ["explain", "breakdown"]
    refresh: Mapped[bool] = mapped_column(Boolean, default=False)  # 已有缓存也重新生成
    status: Mapped[str] = mapped_column(String(16), default="queued")
    # queued | running | done | failed | cancelled
    total: Mapped[int] = mapped_column(Integer, default=0)  # 本内词数
    cursor: Mapped[int] = mapped_column(Integer, default=0)  # 下一片从第几个词开始
    done: Mapped[int] = mapped_column(Integer, default=0)  # 已处理的词
    cached: Mapped[int] = mapped_column(Integer, default=0)  # 命中缓存跳过的调用
    generated: Mapped[int] = mapped_column(Integer, default=0)  # 真调了模型的调用
    failed: Mapped[int] = mapped_column(Integer, default=0)  # 失败的调用
    current_word: Mapped[str | None] = mapped_column(String(128))
    error: Mapped[str | None] = mapped_column(Text)
    cancel_requested_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class DictEnrich(Base):
    """ECDICT 补全缓存（模块 01 v10 FR-129~131）。

    ECDICT 有两个硬缺口：一条例句都没有；多音词只存一个音标，且常是少数派读音
    （实测 `use` 存名词 /juːs/ 但 81% 用法是动词，`record` 存动词读音但 77% 是名词）。
    这里按词缓存 dictionaryapi.dev 的结果补齐——音频源自 Wiktionary/Wikimedia（CC BY-SA），
    带口音后缀可辨（xxx-us.mp3 / -uk / -au）。

    `status='miss'` 是负缓存：那边查不到的词不必反复打网络。
    """

    __tablename__ = "dict_enrich"

    word: Mapped[str] = mapped_column(String(128), primary_key=True)
    # [{text, accent, audio}]，accent ∈ us|uk|au|""，audio 为外链原始地址
    phonetics: Mapped[list] = mapped_column(JSONVariant, default=list)
    # [{pos, definition, example}]
    examples: Mapped[list] = mapped_column(JSONVariant, default=list)
    status: Mapped[str] = mapped_column(String(16), default="ok")  # ok|miss|error
    source: Mapped[str] = mapped_column(String(32), default="dictionaryapi.dev")
    fetched_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class Book(Base):
    __tablename__ = "book"

    id: Mapped[int] = mapped_column(primary_key=True)
    slug: Mapped[str] = mapped_column(String(128), unique=True)
    title: Mapped[str] = mapped_column(String(512))
    author: Mapped[str | None] = mapped_column(String(256))
    cover_key: Mapped[str | None] = mapped_column(String(512))
    source: Mapped[str] = mapped_column(String(16), default="imported")  # builtin | imported
    file_key: Mapped[str | None] = mapped_column(String(512))
    # 内置馆藏元数据（模块 02 FR-368）：难度分档 starter|core|deep、题材标签、一句话导读
    difficulty: Mapped[str | None] = mapped_column(String(16))
    tags: Mapped[list | None] = mapped_column(JSONVariant)
    blurb: Mapped[str | None] = mapped_column(Text)
    # Gutenberg 电子书号，内置书唯一外部标识，重跑 seed 靠它判定"已入库"
    external_id: Mapped[str | None] = mapped_column(String(64), index=True)
    # pending | parsing | ready | failed
    status: Mapped[str] = mapped_column(String(16), default="pending")
    error: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class Article(Base):
    """章节或独立文章，正文承载单位（模块 02）。"""

    __tablename__ = "article"

    id: Mapped[int] = mapped_column(primary_key=True)
    book_id: Mapped[int | None] = mapped_column(ForeignKey("book.id", ondelete="CASCADE"))
    ordinal: Mapped[int] = mapped_column(Integer, default=0)  # 书内章节序
    title: Mapped[str] = mapped_column(String(512))
    # book|paste|file|url|scenario；scenario 是场景本短文，不进书架列表（FR-264）
    source_kind: Mapped[str] = mapped_column(String(16), default="book")
    # 场景短文所属的单词本（FR-263）；其余来源为空
    deck_id: Mapped[int | None] = mapped_column(
        ForeignKey("wordlist.id", ondelete="CASCADE"), index=True
    )
    source_url: Mapped[str | None] = mapped_column(String(1024))
    file_key: Mapped[str | None] = mapped_column(String(512))  # file 类文章的原件（可重试）
    is_section: Mapped[bool] = mapped_column(Boolean, default=False)  # 分卷标题行，不可读
    # pending | parsing | ready | failed（book 章节由 parse_book 整本管控，恒为 ready）
    status: Mapped[str] = mapped_column(String(16), default="ready", server_default="ready")
    error: Mapped[str | None] = mapped_column(Text)
    fetched_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))  # url 抓取时间
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    __table_args__ = (Index("ix_article_book", "book_id", "ordinal"),)


class Paragraph(Base):
    """段落原文 + 词元标注。

    词元以 JSONB 存段内数组 [[start,end,lemma,pos,learnable],...]，不拆行：
    渲染与命中测试在前端按数组执行，避免亿级 token 行。偏移为 UTF-16 码元（BR-01）。
    """

    __tablename__ = "paragraph"

    id: Mapped[int] = mapped_column(primary_key=True)
    article_id: Mapped[int] = mapped_column(ForeignKey("article.id", ondelete="CASCADE"))
    ordinal: Mapped[int] = mapped_column(Integer)
    kind: Mapped[str] = mapped_column(String(16), default="text")  # text|heading|code|quote
    text: Mapped[str] = mapped_column(Text)
    tokens: Mapped[list | None] = mapped_column(JSONVariant)

    __table_args__ = (UniqueConstraint("article_id", "ordinal", name="uq_paragraph_pos"),)


class Sentence(Base):
    """句子行：进度锚点 + 分析缓存关联（服务端分句一次落库，BR-01）。"""

    __tablename__ = "sentence"

    id: Mapped[int] = mapped_column(primary_key=True)
    paragraph_id: Mapped[int] = mapped_column(ForeignKey("paragraph.id", ondelete="CASCADE"))
    ordinal: Mapped[int] = mapped_column(Integer)
    char_start: Mapped[int] = mapped_column(Integer)
    char_end: Mapped[int] = mapped_column(Integer)
    content_hash: Mapped[str] = mapped_column(String(64))

    __table_args__ = (
        UniqueConstraint("paragraph_id", "ordinal", name="uq_sentence_pos"),
        Index("ix_sentence_hash", "content_hash"),
    )


class AnalysisResult(Base):
    """AI/翻译产物统一缓存，按内容指纹寻址（ADR-006）。"""

    __tablename__ = "analysis_result"

    id: Mapped[int] = mapped_column(primary_key=True)
    scope: Mapped[str] = mapped_column(String(16))  # word|phrase|sentence|paragraph|document
    content_hash: Mapped[str] = mapped_column(String(64))
    context_hash: Mapped[str] = mapped_column(String(64), default="")
    kind: Mapped[str] = mapped_column(String(32))  # translate|word_explain|grammar|...
    provider: Mapped[str] = mapped_column(String(64))
    model: Mapped[str | None] = mapped_column(String(128))
    lang_pair: Mapped[str] = mapped_column(String(16), default="en->zh")
    result: Mapped[dict] = mapped_column(JSONVariant)
    version: Mapped[int] = mapped_column(Integer, default=1)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    latency_ms: Mapped[int | None] = mapped_column(Integer)
    cost_micros: Mapped[int | None] = mapped_column(Integer)  # 估算费用（百万分之一美元）
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    __table_args__ = (
        UniqueConstraint(
            "scope",
            "content_hash",
            "context_hash",
            "kind",
            "provider",
            "lang_pair",
            "version",
            name="uq_analysis_addr",
        ),
        Index(
            "ix_analysis_lookup",
            "scope",
            "content_hash",
            "context_hash",
            "kind",
            "provider",
            "lang_pair",
            postgresql_where=text("is_active"),
            sqlite_where=text("is_active = 1"),
        ),
    )


class Video(Base):
    """视频学习条目：yt-dlp 下载或本地导入（模块 03）。"""

    __tablename__ = "video"

    id: Mapped[int] = mapped_column(primary_key=True)
    source_url: Mapped[str | None] = mapped_column(String(1024))  # 代码层查重，本地导入为空
    title: Mapped[str] = mapped_column(String(512))
    channel: Mapped[str | None] = mapped_column(String(256))
    duration_s: Mapped[int | None] = mapped_column(Integer)
    file_key: Mapped[str | None] = mapped_column(String(512))
    thumb_key: Mapped[str | None] = mapped_column(String(512))
    # pending | downloading | transcribing | translating | ready | degraded | failed
    # degraded：流程跑完但产物不达标（句层为空 / 译文不全），显式标黄而非伪装 ready
    status: Mapped[str] = mapped_column(String(16), default="pending")
    error: Mapped[str | None] = mapped_column(Text)
    # 下载失败分型：bot_check（凭证失效/登录墙）| network | other（FR-22 前端引导）
    error_kind: Mapped[str | None] = mapped_column(String(16))
    progress: Mapped[int] = mapped_column(Integer, default=0)  # 0-100
    # ---- AI 加工产物（FR-18，enrich_video 任务写入，标注 AI 生成 BR-05） ----
    title_zh: Mapped[str | None] = mapped_column(String(512))  # AI 中文标题
    summary_zh: Mapped[str | None] = mapped_column(Text)  # AI 中文摘要 80-120 字
    difficulty: Mapped[int | None] = mapped_column(Integer)  # 难度星级 1-5
    difficulty_detail: Mapped[dict | None] = mapped_column(JSONVariant)  # {cefr_dist, wpm}
    accent: Mapped[str | None] = mapped_column(String(32))  # american|british|...|mixed
    topics: Mapped[list | None] = mapped_column(JSONVariant)  # 主题标签 [str] 1-3 个
    vocab_count: Mapped[int | None] = mapped_column(Integer)  # 字幕去重词数
    # pending | summary | difficulty | phrases | vocab | done | failed（分阶段可见）
    enrich_status: Mapped[str | None] = mapped_column(String(16))
    enriched_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class OnlineVideoReference(Base):
    __tablename__ = "online_video_reference"

    user_id: Mapped[str] = mapped_column(String(36), primary_key=True)
    video_key: Mapped[str] = mapped_column(String(32), primary_key=True)
    video_id: Mapped[int] = mapped_column(ForeignKey("video.id", ondelete="CASCADE"))


class SubtitleTrack(Base):
    """字幕轨：官方/自动/whisper 转写/翻译，同一视频可挂多轨。"""

    __tablename__ = "subtitle_track"

    id: Mapped[int] = mapped_column(primary_key=True)
    video_id: Mapped[int] = mapped_column(ForeignKey("video.id", ondelete="CASCADE"))
    kind: Mapped[str] = mapped_column(String(16))  # official|auto|whisper|translation
    lang: Mapped[str] = mapped_column(String(16))
    label: Mapped[str] = mapped_column(String(64))
    is_default: Mapped[bool] = mapped_column(Boolean, default=False)
    # 轨级元数据：词级时间戳为插值近似时标 {approximate: true}（FR-19）
    meta: Mapped[dict | None] = mapped_column(JSONVariant)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class SubtitleCue(Base):
    """字幕行：毫秒时间轴 + 与 sentence 同口径 content_hash，共享 analysis_result 缓存。"""

    __tablename__ = "subtitle_cue"

    id: Mapped[int] = mapped_column(primary_key=True)
    track_id: Mapped[int] = mapped_column(ForeignKey("subtitle_track.id", ondelete="CASCADE"))
    ordinal: Mapped[int] = mapped_column(Integer)
    start_ms: Mapped[int] = mapped_column(Integer)
    end_ms: Mapped[int] = mapped_column(Integer)
    text: Mapped[str] = mapped_column(Text)
    content_hash: Mapped[str] = mapped_column(String(64))
    # 句内词组区间 [[start,end,type,meaning],...]，偏移 UTF-16 码元，type 见 PHRASE_TYPES
    phrases: Mapped[list | None] = mapped_column(JSONVariant)
    # 词级时间戳 [[start_ms,end_ms,word],...]：whisper 实测或按字符比例插值（FR-19）
    words: Mapped[list | None] = mapped_column(JSONVariant)

    __table_args__ = (
        UniqueConstraint("track_id", "ordinal", name="uq_subtitle_cue_pos"),
        Index("ix_subtitle_cue_hash", "content_hash"),
    )


class SubtitleSentence(Base):
    """语法句：cue 文本流拼接后经 pysbd 分句得到（ADR-007）。

    翻译、AI 陪读引用、词组区间定位的单位。译文直接挂本表 text_zh
    （一句一译天然对齐），不再另建 translation 轨。
    """

    __tablename__ = "subtitle_sentence"

    id: Mapped[int] = mapped_column(primary_key=True)
    track_id: Mapped[int] = mapped_column(ForeignKey("subtitle_track.id", ondelete="CASCADE"))
    ordinal: Mapped[int] = mapped_column(Integer)
    # 首词 start / 末词 end，取自词级时间戳（非按字符比例插值）
    start_ms: Mapped[int] = mapped_column(Integer)
    end_ms: Mapped[int] = mapped_column(Integer)
    text: Mapped[str] = mapped_column(Text)
    text_zh: Mapped[str | None] = mapped_column(Text)
    content_hash: Mapped[str] = mapped_column(String(64))
    # 句内词组区间 [[start,end,type,meaning],...]，偏移 UTF-16 码元
    phrases: Mapped[list | None] = mapped_column(JSONVariant)
    # 词级时间戳 [[start_ms,end_ms,surface,char_start,char_end],...]，char 偏移在本句内
    words: Mapped[list | None] = mapped_column(JSONVariant)
    # 非语音标记（[Music]/[掌声]/[ __ ] 等）：不翻译、不计入进度分母、听写跟读跳过
    is_noise: Mapped[bool] = mapped_column(Boolean, default=False)
    # 来源 cue id 列表（跨 cue 时多个），供卡拉OK与时间轴回溯
    src_cue_ids: Mapped[list | None] = mapped_column(JSONVariant)
    # 字段级人工编辑时间戳 {字段名: ISO 时间}（FR-205）：
    # 自动再生成逐字段比对，人工改过的字段不覆盖（curation ratchet，BR-36）
    edited_fields: Mapped[dict | None] = mapped_column(JSONVariant)

    __table_args__ = (
        UniqueConstraint("track_id", "ordinal", name="uq_subtitle_sentence_pos"),
        Index("ix_subtitle_sentence_hash", "content_hash"),
    )


class StudyUnit(Base):
    """学习句：语法句 ≤7s 且 ≤84 字符时等同该句，超出则按

    句中标点 > 词间停顿≥300ms > 从属连词 二次切分（ADR-007）。
    听写/跟读/中译英/句收藏/已学标记的单位。
    """

    __tablename__ = "study_unit"

    id: Mapped[int] = mapped_column(primary_key=True)
    sentence_id: Mapped[int] = mapped_column(ForeignKey("subtitle_sentence.id", ondelete="CASCADE"))
    # 冗余轨 id：右栏列表按轨顺序取全部学习句，避免每次 join
    track_id: Mapped[int] = mapped_column(ForeignKey("subtitle_track.id", ondelete="CASCADE"))
    ordinal: Mapped[int] = mapped_column(Integer)  # 轨内全局序号
    start_ms: Mapped[int] = mapped_column(Integer)
    end_ms: Mapped[int] = mapped_column(Integer)
    text: Mapped[str] = mapped_column(Text)
    # 在所属语法句 text 内的 UTF-16 区间（词组高亮裁剪与平移用）
    char_start: Mapped[int] = mapped_column(Integer)
    char_end: Mapped[int] = mapped_column(Integer)
    content_hash: Mapped[str] = mapped_column(String(64))

    __table_args__ = (
        UniqueConstraint("track_id", "ordinal", name="uq_study_unit_pos"),
        Index("ix_study_unit_sentence", "sentence_id"),
    )


class StudyUnitState(Base):
    """学习句的用户状态：已学 ✓ / 收藏 / 难句旗标 / 人工修正 / 听写正确率。

    取代前端 localStorage（换设备可续）；多用户扩展只需加 user_id。
    """

    __tablename__ = "study_unit_state"

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[str | None] = mapped_column(String(36), index=True)
    unit_id: Mapped[int] = mapped_column(ForeignKey("study_unit.id", ondelete="CASCADE"))
    video_id: Mapped[int] = mapped_column(ForeignKey("video.id", ondelete="CASCADE"))
    learned: Mapped[bool] = mapped_column(Boolean, default=False)
    starred: Mapped[bool] = mapped_column(Boolean, default=False)
    flagged: Mapped[bool] = mapped_column(Boolean, default=False)
    text_override: Mapped[str | None] = mapped_column(Text)  # 人工修正字幕
    dictation_accuracy: Mapped[int | None] = mapped_column(Integer)  # 最近一次 0-100
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )

    __table_args__ = (
        UniqueConstraint("user_id", "unit_id", name="uq_study_unit_state_user_unit"),
        Index("ix_study_unit_state_user_video", "user_id", "video_id"),
    )


class VideoStudyProgress(Base):
    """视频级学习进度：各模式独立下标、播放位置、听写累计（FR-15/FR-32）。"""

    __tablename__ = "video_study_progress"

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[str | None] = mapped_column(String(36), index=True)
    video_id: Mapped[int] = mapped_column(ForeignKey("video.id", ondelete="CASCADE"))
    last_pos_s: Mapped[float] = mapped_column(Float, default=0.0)
    mode_idx: Mapped[dict | None] = mapped_column(JSONVariant)  # mode -> 当前句下标
    dict_stats: Mapped[dict | None] = mapped_column(JSONVariant)  # {done, correctWords, totalWords}
    starred: Mapped[bool] = mapped_column(Boolean, default=False)  # 视频收藏
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )

    __table_args__ = (UniqueConstraint("user_id", "video_id", name="uq_video_progress_user_video"),)


class VideoSubscription(Base):
    """YouTube 订阅源：频道 / 播放列表 / 单视频（需求 09 v4 FR-44）。

    走 RSS（`feeds/videos.xml?channel_id=`）轮询新片：无需 API key、无配额，
    实测 1.18s 返回最近 15 条。频道 id 与标题由 yt-dlp 解析首次入库时写死。
    """

    __tablename__ = "video_subscription"

    id: Mapped[int] = mapped_column(primary_key=True)
    kind: Mapped[str] = mapped_column(String(16))  # channel | playlist
    # RSS 的查询键：频道用 channel_id，播放列表用 playlist_id
    source_id: Mapped[str] = mapped_column(String(64), unique=True)
    title: Mapped[str] = mapped_column(String(256))
    url: Mapped[str | None] = mapped_column(String(512))  # 原始订阅链接，回跳用
    thumb_url: Mapped[str | None] = mapped_column(String(512))
    enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    last_checked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    last_error: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class VideoFeedItem(Base):
    """订阅源拉到的候选视频（需求 09 v4 FR-45/46/49）。

    轮询只写这张表，**不触发任何下载**（BR-16）——磁盘与 CPU 由人把关。
    用户在发现页预览后一键入库，才走下载全管线。
    """

    __tablename__ = "video_feed_item"

    id: Mapped[int] = mapped_column(primary_key=True)
    subscription_id: Mapped[int] = mapped_column(
        ForeignKey("video_subscription.id", ondelete="CASCADE")
    )
    video_key: Mapped[str] = mapped_column(String(32), unique=True)  # YouTube videoId
    title: Mapped[str] = mapped_column(String(512))
    thumb_url: Mapped[str | None] = mapped_column(String(512))
    duration_s: Mapped[int | None] = mapped_column(Integer)  # RSS 无时长，由 Data API 批量回填
    published_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    # v5：Data API 批量回填的展示字段（FR-58），卡片直接可见不必逐条点详情
    view_count: Mapped[int | None] = mapped_column(Integer)
    has_captions: Mapped[bool | None] = mapped_column(Boolean)  # Data API 只给布尔
    # 入库前难度预估（FR-59/60）；caption_kind：manual | auto | none（none 需 whisper 转写）
    caption_kind: Mapped[str | None] = mapped_column(String(8))
    wpm: Mapped[float | None] = mapped_column(Float)
    difficulty: Mapped[int | None] = mapped_column(Integer)
    # {cefr_dist, vocab_count, word_count, description, audio_language, probed_at, source}
    probe_meta: Mapped[dict | None] = mapped_column(JSONVariant)
    # 已入库则指向 video.id；忽略的置 ignored（两者都不再出现在待看列表）
    video_id: Mapped[int | None] = mapped_column(ForeignKey("video.id", ondelete="SET NULL"))
    ignored: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    __table_args__ = (
        Index("ix_video_feed_item_sub", "subscription_id"),
        Index("ix_video_feed_item_state", "ignored", "video_id"),
    )


class PipelineRun(Base):
    """一次管线运行（需求 09 v6 FR-64，模型抄 Dagster Run / Airflow DagRun）。

    重跑不改旧记录而是新建一条并以 parent_run_id 指向原 run（BR-22），
    历次运行可对比——换模型前后超限句数变化一目了然。
    """

    __tablename__ = "pipeline_run"

    id: Mapped[int] = mapped_column(primary_key=True)
    # 管线定义键（domain/pipeline.PIPELINES）与被处理主体，取代原先写死的 video_id（FR-192）
    domain: Mapped[str] = mapped_column(String(24), default="video")
    subject_id: Mapped[int] = mapped_column(Integer, default=0)
    # 保留且可空：唯一理由是视频删除时 run 能级联清掉，非视频域此列为空
    video_id: Mapped[int | None] = mapped_column(ForeignKey("video.id", ondelete="CASCADE"))
    kind: Mapped[str] = mapped_column(String(16), default="ingest")  # ingest|enrich|repair|generate
    trigger: Mapped[str] = mapped_column(String(16), default="user")  # user | cron | retry
    # pending | running | success | failed | cancelled
    status: Mapped[str] = mapped_column(String(16), default="pending")
    # 重跑起点与范围（FR-75）：single 仅此节点 / downstream 及下游 / failed 失败节点及下游
    from_step: Mapped[str | None] = mapped_column(String(32))
    scope: Mapped[str | None] = mapped_column(String(16))
    config_override: Mapped[dict | None] = mapped_column(JSONVariant)
    code_version: Mapped[str | None] = mapped_column(String(32))
    parent_run_id: Mapped[int | None] = mapped_column(
        ForeignKey("pipeline_run.id", ondelete="SET NULL")
    )
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    error: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    __table_args__ = (
        Index("ix_pipeline_run_video", "video_id", "id"),
        Index("ix_pipeline_run_status", "status"),
        Index("ix_pipeline_run_subject", "domain", "subject_id", "id"),
    )


class PipelineStep(Base):
    """管线单节点的执行记录（FR-65）：做了什么(metrics) + 用了什么(config)。

    字段命名对齐 OpenTelemetry span 语义，将来接 APM 不必改模型。
    code_version 是本表存在的首要理由：产物是哪版管线跑的必须可查——
    v6 的触发故障正是"worker 跑老代码产出静默降级"而系统全无察觉（FR-66）。
    """

    __tablename__ = "pipeline_step"

    id: Mapped[int] = mapped_column(primary_key=True)
    run_id: Mapped[int] = mapped_column(ForeignKey("pipeline_run.id", ondelete="CASCADE"))
    name: Mapped[str] = mapped_column(String(32))  # domain.pipeline.STEPS 的节点名
    ordinal: Mapped[int] = mapped_column(Integer, default=0)
    # pending | running | success | failed | skipped
    status: Mapped[str] = mapped_column(String(16), default="pending")
    attempt: Mapped[int] = mapped_column(Integer, default=1)
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    duration_ms: Mapped[int | None] = mapped_column(Integer)
    error: Mapped[str | None] = mapped_column(Text)
    error_kind: Mapped[str | None] = mapped_column(String(16))
    metrics: Mapped[dict | None] = mapped_column(JSONVariant)  # 量化产出，可判好坏
    config: Mapped[dict | None] = mapped_column(JSONVariant)  # 实际用的模型与参数
    logs: Mapped[str | None] = mapped_column(Text)
    code_version: Mapped[str | None] = mapped_column(String(32))

    __table_args__ = (
        Index("ix_pipeline_step_run", "run_id", "ordinal"),
        UniqueConstraint("run_id", "name", "attempt", name="uq_pipeline_step_attempt"),
    )


class StepArtifact(Base):
    """节点产物快照（FR-195~198）：分步重跑与人工修正的事实源。

    中间态原本只活在 worker 进程内存的 _PipeState 里，跑完即没——这是"只重跑
    某一步"做不到的根因。产物落库后，下游能拿到上游产物，节点才真正可以单独重算。
    模型对齐 Dify 变量检查器 / LangGraph channel_values / Airflow XCom。
    """

    __tablename__ = "step_artifact"

    id: Mapped[int] = mapped_column(primary_key=True)
    domain: Mapped[str] = mapped_column(String(24))
    subject_id: Mapped[int] = mapped_column(Integer)
    step: Mapped[str] = mapped_column(String(48))
    # 输入指纹命中且非强制重跑 → 该节点记 skipped(cached) 直接复用产物
    input_fingerprint: Mapped[str] = mapped_column(String(64))
    # 内容指纹变了才让下游陈旧；重跑出同样内容不建新版本
    content_sha256: Mapped[str] = mapped_column(String(64))
    payload: Mapped[dict | None] = mapped_column(JSONVariant)  # 小产物直接进 JSONB
    blob_key: Mapped[str | None] = mapped_column(String(255))  # 大产物落盘，库内只存 key
    bytes: Mapped[int | None] = mapped_column(Integer)
    summary: Mapped[str | None] = mapped_column(String(255))  # 节点上直接印的一行摘要
    produced_by_run_id: Mapped[int | None] = mapped_column(
        ForeignKey("pipeline_run.id", ondelete="SET NULL")
    )
    code_version: Mapped[str | None] = mapped_column(String(32))
    human_edited: Mapped[bool] = mapped_column(Boolean, default=False)
    edit_patch: Mapped[dict | None] = mapped_column(JSONVariant)
    is_current: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    __table_args__ = (
        Index("ix_artifact_subject", "domain", "subject_id", "step", "created_at"),
        Index(
            "uq_artifact_current",
            "domain",
            "subject_id",
            "step",
            unique=True,
            postgresql_where=text("is_current"),
            sqlite_where=text("is_current = 1"),
        ),
    )


class PipelineInterrupt(Base):
    """人工确认点（FR-199~201）：run 挂起等人，恢复后从该节点头部重跑。

    语义取自 LangGraph 的 interrupt() / Command(resume=)。两条硬约束：
    暂停点之前的代码必须幂等（恢复时整个节点重跑），且绝不能让 worker 挂起
    等人——当前 job 正常结束，恢复时入队新 job。
    """

    __tablename__ = "pipeline_interrupt"

    id: Mapped[int] = mapped_column(primary_key=True)
    run_id: Mapped[int] = mapped_column(ForeignKey("pipeline_run.id", ondelete="CASCADE"))
    step: Mapped[str] = mapped_column(String(48))
    kind: Mapped[str] = mapped_column(String(16), default="approve")  # approve|edit|choose
    payload: Mapped[dict | None] = mapped_column(JSONVariant)  # 给人看的内容
    resume_value: Mapped[dict | None] = mapped_column(JSONVariant)
    status: Mapped[str] = mapped_column(String(12), default="waiting")  # waiting|resolved|expired
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    resolved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    __table_args__ = (Index("ix_interrupt_run", "run_id", "status"),)


class SubtitleIssue(Base):
    """AI 无参考校验与体检发现的问题（FR-77/80）。

    定位到语法句，逐条采纳或忽略而不是整段覆盖——LLM 裁判会误报，
    人保留最终决定权（业内 human-in-the-loop 共识）。
    """

    __tablename__ = "subtitle_issue"

    id: Mapped[int] = mapped_column(primary_key=True)
    video_id: Mapped[int] = mapped_column(ForeignKey("video.id", ondelete="CASCADE"))
    sentence_id: Mapped[int | None] = mapped_column(
        ForeignKey("subtitle_sentence.id", ondelete="CASCADE")
    )
    source: Mapped[str] = mapped_column(String(16))  # ai | health
    # wrong_word | bad_split | noise | translation_mismatch | over_limit | timing
    kind: Mapped[str] = mapped_column(String(24))
    severity: Mapped[str] = mapped_column(String(8), default="warn")  # info | warn | error
    detail: Mapped[str] = mapped_column(Text)
    suggestion: Mapped[str | None] = mapped_column(Text)  # 建议内容，配合 action 用
    # 怎么修（v10.7 FR-143）：replace_text | replace_translation | mark_noise |
    # merge_prev | merge_next | split_at | manual。旧数据为空按 kind 兜底
    action: Mapped[str | None] = mapped_column(String(24))
    anchor: Mapped[str | None] = mapped_column(Text)  # split_at 的切点原文
    # open | accepted | dismissed
    state: Mapped[str] = mapped_column(String(12), default="open")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    __table_args__ = (Index("ix_subtitle_issue_video", "video_id", "state"),)


class RepairSession(Base):
    """AI 修复会话（需求 09 v7 FR-85/88）：一次"用自然语言把问题说清并修掉"的过程。

    与陪读会话完全隔离（BR-26）。model_alias 记会话用的语义别名，换模型重试
    产生新会话并以 parent_session_id 相连，问题上下文随带。
    """

    __tablename__ = "repair_session"

    id: Mapped[int] = mapped_column(primary_key=True)
    video_id: Mapped[int] = mapped_column(ForeignKey("video.id", ondelete="CASCADE"))
    # 锚定的节点名（domain.pipeline.STEPS）；空表示面向整条视频
    step_name: Mapped[str | None] = mapped_column(String(32))
    # open 对话中 | working 代理执行中 | done | failed
    status: Mapped[str] = mapped_column(String(12), default="open")
    model_alias: Mapped[str] = mapped_column(String(64), default="repair-agent")
    # 会话级显式模型部署；空则跟随 model_alias 的能力绑定。
    model_deployment_id: Mapped[int | None] = mapped_column(
        ForeignKey("model_deployment.id", ondelete="SET NULL"), index=True
    )
    # 高危操作确认门（BR-25）：代理挂起的待确认动作 {tool, args, reason}
    pending_action: Mapped[dict | None] = mapped_column(JSONVariant)
    # pydantic-ai 序列化的完整模型消息（含工具调用），跨轮续聊的精确状态
    history: Mapped[list | None] = mapped_column(JSONVariant)
    parent_session_id: Mapped[int | None] = mapped_column(
        ForeignKey("repair_session.id", ondelete="SET NULL")
    )
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    __table_args__ = (Index("ix_repair_session_video", "video_id", "id"),)


class RepairMessage(Base):
    """修复会话消息：user / assistant / system（确认、模型切换等系统注记）。"""

    __tablename__ = "repair_message"

    id: Mapped[int] = mapped_column(primary_key=True)
    session_id: Mapped[int] = mapped_column(ForeignKey("repair_session.id", ondelete="CASCADE"))
    role: Mapped[str] = mapped_column(String(12))
    content: Mapped[str] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    __table_args__ = (Index("ix_repair_message_session", "session_id", "id"),)


class RepairAction(Base):
    """修复代理的每次工具调用（FR-88 审计）：参数、结果、耗时全落库。"""

    __tablename__ = "repair_action"

    id: Mapped[int] = mapped_column(primary_key=True)
    session_id: Mapped[int] = mapped_column(ForeignKey("repair_session.id", ondelete="CASCADE"))
    tool: Mapped[str] = mapped_column(String(48))
    args: Mapped[dict | None] = mapped_column(JSONVariant)
    # running | success | failed | pending_confirm
    status: Mapped[str] = mapped_column(String(16), default="running")
    result: Mapped[dict | None] = mapped_column(JSONVariant)
    error: Mapped[str | None] = mapped_column(Text)
    duration_ms: Mapped[int | None] = mapped_column(Integer)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    __table_args__ = (Index("ix_repair_action_session", "session_id", "id"),)


class VocabEntry(Base):
    """生词本条目，按词条去重（模块 04）。

    > [!info] 三根独立的轴，谁也不覆盖谁
    >
    > 词的「处于什么阶段」过去只有一根轴（FSRS 卡），于是「学习过」只能去挤
    > `status=learning`——而那一档已经被「领取」这个动作占了（领取瞬间就写
    > `init_card()`，`mastery_bucket` 立刻返回 learning，new 与 learning 之间没有空档）。
    >
    > | 轴 | 载体 | 谁写 | 与 FSRS |
    > | --- | --- | --- | --- |
    > | 接触度 | `exposures` / `last_seen_at` | 曝光接口 | **完全不碰 fsrs_card** |
    > | 调度 | `fsrs_card` / `due_at` / `last_review_at` | 只有 `submit_review` | 唯一真相 |
    > | 自测过关 | `self_test_at` | 自测提交 | 并存，不回写 |
    >
    > 五档由 `domain/study_stage.stage()` 现算，`status` 降级为派生缓存。
    > 形状抄 `GrammarConceptState`（reps/lapses/marked_known_at），
    > 那里的注释「用户自己标的『我会了』，与 FSRS 到期是两件事」说的正是同一件事。

    > [!danger] 曝光计数绝不能推 FSRS
    >
    > 「点开看一眼」若当成一次 Good 评分，会把 stability 推上去，
    > 于是一个从没测过的词被排到几周后才复习。所以 `exposures` 是独立列、
    > 独立接口，一个字节都不碰 `fsrs_card` / `due_at`。
    """

    __tablename__ = "vocab_entry"

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[str | None] = mapped_column(String(36), index=True)
    word: Mapped[str] = mapped_column(String(128), index=True)
    lemma: Mapped[str | None] = mapped_column(String(128))
    status: Mapped[str] = mapped_column(String(16), default="new")  # new|learning|known
    source: Mapped[str] = mapped_column(String(16), default="reading")  # reading|wordlist
    fsrs_card: Mapped[dict | None] = mapped_column(JSONVariant)  # py-fsrs Card 字典，空=未入调度
    due_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), index=True)
    last_review_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    # 接触度轴：看过几次、最近一次什么时候。打开一次词卡即算见过
    exposures: Mapped[int] = mapped_column(Integer, default=0)
    last_seen_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    # 自测过关轴：通过一次场景自测的时刻。与 FSRS 并存，互不回写
    self_test_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    # 人工标记轴：用户在词卡上自己按的。learning|mastered|hard，空=没标过
    #
    # > [!danger] 人工标记不能写进 fsrs_card
    # >
    # > 「已掌握」曾经是往 fsrs_card 里塞一张合成卡（`batch` 的 master 分支至今如此），
    # > 「困难词」则是读 `fsrs_card.difficulty`。可 FSRS 的 stability/difficulty 是
    # > **从真实答题结果估出来的**，手动按一下就改写它，等于往调度模型里灌假数据，
    # > 之后每一次复习间隔都建立在这条假数据上。
    # >
    # > 人工标记是「用户认为自己怎么样」，FSRS 卡是「算法读出来怎么样」，
    # > 两件事两列存。显示与筛选上人工标记优先——用户明说了的，不该被算法覆盖。
    mark: Mapped[str | None] = mapped_column(String(16))
    marked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    __table_args__ = (UniqueConstraint("user_id", "word", name="uq_vocab_entry_user_word"),)


class PracticeSession(Base):
    __tablename__ = "practice_session"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    user_id: Mapped[str] = mapped_column(String(36), index=True)
    mode: Mapped[str] = mapped_column(String(24))
    status: Mapped[str] = mapped_column(String(16), default="active")
    scope: Mapped[dict] = mapped_column(JSONVariant)
    questions: Mapped[list] = mapped_column(JSONVariant)
    cursor: Mapped[int] = mapped_column(Integer, default=0)
    version: Mapped[int] = mapped_column(Integer, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class PracticePack(Base):
    __tablename__ = "practice_pack"

    id: Mapped[int] = mapped_column(primary_key=True)
    session_id: Mapped[str] = mapped_column(
        ForeignKey("practice_session.id", ondelete="CASCADE"), unique=True
    )
    user_id: Mapped[str] = mapped_column(String(36), index=True)
    status: Mapped[str] = mapped_column(String(16), default="queued")
    automatic: Mapped[bool] = mapped_column(Boolean, default=True)
    analysis_id: Mapped[int | None] = mapped_column(ForeignKey("analysis_result.id"))
    error: Mapped[str | None] = mapped_column(Text)
    targets: Mapped[list] = mapped_column(JSONVariant)
    charged_days: Mapped[list] = mapped_column(JSONVariant, default=list)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class PracticeProfile(Base):
    __tablename__ = "practice_profile"

    user_id: Mapped[str] = mapped_column(String(36), primary_key=True)
    timezone: Mapped[str] = mapped_column(String(64), default="UTC")
    daily_new: Mapped[int] = mapped_column(Integer, default=10)
    auto_enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    auto_limit: Mapped[int] = mapped_column(Integer, default=5)
    generating: Mapped[bool] = mapped_column(Boolean, default=False)


class PracticeAnswer(Base):
    __tablename__ = "practice_answer"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    session_id: Mapped[str] = mapped_column(
        ForeignKey("practice_session.id", ondelete="CASCADE"), index=True
    )
    question_id: Mapped[str] = mapped_column(String(36))
    answer: Mapped[str] = mapped_column(Text)
    hints: Mapped[int] = mapped_column(Integer, default=0)
    replays: Mapped[int] = mapped_column(Integer, default=0)
    verdict: Mapped[str] = mapped_column(String(24))
    rating: Mapped[int | None] = mapped_column(Integer)
    review_log_id: Mapped[int | None] = mapped_column(ForeignKey("review_log.id"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    __table_args__ = (UniqueConstraint("session_id", "question_id", name="uq_practice_question"),)


class DeckSceneState(Base):
    """某一本里某个场景的自测状态（考纲本按场景学）。

    `passed_at` 只是**缓存**：真正的判据是「该场景所有词的 `self_test_at` 非空」，
    删了这张表能从词级重算出来。存它是为了列表页不必对每个场景做一次全表扫描。

    > [!danger] 场景不通过，绝不回写词的 FSRS
    >
    > 场景是 AND 门（全过才算过），FSRS 是按词的连续量。60 词的场景里
    > 59 个已掌握、1 个在重学，场景判不通过——但那 59 个词一个都不该降级。
    > 所以界面说的是「59/60 已通过」，不是「场景未通过」，
    > 更不是把整个场景的进度归零。
    """

    __tablename__ = "deck_scene_state"

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[str | None] = mapped_column(String(36), index=True)
    deck: Mapped[str] = mapped_column(String(32))
    scene: Mapped[str] = mapped_column(String(64))
    # 断点续测：测到第几个小组。自测一个 95 词的场景要分好几次做完
    batch_cursor: Mapped[int] = mapped_column(Integer, default=0)
    version: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    run_id: Mapped[str | None] = mapped_column(String(36))
    attempts: Mapped[int] = mapped_column(Integer, default=0)
    # 首答对/首答总数：只做展示与「建议再刷一遍」的软提示，不当过关门槛
    first_try_ok: Mapped[int] = mapped_column(Integer, default=0)
    first_try_total: Mapped[int] = mapped_column(Integer, default=0)
    passed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )

    __table_args__ = (
        UniqueConstraint("user_id", "deck", "scene", name="uq_deck_scene_state_user"),
    )


class LearningReceipt(Base):
    __tablename__ = "learning_receipt"

    user_id: Mapped[str] = mapped_column(String(36), primary_key=True)
    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    scope: Mapped[str] = mapped_column(String(256))
    fingerprint: Mapped[str] = mapped_column(String(64))
    response: Mapped[dict] = mapped_column(JSONVariant)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class ImportDispatch(Base):
    __tablename__ = "import_dispatch"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    function: Mapped[str] = mapped_column(String(64))
    subject_id: Mapped[int] = mapped_column(Integer)
    status: Mapped[str] = mapped_column(String(16), default="pending", index=True)
    attempts: Mapped[int] = mapped_column(Integer, default=0)
    error: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class ReviewLog(Base):
    """复习记录：每次评分一条，fsrs_log 存 py-fsrs ReviewLog 字典（模块 05）。"""

    __tablename__ = "review_log"

    id: Mapped[int] = mapped_column(primary_key=True)
    vocab_id: Mapped[int] = mapped_column(ForeignKey("vocab_entry.id", ondelete="CASCADE"))
    rating: Mapped[int] = mapped_column(Integer)  # 1=Again 2=Hard 3=Good 4=Easy
    state_before: Mapped[str] = mapped_column(String(16))  # new|learning|review|relearning
    review_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    elapsed_days: Mapped[float | None] = mapped_column(Float)  # 距上次复习的间隔天数
    fsrs_log: Mapped[dict | None] = mapped_column(JSONVariant)


class TalkSession(Base):
    """场景陪练会话：回合制语音/文字对话（模块 06）。"""

    __tablename__ = "talk_session"

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[str | None] = mapped_column(String(36), index=True)
    mode: Mapped[str] = mapped_column(String(16))  # voice | text
    scenario_key: Mapped[str | None] = mapped_column(String(64))  # 空为自由对话
    difficulty: Mapped[str] = mapped_column(String(16), default="medium")  # easy|medium|hard
    summary: Mapped[dict | None] = mapped_column(JSONVariant)  # 结束时生成的会话总结
    started_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    ended_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class TalkTurn(Base):
    """对话回合：用户回合可挂表达反馈 {level: ok|improve, note, better}。"""

    __tablename__ = "talk_turn"

    id: Mapped[int] = mapped_column(primary_key=True)
    session_id: Mapped[int] = mapped_column(ForeignKey("talk_session.id", ondelete="CASCADE"))
    ordinal: Mapped[int] = mapped_column(Integer)
    role: Mapped[str] = mapped_column(String(16))  # user | assistant
    text: Mapped[str] = mapped_column(Text)
    message_id: Mapped[str | None] = mapped_column(String(36))
    complete: Mapped[bool] = mapped_column(Boolean, default=True, server_default=true())
    saved: Mapped[bool] = mapped_column(Boolean, default=False, server_default=false())
    saved_texts: Mapped[list] = mapped_column(JSONVariant, default=list, server_default="[]")
    feedback: Mapped[dict | None] = mapped_column(JSONVariant)  # 仅用户回合
    audio_key: Mapped[str | None] = mapped_column(String(512))  # 语音回合的原始音频
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    __table_args__ = (
        UniqueConstraint("session_id", "ordinal", name="uq_talk_turn_pos"),
        Index("uq_talk_turn_message", "message_id", unique=True),
    )


class TalkCoachBatch(Base):
    __tablename__ = "talk_coach_batch"

    id: Mapped[int] = mapped_column(primary_key=True)
    turn_id: Mapped[int] = mapped_column(ForeignKey("talk_turn.id", ondelete="CASCADE"))
    batch_index: Mapped[int] = mapped_column(Integer)
    status: Mapped[str] = mapped_column(String(16), default="running")
    analysis_id: Mapped[int | None] = mapped_column(ForeignKey("analysis_result.id"))
    error: Mapped[str | None] = mapped_column(Text)
    saved_replies: Mapped[list] = mapped_column(JSONVariant, default=list)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    __table_args__ = (UniqueConstraint("turn_id", "batch_index", name="uq_talk_coach_batch"),)


class UserScenario(Base):
    """用户自建陪练场景：结构同内置 YAML，整体存 JSON（模块 06）。"""

    __tablename__ = "user_scenario"

    id: Mapped[int] = mapped_column(primary_key=True)
    key: Mapped[str] = mapped_column(String(64), unique=True)
    data: Mapped[dict] = mapped_column(JSONVariant)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )


class VocabOccurrence(Base):
    """生词出现记录：同一词多处收藏各留一条语境。"""

    __tablename__ = "vocab_occurrence"

    id: Mapped[int] = mapped_column(primary_key=True)
    vocab_id: Mapped[int] = mapped_column(ForeignKey("vocab_entry.id", ondelete="CASCADE"))
    article_id: Mapped[int | None] = mapped_column(Integer)
    sentence_id: Mapped[int | None] = mapped_column(Integer)
    video_id: Mapped[int | None] = mapped_column(Integer)  # 视频语境出处
    cue_id: Mapped[int | None] = mapped_column(Integer)  # 字幕行出处
    source_kind: Mapped[str] = mapped_column(String(16), default="manual")
    source_label: Mapped[str | None] = mapped_column(String(160))
    source_locator: Mapped[dict] = mapped_column(JSONVariant, default=dict)
    source_fingerprint: Mapped[str] = mapped_column(String(64))
    context_text: Mapped[str] = mapped_column(Text)
    added_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    __table_args__ = (
        UniqueConstraint("vocab_id", "source_fingerprint", name="uq_vocab_occurrence_source"),
    )


class ReadingProgress(Base):
    """章节阅读进度：一章一行，read_paragraphs 存已读段落 ordinal 数组（模块 02）。"""

    __tablename__ = "reading_progress"

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[str | None] = mapped_column(String(36), index=True)
    article_id: Mapped[int] = mapped_column(ForeignKey("article.id", ondelete="CASCADE"))
    last_paragraph_ordinal: Mapped[int] = mapped_column(Integer, default=0)
    read_paragraphs: Mapped[list | None] = mapped_column(JSONVariant)  # 去重后的 int 数组
    duration_s: Mapped[int] = mapped_column(Integer, default=0)  # 累计阅读时长（秒）
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )

    __table_args__ = (
        UniqueConstraint("user_id", "article_id", name="uq_reading_progress_user_article"),
    )


class StudyTimeLog(Base):
    """学习时长流水（阅读/口语按次追加）：首页今日与周视图的唯一时长真相。

    ReadingProgress.duration_s 是单章累计口径，回答不了「今天学了多久」；
    写点在 progress 保存（reading delta）与 talk 结束（会话时长）两处，
    查询按天求和，不反写任何累计列。"""

    __tablename__ = "study_time_log"

    id: Mapped[int] = mapped_column(BigIntegerPK, primary_key=True, autoincrement=True)
    user_id: Mapped[str] = mapped_column(String(36), index=True)
    kind: Mapped[str] = mapped_column(String(16))  # reading | speaking
    seconds: Mapped[int] = mapped_column(Integer)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), index=True
    )

    __table_args__ = (Index("ix_study_time_user_kind_day", "user_id", "kind", "created_at"),)


class Annotation(Base):
    """批注：paragraph_id + UTF-16 char 区间锚定（与词元同口径，BR-01）。"""

    __tablename__ = "annotation"

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[str | None] = mapped_column(String(36), index=True)
    article_id: Mapped[int] = mapped_column(
        ForeignKey("article.id", ondelete="CASCADE"), index=True
    )
    paragraph_id: Mapped[int] = mapped_column(ForeignKey("paragraph.id", ondelete="CASCADE"))
    char_start: Mapped[int] = mapped_column(Integer)
    char_end: Mapped[int] = mapped_column(Integer)
    color: Mapped[str] = mapped_column(String(16), default="yellow")
    note: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )


class Bookmark(Base):
    """书签（FR-377）：段落级锚点，读到哪儿手动插旗，与批注的区间锚定分开。

    批注是"标记这段文字"，书签是"记住这个位置"——两者语义不同，
    列表页的用法也不同（批注按颜色筛、书签按顺序跳），合表会把两边都做拧。
    """

    __tablename__ = "bookmark"

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[str | None] = mapped_column(String(36), index=True)
    article_id: Mapped[int] = mapped_column(
        ForeignKey("article.id", ondelete="CASCADE"), index=True
    )
    paragraph_id: Mapped[int] = mapped_column(ForeignKey("paragraph.id", ondelete="CASCADE"))
    # 建签时段落正文的前若干字符，列表里不必回查段落就能显示
    preview: Mapped[str] = mapped_column(String(240), default="")
    label: Mapped[str | None] = mapped_column(String(120))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    __table_args__ = (
        UniqueConstraint("user_id", "article_id", "paragraph_id", name="uq_bookmark_user_para"),
    )


class Wordlist(Base):
    """落库单词本（模块 05 v2）：导入本与 AI 场景本共用此表。

    生词本与考纲本仍是虚拟本（前者取 vocab_entry 全集，后者走 ECDICT tag），
    由列表接口合成同构对象返回，不占本表行（FR-187）。
    """

    __tablename__ = "wordlist"

    id: Mapped[int] = mapped_column(primary_key=True)
    catalog_key: Mapped[str | None] = mapped_column(String(64), unique=True, index=True)
    name: Mapped[str] = mapped_column(String(128))
    kind: Mapped[str] = mapped_column(String(16), default="custom")  # custom|scenario
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    # 封面：emoji 直接渲染，color_seed 参与前端渐变哈希，全程无图片请求（FR-151）
    emoji: Mapped[str | None] = mapped_column(String(16))
    color_seed: Mapped[int] = mapped_column(Integer, default=0)
    # AI 生成封面的存储 key（模块 16 FR-420）。为空则回落到上面的 emoji + 渐变——
    # 那套兜底不删：离线可用、零请求，且生图失败时仍要有视觉身份
    cover_key: Mapped[str | None] = mapped_column(String(512))
    description: Mapped[str | None] = mapped_column(Text)
    category: Mapped[str | None] = mapped_column(String(32))  # 场景本八大类归属
    cefr: Mapped[str | None] = mapped_column(String(4))  # A1..C2，供难度过滤复用
    source: Mapped[str] = mapped_column(String(16), default="import")  # import|ai|manual
    status: Mapped[str] = mapped_column(String(16), default="ready")  # draft|ready
    pinned_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    archived_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    daily_new_limit: Mapped[int] = mapped_column(Integer, default=10)
    # 场景短文的角色音色映射 {角色名: TTS 音色}（FR-275）。
    # 存在本上而不是产物里：重跑短文不该把用户挑好的嗓音冲掉
    role_voices: Mapped[dict | None] = mapped_column(JSONVariant)


class WordlistItem(Base):
    """单词本条目：translation 为导入/生成自带释义，词典无命中时兜底。"""

    __tablename__ = "wordlist_item"

    id: Mapped[int] = mapped_column(primary_key=True)
    wordlist_id: Mapped[int] = mapped_column(ForeignKey("wordlist.id", ondelete="CASCADE"))
    word: Mapped[str] = mapped_column(String(128))
    translation: Mapped[str | None] = mapped_column(Text)
    ordinal: Mapped[int] = mapped_column(Integer, default=0)
    # 场景本分组：core_noun|action|descriptor|phrase|pattern，其余类型为空即不分组
    # 列名避开 PostgreSQL 保留字 group
    group_key: Mapped[str | None] = mapped_column(String(24))
    example_en: Mapped[str | None] = mapped_column(Text)
    example_zh: Mapped[str | None] = mapped_column(Text)
    dict_miss: Mapped[bool] = mapped_column(Boolean, default=False)  # 词典外词条（BR-30）
    edited_fields: Mapped[dict | None] = mapped_column(JSONVariant)  # 同上（FR-205）

    __table_args__ = (UniqueConstraint("wordlist_id", "word", name="uq_wordlist_item_word"),)


class ProviderCredential(Base):
    """供应商凭据（模块 11 配置中心）。

    config 中敏感字段（api_key/access_key）以 Fernet 密文存储，前缀 "enc:"；
    单用户阶段无 user_id，未来多用户加列即可。
    """

    __tablename__ = "provider_credential"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(128))
    kind: Mapped[str] = mapped_column(String(16))  # llm | tts | realtime | translate
    provider_type: Mapped[str] = mapped_column(String(32))  # deepseek | openai_compatible | ...
    config: Mapped[dict] = mapped_column(JSONVariant)
    enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    status: Mapped[str] = mapped_column(String(16), default="untested")  # untested|ok|failed
    status_detail: Mapped[str | None] = mapped_column(Text)
    last_tested_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    # {items: [...], refreshed_at}：最近一次拉取的上游模型/音色列表
    models_cache: Mapped[dict | None] = mapped_column(JSONVariant)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )


class CredentialAccess(Base):
    """凭据访问台账（模块 19）：读出 / 填充 / 导出 / 导入各记一行。

    供应商调用（LLM、TTS）不记——太密，记了也没人看。凭据删掉后行保留，
    名字快照在 ``credential_name`` 里，外键置空。
    """

    __tablename__ = "credential_access"

    id: Mapped[int] = mapped_column(BigIntegerPK, primary_key=True, autoincrement=True)
    credential_id: Mapped[int | None] = mapped_column(
        ForeignKey("provider_credential.id", ondelete="SET NULL"), index=True
    )
    credential_name: Mapped[str] = mapped_column(String(128))
    mode: Mapped[str] = mapped_column(String(16))  # read | fill | export | import
    field: Mapped[str | None] = mapped_column(String(64))
    purpose: Mapped[str] = mapped_column(String(64))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), index=True
    )


class GoogleAccount(Base):
    """已授权的 Google 账号（模块 18）。

    刷新令牌在 provider_credential（kind=oauth）里，这里只记账号本身。
    """

    __tablename__ = "google_account"

    id: Mapped[int] = mapped_column(primary_key=True)
    email: Mapped[str] = mapped_column(String(320), unique=True)
    display_name: Mapped[str | None] = mapped_column(String(120))
    credential_id: Mapped[int] = mapped_column(
        ForeignKey("provider_credential.id", ondelete="CASCADE"), index=True
    )
    scopes: Mapped[list | None] = mapped_column(JSONVariant)
    history_id: Mapped[str | None] = mapped_column(String(32))
    last_sync_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    status: Mapped[str] = mapped_column(String(16), default="ok")  # ok | reauth
    status_detail: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class MailMessage(Base):
    """收件箱缓存（模块 18）：列表用的元数据一次同步落下来，正文点开时再取。"""

    __tablename__ = "mail_message"

    id: Mapped[int] = mapped_column(BigIntegerPK, primary_key=True, autoincrement=True)
    account_id: Mapped[int] = mapped_column(
        ForeignKey("google_account.id", ondelete="CASCADE"), index=True
    )
    gmail_id: Mapped[str] = mapped_column(String(32))
    thread_id: Mapped[str | None] = mapped_column(String(32))
    from_name: Mapped[str | None] = mapped_column(String(256))
    from_addr: Mapped[str | None] = mapped_column(String(320))
    to_addrs: Mapped[list | None] = mapped_column(JSONVariant)
    subject: Mapped[str] = mapped_column(Text, default="")
    snippet: Mapped[str] = mapped_column(Text, default="")
    sent_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), index=True)
    labels: Mapped[list | None] = mapped_column(JSONVariant)
    unread: Mapped[bool] = mapped_column(Boolean, default=False)
    has_attachments: Mapped[bool] = mapped_column(Boolean, default=False)
    body_text: Mapped[str | None] = mapped_column(Text)
    # 「收入阅读」后指向生成的文章；文章删了这里置空
    article_id: Mapped[int | None] = mapped_column(ForeignKey("article.id", ondelete="SET NULL"))
    fetched_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    __table_args__ = (
        UniqueConstraint("account_id", "gmail_id", name="uq_mail_message_account_gmail"),
    )


class RoutineRun(Base):
    """例程的一次产出（模块 20）：早报这类定时跑出来、要念给人听或塞进「今天」的东西。"""

    __tablename__ = "routine_run"

    id: Mapped[int] = mapped_column(BigIntegerPK, primary_key=True, autoincrement=True)
    key: Mapped[str] = mapped_column(String(32), index=True)  # morning_brief | ...
    text: Mapped[str] = mapped_column(Text)
    payload: Mapped[dict | None] = mapped_column(JSONVariant)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), index=True
    )


class ComputerSession(Base):
    """电脑操控会话（模块 21）：一个目标、一串步骤、若干次审批；范围默认浏览器。"""

    __tablename__ = "computer_session"

    id: Mapped[int] = mapped_column(primary_key=True)
    goal: Mapped[str] = mapped_column(Text)
    start_url: Mapped[str | None] = mapped_column(String(2048))
    scope: Mapped[str] = mapped_column(String(16), default="browser")  # browser | desktop（未做）
    # queued | running | waiting_approval | waiting_input | paused | done | failed | stopped
    status: Mapped[str] = mapped_column(String(24), default="queued", index=True)
    status_detail: Mapped[str | None] = mapped_column(Text)
    plan: Mapped[list | None] = mapped_column(JSONVariant)
    summary: Mapped[str | None] = mapped_column(Text)
    step_count: Mapped[int] = mapped_column(Integer, default=0)
    max_steps: Mapped[int] = mapped_column(Integer, default=40)
    max_minutes: Mapped[int] = mapped_column(Integer, default=15)
    current_url: Mapped[str | None] = mapped_column(String(2048))
    capability: Mapped[str | None] = mapped_column(String(32))
    conversation_id: Mapped[str | None] = mapped_column(
        ForeignKey("jarvis_conversation.id", ondelete="SET NULL"), index=True
    )
    mission_id: Mapped[str | None] = mapped_column(
        ForeignKey("jarvis_mission.id", ondelete="SET NULL"), index=True
    )
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    ended_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class ComputerStep(Base):
    """会话里的一步：动作、参数、结果、截图；审批也是一步（kind=ask）。截图 7 天后清掉，行保留。"""

    __tablename__ = "computer_step"

    id: Mapped[int] = mapped_column(primary_key=True)
    session_id: Mapped[int] = mapped_column(
        ForeignKey("computer_session.id", ondelete="CASCADE"), index=True
    )
    ordinal: Mapped[int] = mapped_column(Integer)
    kind: Mapped[str] = mapped_column(String(24))
    args: Mapped[dict | None] = mapped_column(JSONVariant)
    result: Mapped[str | None] = mapped_column(Text)
    # ok | failed | awaiting | approved | rejected | blocked
    status: Mapped[str] = mapped_column(String(16), default="ok")
    reason: Mapped[str | None] = mapped_column(Text)
    screenshot_key: Mapped[str | None] = mapped_column(String(512))
    duration_ms: Mapped[int | None] = mapped_column(Integer)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class JarvisProfile(Base):
    __tablename__ = "jarvis_profile"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default="local")
    user_name: Mapped[str] = mapped_column(String(120), default="")
    assistant_name: Mapped[str] = mapped_column(String(120), default="贾维斯")
    locale: Mapped[str] = mapped_column(String(32), default="zh-CN")
    voice: Mapped[str | None] = mapped_column(String(160))
    preferences: Mapped[dict] = mapped_column(JSONVariant, default=dict)
    persona_version: Mapped[int] = mapped_column(Integer, default=1)
    policy_version: Mapped[int] = mapped_column(Integer, default=1)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )


class JarvisConversation(Base):
    __tablename__ = "jarvis_conversation"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    status: Mapped[str] = mapped_column(String(24), default="active", index=True)
    title: Mapped[str | None] = mapped_column(String(200))
    summary: Mapped[str | None] = mapped_column(Text)
    event_seq: Mapped[int] = mapped_column(Integer, default=0)
    last_turn_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), index=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), index=True
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )


class JarvisTurn(Base):
    __tablename__ = "jarvis_turn"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    conversation_id: Mapped[str] = mapped_column(
        ForeignKey("jarvis_conversation.id", ondelete="CASCADE"), index=True
    )
    mission_id: Mapped[str | None] = mapped_column(
        ForeignKey("jarvis_mission.id", ondelete="SET NULL"), index=True
    )
    trace_id: Mapped[str] = mapped_column(String(36), unique=True, index=True)
    source: Mapped[str] = mapped_column(String(24), default="text", index=True)
    status: Mapped[str] = mapped_column(String(24), default="running", index=True)
    user_text: Mapped[str | None] = mapped_column(Text)
    assistant_text: Mapped[str | None] = mapped_column(Text)
    context_snapshot: Mapped[dict | None] = mapped_column(JSONVariant)
    started_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), index=True
    )


class JarvisMission(Base):
    __tablename__ = "jarvis_mission"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    conversation_id: Mapped[str] = mapped_column(
        ForeignKey("jarvis_conversation.id", ondelete="CASCADE"), index=True
    )
    origin_turn_id: Mapped[str | None] = mapped_column(String(36), index=True)
    mode: Mapped[str] = mapped_column(String(24), default="durable", index=True)
    status: Mapped[str] = mapped_column(String(24), default="queued", index=True)
    goal: Mapped[str] = mapped_column(Text)
    result_contract: Mapped[dict | None] = mapped_column(JSONVariant)
    checkpoint: Mapped[dict] = mapped_column(JSONVariant, default=dict)
    flow_run_id: Mapped[str | None] = mapped_column(String(36), index=True)
    actor_generation: Mapped[int] = mapped_column(Integer, default=1)
    lease_owner: Mapped[str | None] = mapped_column(String(120), index=True)
    lease_until: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), index=True)
    idempotency_key: Mapped[str] = mapped_column(String(120), unique=True)
    event_seq: Mapped[int] = mapped_column(Integer, default=0)
    result: Mapped[dict | None] = mapped_column(JSONVariant)
    error: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), index=True
    )
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )


class JarvisCommand(Base):
    __tablename__ = "jarvis_command"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    mission_id: Mapped[str] = mapped_column(
        ForeignKey("jarvis_mission.id", ondelete="CASCADE"), index=True
    )
    generation: Mapped[int] = mapped_column(Integer)
    kind: Mapped[str] = mapped_column(String(24), index=True)
    payload: Mapped[dict | None] = mapped_column(JSONVariant)
    idempotency_key: Mapped[str] = mapped_column(String(120), unique=True)
    status: Mapped[str] = mapped_column(String(24), default="pending", index=True)
    result: Mapped[dict | None] = mapped_column(JSONVariant)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), index=True
    )
    handled_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class JarvisEventRecord(Base):
    __tablename__ = "jarvis_event"

    global_cursor: Mapped[int] = mapped_column(BigIntegerPK, primary_key=True, autoincrement=True)
    aggregate_type: Mapped[str] = mapped_column(String(24), index=True)
    aggregate_id: Mapped[str] = mapped_column(String(36), index=True)
    seq: Mapped[int] = mapped_column(Integer)
    event_type: Mapped[str] = mapped_column(String(80), index=True)
    payload: Mapped[dict | None] = mapped_column(JSONVariant)
    trace_id: Mapped[str | None] = mapped_column(String(36), index=True)
    conversation_id: Mapped[str | None] = mapped_column(String(36), index=True)
    turn_id: Mapped[str | None] = mapped_column(String(36), index=True)
    mission_id: Mapped[str | None] = mapped_column(String(36), index=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), index=True
    )

    __table_args__ = (
        UniqueConstraint("aggregate_type", "aggregate_id", "seq", name="uq_jarvis_event_seq"),
    )


class JarvisMemory(Base):
    __tablename__ = "jarvis_memory"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    kind: Mapped[str] = mapped_column(String(24), index=True)
    status: Mapped[str] = mapped_column(String(24), default="proposed", index=True)
    content: Mapped[str] = mapped_column(Text)
    source_turn_id: Mapped[str | None] = mapped_column(String(36), index=True)
    scope: Mapped[dict | None] = mapped_column(JSONVariant)
    sensitivity: Mapped[str] = mapped_column(String(24), default="ordinary", index=True)
    confidence: Mapped[float] = mapped_column(Float, default=1.0)
    provenance: Mapped[dict | None] = mapped_column(JSONVariant)
    supersedes_id: Mapped[str | None] = mapped_column(String(36), index=True)
    expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), index=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), index=True
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )


class JarvisAnnouncement(Base):
    __tablename__ = "jarvis_announcement"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    source: Mapped[str] = mapped_column(String(48), index=True)
    key: Mapped[str] = mapped_column(String(96), index=True)
    title: Mapped[str] = mapped_column(String(200))
    text: Mapped[str] = mapped_column(Text)
    status: Mapped[str] = mapped_column(String(24), default="pending", index=True)
    reason: Mapped[str | None] = mapped_column(String(120))
    attempts: Mapped[int] = mapped_column(Integer, default=0)
    available_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), index=True)
    delivered_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), index=True
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )


class ExtensionState(Base):
    """扩展的本地状态（模块 22）：manifest 来自磁盘或内置清单，这里只记人改过的东西。"""

    __tablename__ = "extension_state"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    granted: Mapped[list | None] = mapped_column(JSONVariant)  # 已授予的权限键
    settings: Mapped[dict | None] = mapped_column(JSONVariant)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )


class Routine(Base):
    """例程（模块 22）：定时跑一件事，产出进 routine_run。内置的早报与扩展声明的都在这一张表。"""

    __tablename__ = "routine"

    id: Mapped[int] = mapped_column(primary_key=True)
    key: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    label: Mapped[str] = mapped_column(String(64))
    kind: Mapped[str] = mapped_column(String(16), default="prompt")  # brief | prompt
    schedule: Mapped[str] = mapped_column(String(64))  # HH:MM 或五段 cron
    prompt: Mapped[str | None] = mapped_column(Text)
    detail: Mapped[str | None] = mapped_column(String(200))
    speak: Mapped[bool] = mapped_column(Boolean, default=True)
    enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    source: Mapped[str] = mapped_column(String(64), default="builtin")  # builtin | ext:<id>
    last_run_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    last_status: Mapped[str | None] = mapped_column(String(16))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class ModelDeployment(Base):
    """一个供应商凭据下可实际调用的上游模型（模块 17 BR-171~173）。

    `upstream_model_id` 永远保存上游真实名称；业务能力名住 CapabilityBinding，
    两者不混在一个字段里。相同模型可由多个供应商提供，
    所以内部用 deployment id 区分，界面显示「真实模型名 · 供应商」。

    adapter_type/protocol_options 描述怎么调用，不塞进凭据 config：同一个供应商
    可能同时有 OpenAI 图片、异步视频和供应商专属编辑模型。
    """

    __tablename__ = "model_deployment"

    id: Mapped[int] = mapped_column(primary_key=True)
    credential_id: Mapped[int] = mapped_column(
        ForeignKey("provider_credential.id", ondelete="CASCADE"), index=True
    )
    upstream_model_id: Mapped[str] = mapped_column(String(255))
    display_name: Mapped[str | None] = mapped_column(String(160))
    adapter_type: Mapped[str] = mapped_column(String(32), default="openai")
    media_types: Mapped[list] = mapped_column(JSONVariant, default=list)
    protocol_options: Mapped[dict | None] = mapped_column(JSONVariant)
    discovered: Mapped[bool] = mapped_column(Boolean, default=False)
    enabled: Mapped[bool] = mapped_column(Boolean, default=True, index=True)
    sort: Mapped[int] = mapped_column(Integer, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )

    __table_args__ = (
        UniqueConstraint(
            "credential_id",
            "upstream_model_id",
            "adapter_type",
            name="uq_model_deployment_target",
        ),
    )


class ModelScopeLora(Base):
    """ModelScope 出图可复用的 LoRA 预设目录。

    LoRA 属于某套 ModelScope 凭据，并且要声明目标模型；这样同一
    LoRA id 可以在不同账号或模型下有独立默认强度。密钥仍只存在
    ``ProviderCredential``，这张表不接受任何 Secret。
    """

    __tablename__ = "modelscope_lora"

    id: Mapped[int] = mapped_column(primary_key=True)
    credential_id: Mapped[int] = mapped_column(
        ForeignKey("provider_credential.id", ondelete="CASCADE"), index=True
    )
    lora_id: Mapped[str] = mapped_column(String(255))
    display_name: Mapped[str | None] = mapped_column(String(160))
    target_model: Mapped[str] = mapped_column(String(255), index=True)
    default_strength: Mapped[float] = mapped_column(Float, default=0.8)
    enabled: Mapped[bool] = mapped_column(Boolean, default=True, index=True)
    note: Mapped[str | None] = mapped_column(String(300))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )

    __table_args__ = (
        UniqueConstraint(
            "credential_id",
            "target_model",
            "lora_id",
            name="uq_modelscope_lora_target",
        ),
    )


class StudioWorkflow(Base):
    """可执行工作流目录（模块 17 ST-15）。

    与 `StudioTemplate` 的画布子图模板不同，这里保存 ComfyUI 节点图或
    RunningHub 工作流 id 及其可编辑字段。凭据仍只存 `ProviderCredential`，
    payload / ui_schema 不允许夹带密钥。
    """

    __tablename__ = "studio_workflow"

    id: Mapped[int] = mapped_column(primary_key=True)
    key: Mapped[str] = mapped_column(String(160), unique=True)
    title: Mapped[str] = mapped_column(String(160))
    provider: Mapped[str] = mapped_column(String(32), index=True)
    kind: Mapped[str] = mapped_column(String(32), default="image", index=True)
    source: Mapped[str] = mapped_column(String(24), default="user", index=True)
    source_id: Mapped[str | None] = mapped_column(String(255))
    payload: Mapped[dict] = mapped_column(JSONVariant, default=dict)
    ui_schema: Mapped[dict | None] = mapped_column(JSONVariant)
    thumbnail_key: Mapped[str | None] = mapped_column(String(512))
    content_hash: Mapped[str] = mapped_column(String(64))
    # 单调递增的版本号，与 studio_revision 里的快照一一对应。回滚也是往前推一版，
    # 不倒着减——版本号倒退会让导出物与历史记录指到两份不同的内容
    version: Mapped[int] = mapped_column(Integer, default=1)
    enabled: Mapped[bool] = mapped_column(Boolean, default=True, index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )


class StudioFlow(Base):
    """按工具能力编排的持久化 DAG 定义。

    `definition` 只存已校验的 nodes/edges；每次修改递增 `version`。
    运行记录会复制定义快照，所以运行中编辑不会改变历史语义。
    """

    __tablename__ = "studio_flow"

    id: Mapped[int] = mapped_column(primary_key=True)
    title: Mapped[str] = mapped_column(String(160))
    description: Mapped[str | None] = mapped_column(Text)
    definition: Mapped[dict] = mapped_column(JSONVariant, default=dict)
    # 运行入参的 JSON Schema：由 input 节点派生，也可直接给。为空表示不校验入参
    input_schema: Mapped[dict | None] = mapped_column(JSONVariant)
    version: Mapped[int] = mapped_column(Integer, default=1)
    enabled: Mapped[bool] = mapped_column(Boolean, default=True, index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )


class StudioFlowRun(Base):
    """DAG 一次运行的定义快照与节点级 checkpoint。"""

    __tablename__ = "studio_flow_run"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    flow_id: Mapped[int | None] = mapped_column(
        ForeignKey("studio_flow.id", ondelete="SET NULL"), index=True
    )
    parent_run_id: Mapped[str | None] = mapped_column(
        ForeignKey("studio_flow_run.id", ondelete="SET NULL"), index=True
    )
    mission_id: Mapped[str | None] = mapped_column(
        ForeignKey("jarvis_mission.id", ondelete="SET NULL"), index=True
    )
    flow_version: Mapped[int] = mapped_column(Integer)
    definition_snapshot: Mapped[dict] = mapped_column(JSONVariant)
    inputs: Mapped[dict] = mapped_column(JSONVariant, default=dict)
    source_context: Mapped[dict | None] = mapped_column(JSONVariant)
    checkpoint: Mapped[dict] = mapped_column(JSONVariant, default=dict)
    # output 节点求值的结果；子工作流把它交回父节点
    outputs: Mapped[dict | None] = mapped_column(JSONVariant)
    # 停在人工输入时挂起的节点；恢复后清空
    waiting_node_id: Mapped[str | None] = mapped_column(String(96))
    status: Mapped[str] = mapped_column(String(24), default="queued", index=True)
    error: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), index=True
    )
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    heartbeat_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )


class StudioFlowInterrupt(Base):
    """DAG 的人工输入挂起点，语义取自 :class:`PipelineInterrupt`。

    两条硬约束照搬旧管线：挂起点之前的节点逻辑必须幂等（恢复时整个节点重跑），
    worker 绝不挂起等人——当前 tick 正常结束，恢复时入队新 tick。
    """

    __tablename__ = "studio_flow_interrupt"

    id: Mapped[int] = mapped_column(primary_key=True)
    run_id: Mapped[str] = mapped_column(
        ForeignKey("studio_flow_run.id", ondelete="CASCADE"), index=True
    )
    node_id: Mapped[str] = mapped_column(String(96))
    kind: Mapped[str] = mapped_column(String(16), default="input")  # input|approve|choose
    payload: Mapped[dict | None] = mapped_column(JSONVariant)  # 给人看的内容
    resume_value: Mapped[dict | None] = mapped_column(JSONVariant)
    status: Mapped[str] = mapped_column(String(12), default="waiting")  # waiting|resolved|expired
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    resolved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    __table_args__ = (Index("ix_studio_flow_interrupt_run", "run_id", "status"),)


class StudioFlowTrigger(Base):
    """工作流的自动触发规则：cron 定时，或某类任务到终态。"""

    __tablename__ = "studio_flow_trigger"

    id: Mapped[int] = mapped_column(primary_key=True)
    flow_id: Mapped[int] = mapped_column(
        ForeignKey("studio_flow.id", ondelete="CASCADE"), index=True
    )
    kind: Mapped[str] = mapped_column(String(24), index=True)  # cron|task_terminal
    cron: Mapped[str | None] = mapped_column(String(120))
    task_type: Mapped[str | None] = mapped_column(String(64), index=True)
    statuses: Mapped[list | None] = mapped_column(JSONVariant)
    inputs: Mapped[dict | None] = mapped_column(JSONVariant)
    enabled: Mapped[bool] = mapped_column(Boolean, default=True, index=True)
    last_fired_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )


class CapabilityBinding(Base):
    """能力/场景 → 凭据 + 模型或音色，配 fallback 有序降级链（模块 11）。"""

    __tablename__ = "capability_binding"

    id: Mapped[int] = mapped_column(primary_key=True)
    capability: Mapped[str] = mapped_column(String(32), unique=True)
    credential_id: Mapped[int | None] = mapped_column(
        ForeignKey("provider_credential.id", ondelete="SET NULL")
    )
    # v2 首选关系；旧 credential_id + target 在迁移期继续双写，保证现有调用兼容。
    deployment_id: Mapped[int | None] = mapped_column(
        ForeignKey("model_deployment.id", ondelete="SET NULL"), index=True
    )
    target: Mapped[str | None] = mapped_column(String(128))  # 模型名或音色 id
    params: Mapped[dict | None] = mapped_column(JSONVariant)  # 语速/reasoning_effort/chain 等
    fallback: Mapped[list | None] = mapped_column(JSONVariant)  # [{credential_id, target}]
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )


class ConfigAudit(Base):
    """配置变更审计行：改了什么 + 摘要（BR-04，设置页展示最近 20 条）。"""

    __tablename__ = "config_audit"

    id: Mapped[int] = mapped_column(primary_key=True)
    action: Mapped[str] = mapped_column(String(32))  # credential.create | binding.update | ...
    summary: Mapped[str] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class WorkspaceSnapshot(Base):
    __tablename__ = "workspace_snapshot"

    user_id: Mapped[str] = mapped_column(String(36), primary_key=True)
    module: Mapped[str] = mapped_column(String(24), primary_key=True)
    key: Mapped[str] = mapped_column(String(2048), primary_key=True)
    version: Mapped[int] = mapped_column(Integer, default=1)
    value: Mapped[dict] = mapped_column(JSONVariant, default=dict)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), index=True,
    )


class UserPref(Base):
    """整包 KV。两类东西住在这儿：

    - 阅读与外观偏好：前端启动拉取，变更即保存（FR-11）
    - **本部署实测出来的环境事实**，如尺寸档位标定结果（`image_size_calibration`）。
      这类值不是源码（换个供应商就不一样），也不能只放内存——API 与 worker 是两个
      进程，重启一次二十几次真实调用换来的测量就没了。
    """

    __tablename__ = "user_pref"

    key: Mapped[str] = mapped_column(String(64), primary_key=True)
    value: Mapped[dict] = mapped_column(JSONVariant)


class ShadowRecording(Base):
    """跟读录音与其分析结果（FR-340~344）。

    BR-12 原文即「用户明确保存才落库」——本表是把预留的那半边补上：
    只录不动作的不落库，点了「逐词比对 / AI 点评 / 保存」才存（这三件事本来就要上传音频）。

    音频文件落 media_root/recordings/{video_id}/，本表只存相对路径：
    删音频不删比对与点评，清理策略只作用于媒体（BR-74、BR-G-009）。
    """

    __tablename__ = "shadow_recording"

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[str | None] = mapped_column(String(36), index=True)
    video_id: Mapped[int] = mapped_column(ForeignKey("video.id", ondelete="CASCADE"))
    # 跟读以右栏所见的语法句为单位（BR-72）
    sentence_id: Mapped[int] = mapped_column(ForeignKey("subtitle_sentence.id", ondelete="CASCADE"))
    # 发起录音的学习句：比对接口按学习句寻址，回放时用来定位
    unit_id: Mapped[int | None] = mapped_column(
        ForeignKey("study_unit.id", ondelete="SET NULL"), nullable=True
    )
    audio_key: Mapped[str] = mapped_column(String(255))
    mime: Mapped[str] = mapped_column(String(64))
    duration_ms: Mapped[int | None] = mapped_column(Integer)
    # 比对产物：转写、准确率、逐词 diff
    transcript: Mapped[str | None] = mapped_column(Text)
    accuracy: Mapped[int | None] = mapped_column(Integer)
    diff: Mapped[dict | None] = mapped_column(JSONVariant)
    # AI 点评产物：全文与 0-100 评分，落库后重开弹窗不再调用（FR-344）
    review: Mapped[str | None] = mapped_column(Text)
    score: Mapped[int | None] = mapped_column(Integer)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    __table_args__ = (
        Index("ix_shadow_recording_sentence", "sentence_id", "created_at"),
        Index("ix_shadow_recording_video", "video_id"),
    )


# ──────────────────────────── 音标与发音训练（模块 13） ────────────────────────────


class WordPhoneme(Base):
    """词的音素数据主档（FR-390）。

    不修 ECDICT 的 `phonetic`：那列 35.3 万条 IPA/DJ 混排、28% 含西里尔字符，
    清洗性价比为负。新建这张表走单一记法，ECDICT 降级为兜底展示。

    `source` 区分词典事实与算法推测（BR-93，与 BR-04 的来源三分同口径）。
    """

    __tablename__ = "word_phoneme"

    word: Mapped[str] = mapped_column(String(128), primary_key=True)
    ipa_us: Mapped[str | None] = mapped_column(String(256))  # ipa-dict en_US
    ipa_uk: Mapped[str | None] = mapped_column(String(256))  # ipa-dict en_UK
    arpabet: Mapped[str | None] = mapped_column(String(256))  # CMUdict，带重音数字
    syllables: Mapped[int | None] = mapped_column(Integer)  # 由 ARPAbet 元音个数得出
    stress: Mapped[str | None] = mapped_column(String(32))  # 重音型，如 "102"
    # ipa-dict | cmudict | g2p —— 前两者是词典事实，g2p 是算法推测
    source: Mapped[str] = mapped_column(String(16), default="ipa-dict")

    __table_args__ = (Index("ix_word_phoneme_source", "source"),)


class Phoneme(Base):
    """44 个英语音位的教学卡片（FR-392）。"""

    __tablename__ = "phoneme"

    # 教学用 IPA（RP 记法），如 iː
    symbol: Mapped[str] = mapped_column(String(16), primary_key=True)
    # 美音变体：ipa-dict en_US 与 CMUdict 走 GA 记法，同一音位符号不同（ɒ→ɑ、əʊ→oʊ）
    symbol_us: Mapped[str | None] = mapped_column(String(16))
    arpabet: Mapped[str] = mapped_column(String(8))  # 对应 CMUdict 音素，如 IY
    kind: Mapped[str] = mapped_column(String(16))  # vowel | consonant
    # 元音：monophthong|diphthong；辅音：plosive|fricative|affricate|nasal|approximant|lateral
    manner: Mapped[str] = mapped_column(String(32))
    # 辅音发音部位；元音此列存舌位描述（如 "前高"）
    place: Mapped[str] = mapped_column(String(32))
    voiced: Mapped[bool] = mapped_column(Boolean, default=True)
    zh_name: Mapped[str] = mapped_column(String(64))  # 中文称呼，如「长音 i」
    # 例词按音素在词中的位置分组（FR-392g）：{"initial": [...], "medial": [...], "final": [...]}
    examples: Mapped[dict] = mapped_column(JSONVariant, default=dict)
    common_errors: Mapped[list] = mapped_column(JSONVariant, default=list)  # 中国学习者常见错读
    tips: Mapped[str | None] = mapped_column(Text)  # 发音要领
    # 中矢面剖面图帧序列（FR-392c）：[{key, label}]。
    # 塞擦音/复合音位配 2 帧做离散切换——Höffler & Leutner 的 d=0.37 来自表征性动画，
    # 不是补间平滑度，两张图切换就吃到了这个效应（§9 明确不做 path morph）。
    svg_frames: Mapped[list] = mapped_column(JSONVariant, default=list)
    # 元音四边形定位（FR-392d）：x=前后（0 前 1 后），y=开口度（0 闭 1 开）
    chart_x: Mapped[float | None] = mapped_column(Float)
    chart_y: Mapped[float | None] = mapped_column(Float)
    # 双元音滑动终点，单元音为空
    chart_to_x: Mapped[float | None] = mapped_column(Float)
    chart_to_y: Mapped[float | None] = mapped_column(Float)
    # 关键发音部位高亮（FR-392f）：["tongue-tip", "velum"] 等
    highlight: Mapped[list] = mapped_column(JSONVariant, default=list)
    # 易混音位，直通对应的最小对立对训练（如 iː 指向 ["ɪ"]）
    contrast_with: Mapped[list] = mapped_column(JSONVariant, default=list)
    order_index: Mapped[int] = mapped_column(Integer, default=0)


class PhonemeDifficulty(Base):
    """音素难度统计（FR-391）：speechocean762 的说话人全是普通话母语者，与用户画像对口。"""

    __tablename__ = "phoneme_difficulty"

    symbol: Mapped[str] = mapped_column(String(16), primary_key=True)  # ARPAbet 去重音
    low_score_rate: Mapped[float] = mapped_column(Float)  # 专家标注 < 2 的占比
    mean_score: Mapped[float] = mapped_column(Float)  # 0-2 均分
    sample_n: Mapped[int] = mapped_column(Integer)
    source: Mapped[str] = mapped_column(String(32), default="speechocean762")


class MinimalPair(Base):
    """最小对立对（FR-393c）：音素编辑距离 = 1 的高频词对。"""

    __tablename__ = "minimal_pair"

    id: Mapped[int] = mapped_column(primary_key=True)
    contrast_group: Mapped[str] = mapped_column(String(32), index=True)  # 如 "θ/s"
    word_a: Mapped[str] = mapped_column(String(64))
    word_b: Mapped[str] = mapped_column(String(64))
    ipa_a: Mapped[str] = mapped_column(String(128))
    ipa_b: Mapped[str] = mapped_column(String(128))
    phone_a: Mapped[str] = mapped_column(String(8))  # 差异位的 ARPAbet
    phone_b: Mapped[str] = mapped_column(String(8))
    diff_index: Mapped[int] = mapped_column(Integer)  # 音素序列中差异位下标
    freq_rank: Mapped[int] = mapped_column(Integer)  # 两词 COCA 词频较大者，越小越常用

    __table_args__ = (
        UniqueConstraint("word_a", "word_b", "diff_index", name="uq_minimal_pair"),
        Index("ix_minimal_pair_group_freq", "contrast_group", "freq_rank"),
    )


class PhonemeCardState(Base):
    """音位/对比组的 FSRS 卡（FR-393f、BR-94）。

    与 vocab 的卡表分开：调度逻辑复用 `domain/srs.py`，一行不改。
    只调度可自动判定的题——跟读打分走模块 09，不塞进 SRS。
    """

    __tablename__ = "phoneme_card_state"

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[str | None] = mapped_column(String(36), index=True)
    # contrast（最小对立对听辨）| decode（看音标选词）| encode（看词选音标）
    kind: Mapped[str] = mapped_column(String(16))
    card_key: Mapped[str] = mapped_column(String(64))  # 对比组名或音位符号
    fsrs_card: Mapped[dict | None] = mapped_column(JSONVariant)
    due_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), index=True)
    last_review_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    reps: Mapped[int] = mapped_column(Integer, default=0)
    lapses: Mapped[int] = mapped_column(Integer, default=0)
    # HVPT 结业进度（FR-394）：累计有效训练秒数，400 分钟为收益趋平线
    trained_seconds: Mapped[int] = mapped_column(Integer, default=0)

    __table_args__ = (UniqueConstraint("user_id", "kind", "card_key", name="uq_phoneme_card_user"),)


class PronunciationAssessment(Base):
    """跟读录音的结构化发音诊断（FR-398）。

    音素层（第 1/2 层）已于 2026-08-30 随本地音素模型下线（ADR-012），
    `phonemes` / `layer` / `source` 三列一并删除——留着永远不写的列，
    下一个读表的人会以为那一层还在、只是这次没数据。
    """

    __tablename__ = "pronunciation_assessment"

    id: Mapped[int] = mapped_column(primary_key=True)
    recording_id: Mapped[int] = mapped_column(
        ForeignKey("shadow_recording.id", ondelete="CASCADE"), unique=True
    )
    completeness: Mapped[float | None] = mapped_column(Float)  # 0-100，漏读/多读
    fluency: Mapped[float | None] = mapped_column(Float)  # 0-100，停顿分布
    accuracy: Mapped[float | None] = mapped_column(Float)  # 0-100，词级 CTC 置信度均值
    # 词级明细：[{word, score, start, end, norm_score, flag}]
    words: Mapped[list] = mapped_column(JSONVariant, default=list)
    # 停顿事件：[{kind: UnexpectedBreak|MissingBreak, index, ms}]
    breaks: Mapped[list] = mapped_column(JSONVariant, default=list)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class PhonemeAttempt(Base):
    """听辨/认读题的作答流水，供薄弱音位雷达图与结业进度统计。"""

    __tablename__ = "phoneme_attempt"

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[str | None] = mapped_column(String(36), index=True)
    kind: Mapped[str] = mapped_column(String(16))  # contrast | decode | encode
    card_key: Mapped[str] = mapped_column(String(64), index=True)
    question_id: Mapped[str] = mapped_column(String(128))
    correct: Mapped[bool] = mapped_column(Boolean)
    elapsed_ms: Mapped[int | None] = mapped_column(Integer)
    detail: Mapped[dict | None] = mapped_column(JSONVariant)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), index=True
    )


# ──────────────────────────── 语法学习与写作纠错（模块 14） ────────────────────────────


class GrammarPoint(Base):
    """CEFR-J Grammar Profile 的语法点主表（FR-400）。"""

    __tablename__ = "grammar_point"

    id: Mapped[int] = mapped_column(primary_key=True)
    ext_id: Mapped[str] = mapped_column(String(16), unique=True)  # CEFR-J 原始 ID，如 "1-2"
    shorthand_code: Mapped[str] = mapped_column(String(64), index=True)  # 如 PP.am_I
    item: Mapped[str] = mapped_column(String(256))  # 英文条目名
    item_ja: Mapped[str | None] = mapped_column(String(256))  # 日文原名，翻译来源
    item_zh: Mapped[str | None] = mapped_column(String(256))  # 中文名，LLM 批量翻译
    sentence_type: Mapped[str | None] = mapped_column(String(32))  # AFF. DEC. 等
    cefr_level: Mapped[str | None] = mapped_column(String(8), index=True)  # A1 ~ C1
    # A1.1 ~ B2.2（教员版）。有的条目给的是区间 `A1.1-A1.2`，所以不是 8 字符能装下的
    cefrj_level: Mapped[str | None] = mapped_column(String(16))
    note_zh: Mapped[str | None] = mapped_column(Text)  # 备考栏中文
    category: Mapped[str] = mapped_column(String(32), index=True)  # 语法范畴分组
    order_index: Mapped[int] = mapped_column(Integer, default=0)
    # 讲解正文（一屏制，FR-400d），LLM 生成后落库，二次访问零调用
    explanation: Mapped[str | None] = mapped_column(Text)
    examples: Mapped[list] = mapped_column(JSONVariant, default=list)  # [{en, zh}]
    # CEFR-J 原始正则（TreeTagger 版），保留作构式规则的对照来源
    pattern_regex: Mapped[str | None] = mapped_column(Text)

    __table_args__ = (Index("ix_grammar_point_cat_order", "category", "order_index"),)


class GrammarConstruction(Base):
    """构式识别规则（FR-401a）：spaCy DependencyMatcher 模式，30-50 条高频。"""

    __tablename__ = "grammar_construction"

    id: Mapped[int] = mapped_column(primary_key=True)
    key: Mapped[str] = mapped_column(String(64), unique=True)
    grammar_point_id: Mapped[int | None] = mapped_column(
        ForeignKey("grammar_point.id", ondelete="SET NULL"), index=True
    )
    description: Mapped[str] = mapped_column(String(256))
    pattern: Mapped[list] = mapped_column(JSONVariant)  # DependencyMatcher 模式
    enabled: Mapped[bool] = mapped_column(Boolean, default=True)


class GrammarOccurrence(Base):
    """语法点在自有语料里的真实出现（FR-401b）：书库/字幕/场景短文。"""

    __tablename__ = "grammar_occurrence"

    id: Mapped[int] = mapped_column(primary_key=True)
    grammar_point_id: Mapped[int] = mapped_column(
        ForeignKey("grammar_point.id", ondelete="CASCADE"), index=True
    )
    construction_key: Mapped[str] = mapped_column(String(64))
    source_kind: Mapped[str] = mapped_column(String(16))  # article | subtitle
    source_id: Mapped[int] = mapped_column(Integer)  # article_id / video_id
    paragraph_id: Mapped[int | None] = mapped_column(Integer)
    sentence_id: Mapped[int | None] = mapped_column(Integer)
    char_start: Mapped[int] = mapped_column(Integer)  # UTF-16 码元
    char_end: Mapped[int] = mapped_column(Integer)
    snippet: Mapped[str] = mapped_column(Text)

    __table_args__ = (
        Index("ix_grammar_occ_point_src", "grammar_point_id", "source_kind", "source_id"),
    )


class Misconception(Base):
    """可命名的具体误区（FR-402，抄 Oppia 的领域模型）。

    「答错」不是「不等于正确答案」，而是命中某个有名字的误区——
    误区有限、可枚举、可统计，能回答「这个错犯过几次」和「该补哪一课」。
    """

    __tablename__ = "misconception"

    id: Mapped[int] = mapped_column(primary_key=True)
    code: Mapped[str] = mapped_column(String(64), unique=True)
    name: Mapped[str] = mapped_column(String(128))
    description: Mapped[str] = mapped_column(Text)
    feedback: Mapped[str] = mapped_column(Text)  # 定向反馈文案
    errant_types: Mapped[list] = mapped_column(JSONVariant, default=list)  # 双向映射（FR-402c）
    remedial_point_id: Mapped[int | None] = mapped_column(
        ForeignKey("grammar_point.id", ondelete="SET NULL")
    )
    hit_count: Mapped[int] = mapped_column(Integer, default=0)  # 累计命中，驱动 FR-402d 排序


class GrammarCard(Base):
    """一题一卡（FR-406a）：一个语法点挂 N 张卡。"""

    __tablename__ = "grammar_card"

    id: Mapped[int] = mapped_column(primary_key=True)
    grammar_point_id: Mapped[int] = mapped_column(
        ForeignKey("grammar_point.id", ondelete="CASCADE"), index=True
    )
    # referential | affective | locate | production
    kind: Mapped[str] = mapped_column(String(16), index=True)
    widget: Mapped[str] = mapped_column(String(32))  # 练习引擎的 widget 名
    payload: Mapped[dict] = mapped_column(JSONVariant)  # 题目 JSON（含 misconceptions）
    # affective 与 production 不进 SRS（FR-406b）
    schedulable: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class GrammarPractice(Base):
    __tablename__ = "grammar_practice"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    user_id: Mapped[str] = mapped_column(String(36), index=True)
    mode: Mapped[str] = mapped_column(String(16))
    status: Mapped[str] = mapped_column(String(16), default="active")
    questions: Mapped[list] = mapped_column(JSONVariant, default=list)
    answers: Mapped[dict] = mapped_column(JSONVariant, default=dict)
    cursor: Mapped[int] = mapped_column(Integer, default=0)
    version: Mapped[int] = mapped_column(Integer, default=0)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )


class GrammarCardState(Base):
    """语法卡 FSRS 状态（FR-406d）：StudyUnitState 绑字幕表不能复用，新建。"""

    __tablename__ = "grammar_card_state"

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[str | None] = mapped_column(String(36), index=True)
    card_id: Mapped[int] = mapped_column(ForeignKey("grammar_card.id", ondelete="CASCADE"))
    fsrs_card: Mapped[dict | None] = mapped_column(JSONVariant)
    due_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), index=True)
    last_review_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    reps: Mapped[int] = mapped_column(Integer, default=0)
    lapses: Mapped[int] = mapped_column(Integer, default=0)

    __table_args__ = (
        UniqueConstraint("user_id", "card_id", name="uq_grammar_card_state_user_card"),
    )


class GrammarConcept(Base):
    """语法讲义切出来的一个概念（FR-407）。

    正文是**原样导入的 Markdown**，平台不编辑（BR-93/BR-94）：行文是用户自己的，
    AI 改写会引入 AI 腔且不可逆。要改内容回 Obsidian 改，重新导入。

    `slug` 由 `源文件路径 + 标题路径` 生成且稳定——重导按它 upsert，
    用户的掌握度与复习进度不能被重置（`misconception` 用 TRUNCATE 重灌
    把错题本清空过一次，同一个坑不踩第二遍）。
    """

    __tablename__ = "grammar_concept"

    id: Mapped[int] = mapped_column(primary_key=True)
    slug: Mapped[str] = mapped_column(String(200), unique=True)
    source_path: Mapped[str] = mapped_column(String(400), index=True)
    chapter: Mapped[str] = mapped_column(String(64), index=True)  # 一级分类，如 09.从句体系
    doc_title: Mapped[str] = mapped_column(String(200))
    title: Mapped[str] = mapped_column(String(200))
    heading_path: Mapped[list] = mapped_column(JSONVariant, default=list)
    body_md: Mapped[str] = mapped_column(Text)
    # 内容指纹：重导时没变的概念跳过写库，也用来发现 Obsidian 侧改了什么
    content_hash: Mapped[str] = mapped_column(String(64), index=True)
    order_index: Mapped[int] = mapped_column(Integer, default=0)
    # active=主动层（必须练到会用，进复习队列）/ reference=参考层（查得到即可）
    layer: Mapped[str] = mapped_column(String(16), default="reference", index=True)
    # BR-95：主动层的判据是「不会它会读错什么句子」，理由必须写下来才可复核
    why_active: Mapped[str | None] = mapped_column(Text)
    construction_keys: Mapped[list] = mapped_column(JSONVariant, default=list)
    grammar_point_ids: Mapped[list] = mapped_column(JSONVariant, default=list)
    # notes=从讲义导入 / platform=补缺口时平台新写，界面上要能区分（BR-94）
    authored_by: Mapped[str] = mapped_column(String(16), default="notes")
    # 讲义里删掉的概念标 archived 而不是物理删，保留历史引用
    status: Mapped[str] = mapped_column(String(16), default="active", index=True)

    __table_args__ = (Index("ix_grammar_concept_ch_order", "chapter", "order_index"),)


class GrammarConceptState(Base):
    """概念掌握度（FR-407e）。调度复用 `domain/srs.py`，不为语法另写一套（BR-96）。"""

    __tablename__ = "grammar_concept_state"

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[str | None] = mapped_column(String(36), index=True)
    concept_id: Mapped[int] = mapped_column(ForeignKey("grammar_concept.id", ondelete="CASCADE"))
    fsrs_card: Mapped[dict | None] = mapped_column(JSONVariant)
    due_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), index=True)
    last_review_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    reps: Mapped[int] = mapped_column(Integer, default=0)
    lapses: Mapped[int] = mapped_column(Integer, default=0)
    # 用户自己标的「我会了」，与 FSRS 到期是两件事
    marked_known_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    __table_args__ = (
        UniqueConstraint("user_id", "concept_id", name="uq_grammar_concept_state_user_concept"),
    )


class GrammarDocAnnotation(Base):
    """讲义正文的划词批注（模块 15 讲义库）。

    锚点不能只存字符偏移：讲义是磁盘上的 .md，用户随时会让 AI 改写正文再写回
    （`/grammar/docs/apply`），正文一变所有偏移集体错位，而错位后的高亮盖在
    别的句子上比不显示更糟。这里存**选区文本连同它前后各 32 字符**，读取时拿
    当前正文重新定位（`grammar_docs.relocate`），偏移只作提示：`prefix+quote+
    suffix` 匹配不上就退到只匹配 quote，`start_hint` 用来在同一句出现多次时择一。

    `ai_kind`/`ai_result` 是分析结果缓存（ADR-006 的同一口径：AI 产物落库，
    二次访问零调用）。一条批注同时只留最近一次分析——换 kind 即换内容，
    历史结果对阅读没有价值，多留一份只会让「这条到底显示哪一份」变复杂。
    """

    __tablename__ = "grammar_doc_annotation"

    id: Mapped[int] = mapped_column(primary_key=True)
    # vault 内相对路径，与 grammar_concept.source_path 同口径
    doc_path: Mapped[str] = mapped_column(String(400), index=True)
    quote: Mapped[str] = mapped_column(Text)
    prefix: Mapped[str] = mapped_column(Text, default="")
    suffix: Mapped[str] = mapped_column(Text, default="")
    start_hint: Mapped[int] = mapped_column(Integer, default=0)
    note: Mapped[str | None] = mapped_column(Text)
    color: Mapped[str] = mapped_column(String(16), default="yellow")
    ai_kind: Mapped[str | None] = mapped_column(String(16))
    ai_result: Mapped[dict | None] = mapped_column(JSONVariant)  # {text, model, at}
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )


class WritingAttempt(Base):
    """写作纠错的一次提交（FR-403）。"""

    __tablename__ = "writing_attempt"

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[str | None] = mapped_column(String(36), index=True)
    original: Mapped[str] = mapped_column(Text)
    corrected: Mapped[str | None] = mapped_column(Text)
    # 触发来源：free（自由写作）| card（产出型题目回批）
    origin: Mapped[str] = mapped_column(String(16), default="free")
    card_id: Mapped[int | None] = mapped_column(ForeignKey("grammar_card.id", ondelete="SET NULL"))
    status: Mapped[str] = mapped_column(String(16), default="pending")  # pending|ready|failed
    error: Mapped[str | None] = mapped_column(Text)
    # 整体点评（不替代逐条讲解，只做一句话总结）
    summary: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), index=True
    )


class WritingEdit(Base):
    """ERRANT 原子编辑 + 逐条讲解（BR-97：禁止整句一次过）。"""

    __tablename__ = "writing_edit"

    id: Mapped[int] = mapped_column(primary_key=True)
    attempt_id: Mapped[int] = mapped_column(
        ForeignKey("writing_attempt.id", ondelete="CASCADE"), index=True
    )
    errant_type: Mapped[str] = mapped_column(String(32), index=True)  # 如 R:VERB:TENSE
    o_start: Mapped[int] = mapped_column(Integer)  # 词序号（ERRANT 口径）
    o_end: Mapped[int] = mapped_column(Integer)
    char_start: Mapped[int | None] = mapped_column(Integer)  # 原句 UTF-16 偏移
    char_end: Mapped[int | None] = mapped_column(Integer)
    o_str: Mapped[str] = mapped_column(Text)
    c_str: Mapped[str] = mapped_column(Text)
    explanation: Mapped[str | None] = mapped_column(Text)
    misconception_id: Mapped[int | None] = mapped_column(
        ForeignKey("misconception.id", ondelete="SET NULL")
    )
    grammar_point_id: Mapped[int | None] = mapped_column(
        ForeignKey("grammar_point.id", ondelete="SET NULL")
    )
    ordinal: Mapped[int] = mapped_column(Integer, default=0)


class ExerciseAttempt(Base):
    """练习引擎的统一作答流水：语法卡与音标题共用，用于错题本与统计。"""

    __tablename__ = "exercise_attempt"

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[str | None] = mapped_column(String(36), index=True)
    card_id: Mapped[int | None] = mapped_column(ForeignKey("grammar_card.id", ondelete="CASCADE"))
    widget: Mapped[str] = mapped_column(String(32))
    correct: Mapped[bool] = mapped_column(Boolean)
    response: Mapped[dict | None] = mapped_column(JSONVariant)
    misconception_id: Mapped[int | None] = mapped_column(
        ForeignKey("misconception.id", ondelete="SET NULL")
    )
    feedback: Mapped[str | None] = mapped_column(Text)
    elapsed_ms: Mapped[int | None] = mapped_column(Integer)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), index=True
    )


class ImageAsset(Base):
    """AI 生成的图片资产（模块 16 FR-411）。

    一行一张图。图片字节落 storage（`storage_key`），库里只存 key 与元数据——
    `step_artifact.payload` 是 JSONB 且前端调试块按 6000 字符截断，base64 塞进去
    会同时撑爆库行与调试视图（BR-101）。

    `prompt` 与 `prompt_structure` 必须留存：不可回溯的图既无法复现也无法改进
    （BR-102）。`sha256` 唯一，同内容不重复落盘。
    """

    __tablename__ = "image_asset"

    id: Mapped[int] = mapped_column(primary_key=True)
    # 用户可改的素材名。文件字节仍按 sha256 寻址，改名不会搬对象或破坏画布引用。
    display_name: Mapped[str | None] = mapped_column(String(160))
    sha256: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    storage_key: Mapped[str] = mapped_column(String(512))
    # 派生尺寸：展示用（宽 768 webp）与缩略图（宽 192 webp），原图保留不重生成
    display_key: Mapped[str | None] = mapped_column(String(512))
    thumb_key: Mapped[str | None] = mapped_column(String(512))
    mime: Mapped[str] = mapped_column(String(32), default="image/png")
    width: Mapped[int] = mapped_column(Integer, default=0)
    height: Mapped[int] = mapped_column(Integer, default=0)
    bytes: Mapped[int] = mapped_column(Integer, default=0)

    # 来源：提示词原样留存，可复用可改后重出
    target_key: Mapped[str] = mapped_column(String(48), index=True)
    style_key: Mapped[str | None] = mapped_column(String(48))
    prompt: Mapped[str] = mapped_column(Text)
    prompt_structure: Mapped[dict | None] = mapped_column(JSONVariant)
    brief: Mapped[dict | None] = mapped_column(JSONVariant)

    # 模型：alias 是业务侧唯一标识，model_reported 记上游实际返回的模型名
    alias: Mapped[str | None] = mapped_column(String(48))
    model_reported: Mapped[str | None] = mapped_column(String(64))
    size_req: Mapped[str | None] = mapped_column(String(24))
    quality: Mapped[str | None] = mapped_column(String(16))
    n_index: Mapped[int] = mapped_column(Integer, default=0)
    usage: Mapped[dict | None] = mapped_column(JSONVariant)

    # 归属：自由出图三者为空
    subject_domain: Mapped[str | None] = mapped_column(String(32), index=True)
    subject_id: Mapped[int | None] = mapped_column(Integer)
    run_id: Mapped[int | None] = mapped_column(Integer)
    step: Mapped[str | None] = mapped_column(String(48))
    # pipeline|workbench|edit|local。local 是纯前端修图的产物，不花钱、不计用量（BR-118）
    source: Mapped[str] = mapped_column(String(16), default="pipeline")

    # 编辑链血缘（FR-435）：出图 -> 换背景 -> 扩图 -> 加水印 是一条链，
    # 每一环都要能追到根（BR-117）。`op` 记的是产生这一环的应用 key（image_apps）
    parent_id: Mapped[int | None] = mapped_column(
        ForeignKey("image_asset.id", ondelete="SET NULL"), index=True
    )
    op: Mapped[str | None] = mapped_column(String(32))

    # 素材分组与 AI 标签（模块 17 FR-477）。长在资产行上而不是另建侧表：
    # image_asset 是全域唯一的资产底座（BR-140），归属与标签是这张图的属性，
    # 拆出去就要为每次列表查询多一次 join，且删侧表行等于悄悄丢标签
    group_id: Mapped[int | None] = mapped_column(
        ForeignKey("studio_asset_group.id", ondelete="SET NULL"), index=True
    )
    caption: Mapped[str | None] = mapped_column(Text)  # AI 打的中文摘要
    tags: Mapped[list | None] = mapped_column(JSONVariant)  # AI 打的中文标签 list[str]
    # null = 还没打过标。筛「未打标」靠它，不靠 tags 是否为空——
    # 打标成功但模型一个标签都没给的图，与从没打过标是两回事
    tagged_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    # candidate 生成出来还没用上；applied 已写回某个目标；archived 软删（BR-105）
    status: Mapped[str] = mapped_column(String(16), default="candidate", index=True)
    favorite: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), index=True
    )

    __table_args__ = (Index("ix_image_asset_subject", "subject_domain", "subject_id"),)


class ImageStyle(Base):
    """用户自定义的画风（模块 16 FR-442）。

    内置风格来自 `data/image_styles.json`（导入的）与代码里自制的那几个，都是只读；
    这张表存用户自己攒的。两者在 `image_prompts.STYLE_PRESETS` 里同一个命名空间，
    所以 `key` 要唯一，写入时会拒绝与内置撞名——否则用户改了个同名风格，
    出图时到底用哪个说不清。
    """

    __tablename__ = "image_style"

    key: Mapped[str] = mapped_column(String(64), primary_key=True)
    label: Mapped[str] = mapped_column(String(48))
    hint: Mapped[str] = mapped_column(String(160), default="")
    category: Mapped[str] = mapped_column(String(32), default="misc", index=True)
    # 注入提示词 style 段的几个字段，与内置风格同构
    render: Mapped[str] = mapped_column(Text)
    palette: Mapped[str] = mapped_column(Text, default="")
    lighting: Mapped[str] = mapped_column(Text, default="")
    texture: Mapped[str] = mapped_column(Text, default="")
    extra_avoid: Mapped[list | None] = mapped_column(JSONVariant)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )


class ImageJob(Base):
    """一次生图任务（模块 16 FR-412）：`image_gen` 管线的主体。

    管线设施要求每条 run 挂在一个"主体"上（`PipelineRun.subject_id`），而图片是
    内容寻址的、生成之前不存在，所以主体只能是任务本身。这张表因此很薄——它记的
    是"要画什么、用什么参数画"，画出来的东西在 `image_asset`。

    `applied_asset_id` 指向最终选中的那张；候选图全部留在 image_asset 里
    （BR-106：已经付过费了，丢掉未选中的等于白花钱）。
    """

    __tablename__ = "image_job"

    id: Mapped[int] = mapped_column(primary_key=True)
    target_key: Mapped[str] = mapped_column(String(48), index=True)
    idea: Mapped[str | None] = mapped_column(Text)  # 用户那句话，可为空
    # 要画给谁：场景本封面就是 ('wordlist', 12)。自由出图两者为空
    subject_domain: Mapped[str | None] = mapped_column(String(32))
    subject_id: Mapped[int | None] = mapped_column(Integer)
    style_key: Mapped[str | None] = mapped_column(String(48))
    size: Mapped[str | None] = mapped_column(String(24))
    quality: Mapped[str | None] = mapped_column(String(16))
    n: Mapped[int] = mapped_column(Integer, default=1)
    alias: Mapped[str] = mapped_column(String(48), default="image-free")
    # 用户手写的提示词；非空则跳过立意与写词两步直接用它
    prompt_override: Mapped[str | None] = mapped_column(Text)
    # 高级参数整包：output_format / background / moderation / output_compression /
    # input_fidelity。用一个 JSONB 而不是逐个加列——上游还在加参数，每来一个就改一次
    # 表结构不划算，而且这些值只是原样透传给上游，本地不按它们查询
    options: Mapped[dict | None] = mapped_column(JSONVariant)
    status: Mapped[str] = mapped_column(String(16), default="pending", index=True)
    error: Mapped[str | None] = mapped_column(Text)
    applied_asset_id: Mapped[int | None] = mapped_column(
        ForeignKey("image_asset.id", ondelete="SET NULL")
    )
    # 统一任务中心中的当前执行；重跑会创建新任务并把本列指向最新一次。
    studio_task_id: Mapped[str | None] = mapped_column(
        ForeignKey("studio_task.id", ondelete="SET NULL"), index=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), index=True
    )


class StudioTask(Base):
    """创作域统一持久化任务（模块 17 BR-174/176）。

    页面只保存本表 id，不承担上游轮询的唯一责任。`invocation` 是提交时快照，
    之后改全局模型或参数不会改变历史任务的重试语义；`source_context` 用于从
    任务中心回到原画布节点、会话或工具。
    """

    __tablename__ = "studio_task"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    domain: Mapped[str] = mapped_column(String(32), default="studio", index=True)
    tool_id: Mapped[str] = mapped_column(String(64), index=True)
    task_type: Mapped[str] = mapped_column(String(64), index=True)
    parent_task_id: Mapped[str | None] = mapped_column(
        ForeignKey("studio_task.id", ondelete="SET NULL"), index=True
    )
    batch_id: Mapped[str | None] = mapped_column(String(36), index=True)
    source_route: Mapped[str | None] = mapped_column(String(512))
    source_context: Mapped[dict | None] = mapped_column(JSONVariant)
    capability: Mapped[str | None] = mapped_column(String(64))
    deployment_id: Mapped[int | None] = mapped_column(
        ForeignKey("model_deployment.id", ondelete="SET NULL"), index=True
    )
    invocation: Mapped[dict | None] = mapped_column(JSONVariant)
    provider_task_id: Mapped[str | None] = mapped_column(String(255), index=True)
    canvas_id: Mapped[int | None] = mapped_column(Integer, index=True)
    node_id: Mapped[str | None] = mapped_column(String(128), index=True)
    execution_group_id: Mapped[str | None] = mapped_column(String(36), index=True)
    mission_id: Mapped[str | None] = mapped_column(
        ForeignKey("jarvis_mission.id", ondelete="SET NULL"), index=True
    )
    status: Mapped[str] = mapped_column(String(24), default="queued", index=True)
    stage: Mapped[str | None] = mapped_column(String(96))
    progress: Mapped[float] = mapped_column(Float, default=0.0)
    result: Mapped[dict | None] = mapped_column(JSONVariant)
    error: Mapped[str | None] = mapped_column(Text)
    retryable: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), index=True
    )
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    heartbeat_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    event_seq: Mapped[int] = mapped_column(Integer, default=0)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )
    events: Mapped[list["StudioTaskEvent"]] = relationship(
        back_populates="task",
        cascade="all, delete-orphan",
        passive_deletes=True,
    )


class StudioTaskEvent(Base):
    """任务状态和进度的追加事件；global_cursor 供 SSE 断线续传。"""

    __tablename__ = "studio_task_event"

    global_cursor: Mapped[int] = mapped_column(BigIntegerPK, primary_key=True, autoincrement=True)
    task_id: Mapped[str] = mapped_column(
        ForeignKey("studio_task.id", ondelete="CASCADE"), index=True
    )
    seq: Mapped[int] = mapped_column(Integer)
    event_type: Mapped[str] = mapped_column(String(64), index=True)
    status: Mapped[str] = mapped_column(String(24), index=True)
    stage: Mapped[str | None] = mapped_column(String(96))
    progress: Mapped[float | None] = mapped_column(Float)
    message: Mapped[str | None] = mapped_column(Text)
    payload: Mapped[dict | None] = mapped_column(JSONVariant)
    canvas_id: Mapped[int | None] = mapped_column(Integer, index=True)
    node_id: Mapped[str | None] = mapped_column(String(128), index=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), index=True
    )
    task: Mapped[StudioTask] = relationship(back_populates="events")

    __table_args__ = (UniqueConstraint("task_id", "seq", name="uq_studio_task_event_seq"),)


class ModelInvocation(Base):
    """一次真实模型请求的持久台账；与 StudioTask 是多对一关系。"""

    __tablename__ = "model_invocation"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    plugin_id: Mapped[str] = mapped_column(String(64), index=True)
    plugin_version: Mapped[str | None] = mapped_column(String(64))
    plugin_generation: Mapped[int | None] = mapped_column(Integer)
    runtime_generation: Mapped[int | None] = mapped_column(Integer)
    operation: Mapped[str] = mapped_column(String(64), index=True)
    capability: Mapped[str | None] = mapped_column(String(64), index=True)
    deployment_id: Mapped[int | None] = mapped_column(
        ForeignKey("model_deployment.id", ondelete="SET NULL"), index=True
    )
    task_id: Mapped[str | None] = mapped_column(
        ForeignKey("studio_task.id", ondelete="SET NULL"), index=True
    )
    source: Mapped[str | None] = mapped_column(String(128), index=True)
    request: Mapped[dict | None] = mapped_column(JSONVariant)
    response: Mapped[dict | None] = mapped_column(JSONVariant)
    provider_request_id: Mapped[str | None] = mapped_column(String(255), index=True)
    model: Mapped[str | None] = mapped_column(String(255), index=True)
    status: Mapped[str] = mapped_column(String(16), default="running", index=True)
    usage: Mapped[dict | None] = mapped_column(JSONVariant)
    latency_ms: Mapped[int | None] = mapped_column(Integer)
    error_type: Mapped[str | None] = mapped_column(String(128))
    error_message: Mapped[str | None] = mapped_column(Text)
    # 内核中立失败码（AUTH / RATE_LIMIT / TIMEOUT …），按码路由重试与告警，不解析文案
    error_code: Mapped[str | None] = mapped_column(String(64))
    # 同一次业务调用的重试 / fallback 链：首次尝试是根（parent 为空），后续尝试指回它
    parent_invocation_id: Mapped[str | None] = mapped_column(
        String(36), ForeignKey("model_invocation.id", ondelete="SET NULL"), index=True
    )
    attempt: Mapped[int] = mapped_column(Integer, default=1, server_default="1")
    # 五桶归一化用量（input 不含缓存命中；reasoning 是 output 的子集）；usage 列保留线协议原貌
    input_tokens: Mapped[int | None] = mapped_column(Integer)
    output_tokens: Mapped[int | None] = mapped_column(Integer)
    cache_read_tokens: Mapped[int | None] = mapped_column(Integer)
    cache_write_tokens: Mapped[int | None] = mapped_column(Integer)
    reasoning_tokens: Mapped[int | None] = mapped_column(Integer)
    # 画布 / 节点 / 工作流运行 / 工具从调用上下文升格成可过滤列；context 只留其余关联键
    canvas_id: Mapped[int | None] = mapped_column(Integer, index=True)
    node_id: Mapped[str | None] = mapped_column(String(128), index=True)
    flow_run_id: Mapped[str | None] = mapped_column(String(36), index=True)
    tool_id: Mapped[str | None] = mapped_column(String(64), index=True)
    context: Mapped[dict | None] = mapped_column(JSONVariant)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), index=True
    )
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    events: Mapped[list["ModelInvocationEvent"]] = relationship(
        back_populates="invocation",
        cascade="all, delete-orphan",
        passive_deletes=True,
    )


class ModelInvocationEvent(Base):
    """一次模型调用的逐步事件：请求头快照、流式分块、用量、终态。

    ``id`` 是全局单调游标（与 StudioTaskEvent.global_cursor 同一做法），``seq`` 是调用内
    顺序；``time`` 由写入方按事件真实发生时刻给定，异步批量落库不会推后它。
    """

    __tablename__ = "model_invocation_event"

    id: Mapped[int] = mapped_column(BigIntegerPK, primary_key=True, autoincrement=True)
    invocation_id: Mapped[str] = mapped_column(
        ForeignKey("model_invocation.id", ondelete="CASCADE"), index=True
    )
    seq: Mapped[int] = mapped_column(Integer)
    # request.header / chunk.text / chunk.reasoning / chunk.tool_delta / chunk.usage
    # / finish / error
    type: Mapped[str] = mapped_column(String(32), index=True)
    time: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    data: Mapped[dict | None] = mapped_column(JSONVariant)
    invocation: Mapped[ModelInvocation] = relationship(back_populates="events")

    __table_args__ = (
        UniqueConstraint("invocation_id", "seq", name="uq_model_invocation_event_seq"),
    )


class StudioMediaAsset(Base):
    """创作域的非图片媒体资产（BR-175）。

    图片继续使用具备提示词、尺寸变体和编辑血缘的 ``image_asset``；视频、音频与
    通用文件落在这里。任务结果只保存 asset id，不把 storage key 当长期公开契约。
    """

    __tablename__ = "studio_media_asset"

    id: Mapped[int] = mapped_column(primary_key=True)
    kind: Mapped[str] = mapped_column(String(16), index=True)
    name: Mapped[str] = mapped_column(String(255))
    mime: Mapped[str] = mapped_column(String(128))
    sha256: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    storage_key: Mapped[str] = mapped_column(String(512), unique=True)
    poster_key: Mapped[str | None] = mapped_column(String(512))
    bytes: Mapped[int] = mapped_column(BigInteger, default=0)
    width: Mapped[int | None] = mapped_column(Integer)
    height: Mapped[int | None] = mapped_column(Integer)
    duration_ms: Mapped[int | None] = mapped_column(Integer)
    source_task_id: Mapped[str | None] = mapped_column(
        ForeignKey("studio_task.id", ondelete="SET NULL"), index=True
    )
    source_url: Mapped[str | None] = mapped_column(Text)
    details: Mapped[dict | None] = mapped_column(JSONVariant)
    parent_id: Mapped[int | None] = mapped_column(
        ForeignKey("studio_media_asset.id", ondelete="SET NULL"), index=True
    )
    group_id: Mapped[int | None] = mapped_column(
        ForeignKey("studio_asset_group.id", ondelete="SET NULL"), index=True
    )
    status: Mapped[str] = mapped_column(String(16), default="active", index=True)
    favorite: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), index=True
    )


class StudioAssetGroup(Base):
    """素材分组（模块 17 FR-477）：给资产贴归属的标签树，最多两级。

    parent_id 为空的是「库」，有值的是库下的「文件夹」。**只允许两级**——三级以上
    的树在侧栏里要么折叠得看不见要么撑破宽度，而素材的真正检索手段是标签不是路径。
    这条约束在领域层校验（父组自身必须是顶级），不靠数据库表达。

    分组只改图片或多媒体资产的 `group_id`，不复制也不搬运字节。所以删组只解除
    归属、绝不删资产：文件归资产域管理，工坊没有处置权（BR-140）。
    """

    __tablename__ = "studio_asset_group"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(60))
    # 删父组时子组升为顶级而不是跟着消失：组里的图还在，凭空少一层归属比丢归属好
    parent_id: Mapped[int | None] = mapped_column(
        ForeignKey("studio_asset_group.id", ondelete="SET NULL")
    )
    sort: Mapped[int] = mapped_column(Integer, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class StudioSharedFolder(Base):
    """素材库登记的项目内共享目录。

    只存相对项目根目录的路径。浏览和导入时重新解析真实路径并做越界校验；删除这行
    只会移除登记，不会碰磁盘目录或其中的文件。
    """

    __tablename__ = "studio_shared_folder"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(120))
    rel_path: Mapped[str] = mapped_column(String(512), unique=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class StudioProject(Base):
    """画布项目。字符串 id 保留 Infinite-Canvas 的 ``default`` 与源项目 id。"""

    __tablename__ = "studio_project"

    id: Mapped[str] = mapped_column(String(48), primary_key=True)
    name: Mapped[str] = mapped_column(String(60))
    sort: Mapped[int] = mapped_column(Integer, default=0, index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class StudioCanvas(Base):
    """创作工坊的无限画布（模块 17 FR-467）。

    `nodes`/`connections`/`viewport` 整包 JSONB：画布是文档不是关系数据，前端
    450ms 防抖全量保存，逐节点拆表只会把每次保存变成一堆 diff 写。落库前经
    `domain/studio.py` 清洗——运行态字段（pending/running…）一律剥掉（BR-143）。

    `version` 是内容乐观锁：PUT 带 base_version，不匹配返回 409 + 最新全量，
    前端按 BR-145 合并后重存。

    `updated_at` 是**内容**更新时间，meta（标题/图标/颜色/置顶/项目）更新不刷它
    （BR-146：打个标签不该把画布顶到列表最前）。所以不能挂 onupdate 自动刷，
    由保存内容的代码显式赋值——本仓另有踩坑：onupdate 列 commit 后要 refresh
    才能读到新值，显式赋值顺带绕开了这个坑。
    """

    __tablename__ = "studio_canvas"

    id: Mapped[int] = mapped_column(primary_key=True)
    title: Mapped[str] = mapped_column(String(80), default="未命名画布")
    icon: Mapped[str] = mapped_column(String(32), default="")
    kind: Mapped[str] = mapped_column(String(16), default="smart")
    owner: Mapped[str] = mapped_column(String(40), default="")
    color: Mapped[str] = mapped_column(String(16), default="")
    pinned: Mapped[bool] = mapped_column(Boolean, default=False)
    project: Mapped[str] = mapped_column(
        ForeignKey("studio_project.id"), default="default", index=True
    )
    board_x: Mapped[float | None] = mapped_column(Float)
    board_y: Mapped[float | None] = mapped_column(Float)
    nodes: Mapped[list] = mapped_column(JSONVariant, default=list)
    connections: Mapped[list] = mapped_column(JSONVariant, default=list)
    viewport: Mapped[dict | None] = mapped_column(JSONVariant)
    settings: Mapped[dict | None] = mapped_column(JSONVariant)
    # {节点 id: 删除生效的 version}。整包 PUT 下，陈旧客户端手里的旧节点与用户刚建的
    # 新节点在载荷里长得一模一样，只有这份记录能把两者分开（domain/studio.py）
    deleted_nodes: Mapped[dict] = mapped_column(JSONVariant, default=dict)
    version: Mapped[int] = mapped_column(Integer, default=1)
    # 软删：回收站 30 天，超期在列表接口顺手物理清除
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class StudioChat(Base):
    """对话生图的会话（模块 17 FR-470）。

    `turns` 整包 JSONB：user 回合存 text + ref_asset_ids，assistant 回合存
    asset_ids + 耗时/错误。图片字节永远在 image_asset（BR-140），这里只存 id。
    乐观锁与 updated_at 语义同 StudioCanvas。
    """

    __tablename__ = "studio_chat"

    id: Mapped[int] = mapped_column(primary_key=True)
    title: Mapped[str] = mapped_column(String(80), default="未命名对话")
    pinned: Mapped[bool] = mapped_column(Boolean, default=False)
    turns: Mapped[list] = mapped_column(JSONVariant, default=list)
    version: Mapped[int] = mapped_column(Integer, default=1)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class StudioPromptGroup(Base):
    """提示词分组（模块 17 FR-478）：与素材分组同形的两级归属树。

    parent_id 为空的是「库」，有值的是库下的「文件夹」。两级约束在领域层校验，
    与 StudioAssetGroup 同一条口径——侧栏容不下三级，而提示词的真正检索手段是搜正文。
    """

    __tablename__ = "studio_prompt_group"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(60))
    # 删父组时子组升为顶级：组里的条目还在，凭空少一层归属比丢归属好
    parent_id: Mapped[int | None] = mapped_column(
        ForeignKey("studio_prompt_group.id", ondelete="SET NULL")
    )
    sort: Mapped[int] = mapped_column(Integer, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class StudioPrompt(Base):
    """一条自建提示词（模块 17 FR-478）。

    **内置模板不进这张表**，它们是 `domain/studio_prompts.BUILTIN_PROMPTS` 里的常量，
    对外用负数 id。理由是升级：内置模板要能随版本改词，写进表就得写一套「哪些行是
    上个版本发的、用户改过没有」的同步逻辑；常量则改一行发一次版就生效，而用户想改
    就 fork 成自建——两边永不打架。所以这里没有 builtin 列，负 id 即内置。

    删组不删条目：`group_id` 置空退回未归组，与素材分组同一条口径（BR-140 的精神）。
    """

    __tablename__ = "studio_prompt"

    id: Mapped[int] = mapped_column(primary_key=True)
    group_id: Mapped[int | None] = mapped_column(
        ForeignKey("studio_prompt_group.id", ondelete="SET NULL"), index=True
    )
    title: Mapped[str] = mapped_column(String(120))
    body: Mapped[str] = mapped_column(Text)
    # 负向与场景给空串而不是 null：前端类型是 string，null 会让每个用它的地方先判一次
    negative: Mapped[str] = mapped_column(Text, default="")
    scene: Mapped[str] = mapped_column(String(200), default="")
    favorite: Mapped[bool] = mapped_column(Boolean, default=False)
    # 模板变量声明：[{name, label, description, default, required}]。
    # 名单由正文里的 `{{name}}` 占位派生（见 domain/studio_prompts.sync_variables），
    # 这一列只存人写的那部分说明，占位本身仍以正文为准
    variables: Mapped[list] = mapped_column(JSONVariant, default=list)
    # 套用次数，用来排「最近常用」
    used_count: Mapped[int] = mapped_column(Integer, default=0)
    version: Mapped[int] = mapped_column(Integer, default=1)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class StudioRevision(Base):
    """提示词与工作流共用的版本链（模块 17 ST-14 / ST-15）。

    一张表两种实体，而不是两张同形的表：版本链的读写逻辑（追加、列出、回滚、
    保留策略）一份就够，分表只会让同一段代码抄两遍，且以后再加第三种实体时又抄一遍。
    `entity_type` + `entity_id` + `version` 唯一，快照整包存在 `snapshot` 里。

    **不无限存**：每个实体只保留最近 `KEEP_RECENT` 版，加上用户手工标了 `pinned`
    的那些。理由是提示词与工作流都是「连着改十几次调一个词」的用法，早期版本的
    召回价值趋近于零，而快照是整段正文或整张节点图，无上限会让这张表按编辑次数
    线性膨胀。真要长期留的，让用户自己按一下「保留」——显式比猜准。
    """

    __tablename__ = "studio_revision"

    id: Mapped[int] = mapped_column(primary_key=True)
    entity_type: Mapped[str] = mapped_column(String(24), index=True)
    entity_id: Mapped[int] = mapped_column(Integer, index=True)
    version: Mapped[int] = mapped_column(Integer)
    snapshot: Mapped[dict] = mapped_column(JSONVariant, default=dict)
    # 一句话备注：谁改的、改了什么。留空就按动作生成（如「回滚到第 3 版」）
    note: Mapped[str] = mapped_column(String(200), default="")
    # 手工标记「这一版别删」。保留策略只裁未标记的
    pinned: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    __table_args__ = (
        UniqueConstraint("entity_type", "entity_id", "version", name="uq_studio_revision_version"),
        Index("ix_studio_revision_entity", "entity_type", "entity_id", "version"),
    )


class StudioGptChat(Base):
    """GPT 创作对话的会话（模块 17 FR-476）。

    `turns` 整包 JSONB：user 回合存 content + image_asset_ids，assistant 回合存
    content + Agent 出的 asset_ids + 耗时/错误。图片字节永远在 image_asset（BR-140）。

    与对话生图（StudioChat）分成两张表而不是加一个 kind 列：那边一轮必出图、
    参考锚定是硬语义；这边一轮可能只说话，出不出图由模型自己用工具调用决定。
    两种回合形状不同，混在一张表里每次读都要先判 kind。
    """

    __tablename__ = "studio_gpt_chat"

    id: Mapped[int] = mapped_column(primary_key=True)
    title: Mapped[str] = mapped_column(String(80), default="未命名对话")
    pinned: Mapped[bool] = mapped_column(Boolean, default=False)
    # 空串 = 用服务端默认系统提示词，不是「没有系统提示词」
    system_prompt: Mapped[str] = mapped_column(Text, default="")
    turns: Mapped[list] = mapped_column(JSONVariant, default=list)
    version: Mapped[int] = mapped_column(Integer, default=1)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class StudioTemplate(Base):
    """工作流模板：画布子图打包成可复用的一份（模块 17 FR-482）。

    `payload` 是 `{nodes, connections, assets}` 整包 JSONB，其中 assets 只存
    `{sha256, width, height, mime, prompt}` 这类元信息，**图片字节一个都不进来**
    ——几十兆的 base64 塞进 JSONB 会直接撑爆库行（BR-101 记过同一件事），而节点里
    的 `asset_id` 换成 sha256 才是可移植的：换库、换环境后按内容指纹反查就能对上。

    导入时同 sha 的图在库里就复用既有资产，不在库就照实标缺失——不伪造一张图
    顶上（BR-110）。真要凭空重建字节得先有导出 zip，那是另一件事。
    """

    __tablename__ = "studio_template"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(80))
    note: Mapped[str] = mapped_column(Text, default="")
    payload: Mapped[dict] = mapped_column(JSONVariant, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
