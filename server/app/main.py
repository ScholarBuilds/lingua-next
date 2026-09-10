import asyncio
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager, suppress

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.config import get_settings
from app.db import close_notify_hubs
from app.mcp_server import mount_mcp
from app.routers.analyze import router as analyze_router
from app.routers.annotations import router as annotations_router
from app.routers.articles import router as articles_router
from app.routers.assistant import router as assistant_router
from app.routers.bookmarks import router as bookmarks_router
from app.routers.books import router as books_router
from app.routers.companion import router as companion_router
from app.routers.config import router as config_router
from app.routers.dict import router as dict_router
from app.routers.export import router as export_router
from app.routers.extensions import router as extensions_router
from app.routers.extensions import routines_router
from app.routers.google import router as google_router
from app.routers.grammar import router as grammar_router
from app.routers.grammar_concepts import router as grammar_concepts_router
from app.routers.grammar_docs import router as grammar_docs_router
from app.routers.home import router as home_router
from app.routers.images import router as images_router
from app.routers.llm_admin import router as llm_admin_router
from app.routers.phonetics import router as phonetics_router
from app.routers.pipeline import router as pipeline_router
from app.routers.practice import router as practice_router
from app.routers.progress import router as progress_router
from app.routers.realtime import router as realtime_router
from app.routers.repair import router as repair_router
from app.routers.review import router as review_router
from app.routers.scenario_decks import router as scenario_decks_router
from app.routers.shadowing import router as shadowing_router
from app.routers.studio import router as studio_router
from app.routers.studio_canvas_assets import router as studio_canvas_assets_router
from app.routers.studio_canvas_workflows import router as studio_canvas_workflows_router
from app.routers.studio_connectors import router as studio_connectors_router
from app.routers.studio_flows import router as studio_flows_router
from app.routers.studio_media import router as studio_media_router
from app.routers.studio_shared import router as studio_shared_router
from app.routers.studio_tasks import router as studio_tasks_router
from app.routers.talk import admin_router as talk_admin_router
from app.routers.talk import router as talk_router
from app.routers.tts import router as tts_router
from app.routers.usage import router as usage_router
from app.routers.vault import router as vault_router
from app.routers.videos import router as videos_router
from app.routers.vocab import router as vocab_router
from app.routers.wordlists import router as wordlists_router
from app.routers.workspace import router as workspace_router
from domain import model_invocations

settings = get_settings()


async def drain_invocation_events() -> None:
    """进程退出前把攒着的模型调用事件写完，再停掉消费者任务，别丢最后一批。"""
    await model_invocations.flush_invocation_events()
    task = model_invocations.event_writer._task  # 写入器没有公开的 stop，收尾只能碰私有任务
    if task is not None and not task.done():
        task.cancel()
        with suppress(asyncio.CancelledError):
            await task


@asynccontextmanager
async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
    """启动对账 + 关停收尾：先把台账事件排干，再断开事件流的 LISTEN 连接。"""
    if settings.runtime_profile == "desktop":
        from app.db import SessionFactory
        from app.local_worker import start_local_worker
        from app.routers.talk_records import recover_interrupted

        async with SessionFactory() as db:
            await recover_interrupted(db)
        await start_local_worker()
    yield
    if settings.runtime_profile == "desktop":
        from app.local_worker import stop_local_worker

        await stop_local_worker()
    await drain_invocation_events()
    await close_notify_hubs()


app = FastAPI(title=settings.app_name, version=settings.version, lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=(
        r"^(chrome-extension://[a-p]{32}|https?://(?:localhost|127\.0\.0\.1|"
        r"10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|"
        r"172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2})(?::\d+)?|null)$"
    ),
    allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allow_headers=["Content-Type"],
    allow_credentials=True,
)
app.include_router(workspace_router)
app.include_router(dict_router)
app.include_router(books_router)
app.include_router(articles_router)
app.include_router(export_router)
app.include_router(analyze_router)
app.include_router(tts_router)
app.include_router(vocab_router)
app.include_router(progress_router)
app.include_router(annotations_router)
app.include_router(bookmarks_router)
app.include_router(companion_router)
app.include_router(config_router)
app.include_router(llm_admin_router)
app.include_router(usage_router)
app.include_router(vault_router)
app.include_router(videos_router)
app.include_router(shadowing_router)
app.include_router(pipeline_router)
app.include_router(repair_router)
app.include_router(talk_router)
app.include_router(talk_admin_router)
app.include_router(realtime_router)
app.include_router(wordlists_router)
app.include_router(scenario_decks_router)
app.include_router(review_router)
app.include_router(practice_router)
app.include_router(phonetics_router)
app.include_router(grammar_concepts_router)
app.include_router(grammar_router)
# 讲义库读写分权：读（tree/content/search/GET annotations）对学习者开放，
# 写（improve/apply/批注增删改/analyze）在路由上各自加了 admin 依赖。
# 见 app/routers/grammar_docs.py 的 ADMIN_ONLY
app.include_router(grammar_docs_router)
app.include_router(home_router)
app.include_router(google_router)
app.include_router(assistant_router)
app.include_router(extensions_router)
app.include_router(routines_router)
app.include_router(images_router)
app.include_router(studio_router)
app.include_router(studio_canvas_assets_router)
app.include_router(studio_canvas_workflows_router)
app.include_router(studio_connectors_router)
app.include_router(studio_flows_router)
app.include_router(studio_media_router)
app.include_router(studio_shared_router)
app.include_router(studio_tasks_router)

# 通用 MCP 工具仅挂在应用内部入口，不向浏览器或局域网暴露未鉴权出口。
mount_mcp(app, internal=True)


@app.get("/healthz")
async def healthz() -> dict:
    return {"status": "ok", "app": settings.app_name, "version": settings.version}
