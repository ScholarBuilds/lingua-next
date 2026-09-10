from functools import lru_cache
from typing import Literal

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="LINGUA_", env_file=".env", extra="ignore")

    app_name: str = "lingua-next"
    version: str = "0.1.0"
    # desktop = SQLite + 进程内任务队列；server/developer 保留 PostgreSQL + Redis/Arq。
    runtime_profile: str = "developer"
    database_url: str = "postgresql+asyncpg://lingua:lingua@localhost:5432/lingua"
    # 宿主机开发默认连 Compose 映射的 16379（本机 6379 常被其他服务占用）
    redis_url: str = "redis://localhost:16379/0"
    desktop_queue_path: str = "./data/nexus-queue.sqlite3"
    desktop_startup_token: str = ""
    desktop_web_root: str = ""
    local_models_root: str = "./data/models"
    media_root: str = "./data/media"
    # X-Accel-Redirect 前缀（FR-389）：留空则由应用自己发文件（本机开发默认，
    # 直连 8100 或走 vite 代理都能跑）；生产经 nginx 时设成 /__media/，
    # 传输交给 sendfile，省掉应用约 1.3 秒 CPU / GB 出流量
    xaccel_prefix: str = ""
    # 场景陪练场景库目录（仓库根 data/scenarios，容器部署时挂载并覆盖此项）
    scenarios_dir: str = "../data/scenarios"
    # AI 场景本种子清单（需求 01 v2 FR-174）
    scenario_seeds_path: str = "../data/scenario_deck_seeds.yaml"
    # faster-whisper 模型名或本地目录（ADR-007：large-v3 词准确率明显优于 small，
    # 标点由后置的 LLM 恢复阶段解决，不靠模型）。填模型名会走 HuggingFace 下载，
    # 国内单线程仅 1.3MB/s 且会停滞，故本机与镜像内一律指向已落盘的目录。
    whisper_model: str = "large-v3"
    # 请求路径（跟读/陪练/语音改写/跟读比对）走火山失败时的回落模型。
    #
    # > [!danger] 这里不能跟着 whisper_model 用 large-v3
    # >
    # > 那四条链路跑在**同步 HTTP handler 里**，回落会把模型加载进 API 进程并常驻
    # > （`_models` 是进程级单例）。实测 large-v3 峰值 3190MB、常驻 2636MB——
    # > 一个 Web 服务因为 ASR 额度用尽就永久多占 2.6GB，而这四条处理的都是几秒的
    # > 短音频，small（464MB）完全够降级用。视频管线在 worker 里跑，仍用 large-v3。
    whisper_fallback_model: str = "small"
    # OpenAI Realtime 实时语音官方 Key，未配置时 /talk/realtime 返回 503
    openai_realtime_key: str = ""
    # 凭据库 Fernet 加密密钥（基础设施密钥，仅此一项走 .env；业务凭据全部入库）
    # yt-dlp 代理/cookies 已迁入凭据库（kind=video_source，FR-21），env 配置不再保留
    config_key: str = ""
    # 保险箱主密钥来源：auto = 环境变量 → 钥匙串 → 本地文件；env = 只认环境变量（CI 用）
    vault_key_backend: Literal["auto", "env", "keychain", "file"] = "auto"
    # Google OAuth 回调落在 API 自己身上（桌面类型客户端允许任意 loopback 端口）
    google_redirect_base: str = "http://127.0.0.1:8100"
    # 部署级绝对上限，动态配置不可突破（ADR-004 两层限制模型）
    llm_hard_budget_monthly_usd: float = 50.0
    deck_ai_concurrency: int = Field(default=40, ge=1, le=40)
    # 能力探针超时秒数：走插件层发一次真实 LLM 调用
    probe_timeout: float = 45.0
    # MCP 出口（调研 §5.6）：Bearer token，留空则不挂载 /mcp——工具箱仍可经 REST 与画布调用。
    # 这条端点只服务本机 Agent（dsh / Claude Code / Codex），进程一律只监听 127.0.0.1
    mcp_token: str = ""
    mcp_path: str = "/mcp"
    # task_wait 的默认与上限等待秒数：出图几十秒、视频几分钟，上限留够一次长任务
    mcp_wait_timeout: float = 300.0
    mcp_wait_max_timeout: float = 1800.0
    # 轮询间隔；任务状态由 worker 落库，这里只是读快照
    mcp_poll_interval: float = 1.0
    # 火山旧协议 StartSession 现在把 dialog.model 标成必传；1.2.1.1 = O2.0
    volc_dialog_model: str = "1.2.1.1"
    # 上行音频帧 gzip：PCM 几乎不可压，关掉省 CPU；火山不收裸帧时再打开
    volc_audio_gzip: bool = True
    # 语法讲义 vault（模块 15 阅读器）：本机 Obsidian 目录，平台只读为主；测试覆盖成 tmp_path
    grammar_docs_root: str = "./data/grammar"
    # AI 改稿落盘前的备份根目录，相对路径按 server 运行目录解析（与 media_root 同规矩）
    grammar_docs_backup_dir: str = "./data/grammar_doc_backups"


@lru_cache
def get_settings() -> Settings:
    return Settings()
