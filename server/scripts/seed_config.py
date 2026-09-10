"""配置中心一次性种子导入（FR-06）：凭据入库（加密）→ 直连部署 + 默认绑定。

用法（server 目录）：
    uv run python scripts/seed_config.py [seed.json 路径] [--skip-probe] [--keep-seed]

seed.json 形状：{"llm": [{name, provider_type, api_base, api_key}...],
                 "volc": {app_id, access_key}}   # volc 可省略，省略则不建 TTS/实时语音绑定
成功后删除 seed.json（--keep-seed 保留）；全程只打印掩码，明文不落日志。

LLM 能力一律建成 adapter=openai 的直连 ModelDeployment 并把 CapabilityBinding.deployment_id
指过去。探测经插件层（app.routers.llm_admin.probe_route），绑到哪测哪。
translate-fast 先探 DeepSeek 官方 deepseek-chat，不通则回退智谱中转 deepseek-v4-flash
（reasoning_effort=none）。
"""

import argparse
import asyncio
import json
import sys
from collections.abc import Awaitable, Callable
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from sqlalchemy import select  # noqa: E402
from sqlalchemy.ext.asyncio import AsyncSession  # noqa: E402

from app.db import SessionFactory  # noqa: E402
from app.routers.llm_admin import probe_route  # noqa: E402
from domain.credentials import (  # noqa: E402
    CredentialError,
    encrypt_config,
    mask,
    refresh_models,
    run_test,
)
from domain.models import (  # noqa: E402
    CapabilityBinding,
    ConfigAudit,
    ModelDeployment,
    ProviderCredential,
)

DEFAULT_SEED = (
    "/tmp/nexus-local/-Users-scholar-Documents-----/"
    "11b4e33e-54a5-413e-8da8-06c60994aad0/scratchpad/seed-credentials.json"
)

VOLC_DEFAULT_VOICE = "en_female_skye_uranus_bigtts"  # Skye · 美音女声
REALTIME_SPEAKER = "zh_female_vv_jupiter_bigtts"  # 端到端实时语音默认音色（原代码默认值）

# LLM 能力的直连执行插件；deepseek/openai_compatible 凭据都按 OpenAI 协议直打上游
CHAT_ADAPTER = "openai"

# 探针签名：capability → 结果 dict（至少含 ok/latency_ms/error_type/error）
Prober = Callable[[str], Awaitable[dict]]


async def upsert_credential(
    session: AsyncSession, name: str, kind: str, provider_type: str, config: dict
) -> ProviderCredential:
    stmt = select(ProviderCredential).where(ProviderCredential.name == name)
    cred = (await session.execute(stmt)).scalar_one_or_none()
    stored = encrypt_config(config)
    if cred is None:
        cred = ProviderCredential(
            name=name, kind=kind, provider_type=provider_type, config=stored
        )
        session.add(cred)
    else:
        cred.kind, cred.provider_type, cred.config = kind, provider_type, stored
    await session.flush()
    return cred


async def upsert_deployment(
    session: AsyncSession,
    credential_id: int,
    upstream_model_id: str,
    adapter_type: str = CHAT_ADAPTER,
    media_types: list[str] | None = None,
) -> ModelDeployment:
    """按 (凭据, 上游真名, adapter) 唯一键找或建部署行；已停用的重新启用。"""
    stmt = select(ModelDeployment).where(
        ModelDeployment.credential_id == credential_id,
        ModelDeployment.upstream_model_id == upstream_model_id,
        ModelDeployment.adapter_type == adapter_type,
    )
    deployment = (await session.execute(stmt)).scalar_one_or_none()
    if deployment is None:
        deployment = ModelDeployment(
            credential_id=credential_id,
            upstream_model_id=upstream_model_id,
            adapter_type=adapter_type,
            media_types=list(media_types or ["chat"]),
            discovered=False,
        )
        session.add(deployment)
    deployment.enabled = True
    await session.flush()
    return deployment


async def upsert_binding(
    session: AsyncSession,
    capability: str,
    credential_id: int | None,
    target: str | None,
    params: dict | None = None,
    deployment_id: int | None = None,
) -> None:
    stmt = select(CapabilityBinding).where(CapabilityBinding.capability == capability)
    binding = (await session.execute(stmt)).scalar_one_or_none()
    if binding is None:
        binding = CapabilityBinding(capability=capability)
        session.add(binding)
    binding.credential_id = credential_id
    binding.deployment_id = deployment_id
    binding.target = target
    binding.params = params
    await session.flush()


async def bind_chat(
    session: AsyncSession,
    capability: str,
    cred: ProviderCredential,
    target: str,
    params: dict | None = None,
) -> ModelDeployment:
    """直连部署 + 绑定落库并提交。

    先提交是因为探针经插件层读库，看不到未提交的绑定。
    """
    deployment = await upsert_deployment(session, cred.id, target)
    await upsert_binding(
        session, capability, cred.id, target, params, deployment_id=deployment.id
    )
    await session.commit()
    return deployment


def _probe_note(probe: dict | None) -> str:
    if probe is None:
        return "未探测"
    if probe.get("ok"):
        return f"实测 ok {probe.get('latency_ms')}ms"
    return f"实测失败 {probe.get('error_type')}: {probe.get('error')}"


async def run_seed(
    session: AsyncSession,
    seed: dict,
    *,
    prober: Prober | None = probe_route,
) -> list[str]:
    """执行导入并返回可打印的汇总行；prober=None 表示不发真实模型请求。"""
    lines: list[str] = []

    # 1) LLM 凭据入库 + 真实拉模型 + 连通测试
    llm_creds: dict[str, ProviderCredential] = {}
    for item in seed.get("llm", []):
        config = {"api_base": item["api_base"], "api_key": item["api_key"]}
        cred = await upsert_credential(
            session, item["name"], "llm", item["provider_type"], config
        )
        llm_creds[item["name"]] = cred
        try:
            refreshed = await refresh_models(cred)
            models_note = f"模型 {refreshed['count']} 个"
        except CredentialError as exc:
            models_note = f"拉取失败：{exc}"
        test = await run_test(cred)
        lines.append(
            f"[llm] {cred.name} key={mask(item['api_key'])} "
            f"{models_note}；测试 {'ok ' + str(test['latency_ms']) + 'ms' if test['ok'] else test['detail']}"
        )

    # 2) 火山语音凭据（TTS 2.0 + 实时语音共用）；seed 里没有就跳过语音绑定
    volc = seed.get("volc")
    volc_cred: ProviderCredential | None = None
    if volc:
        volc_cred = await upsert_credential(
            session, "火山引擎语音", "tts", "volc_speech",
            {"app_id": volc["app_id"], "access_key": volc["access_key"]},
        )
        await refresh_models(volc_cred)
        volc_test = await run_test(volc_cred)
        lines.append(
            f"[tts] 火山引擎语音 access_key={mask(volc['access_key'])} "
            f"音色 {len((volc_cred.models_cache or {}).get('items', []))} 个；"
            f"测试 {'ok ' + str(volc_test['latency_ms']) + 'ms' if volc_test['ok'] else volc_test['detail']}"
        )

    # 3) edge-tts 免费档（无密钥）
    edge_cred = await upsert_credential(session, "Edge TTS", "tts", "edge_tts", {})
    try:
        refreshed = await refresh_models(edge_cred)
        lines.append(f"[tts] Edge TTS 音色 {refreshed['count']} 个")
    except CredentialError as exc:
        lines.append(f"[tts] Edge TTS 音色拉取失败：{exc}")

    # 4) translate-fast：先真实测 DeepSeek 官方，不通回退智谱中转
    deepseek = llm_creds.get("DeepSeek 官方")
    zhipu = llm_creds.get("智谱中转")
    tf_done = False
    if deepseek is not None:
        await bind_chat(session, "translate-fast", deepseek, "deepseek-chat")
        probe = await prober("translate-fast") if prober else None
        if probe is None or probe.get("ok"):
            lines.append(
                f"[bind] translate-fast → DeepSeek 官方/deepseek-chat（{_probe_note(probe)}）"
            )
            tf_done = True
        else:
            lines.append(f"[bind] DeepSeek 官方{_probe_note(probe)}，回退智谱")
    if not tf_done and zhipu is not None:
        params = {"reasoning_effort": "none"}
        await bind_chat(session, "translate-fast", zhipu, "deepseek-v4-flash", params)
        probe = await prober("translate-fast") if prober else None
        lines.append(
            f"[bind] translate-fast → 智谱中转/deepseek-v4-flash（reasoning_effort=none，"
            f"{_probe_note(probe)}）"
        )

    # 5) 其余四个 LLM 能力 → gpt 中转
    gpt = llm_creds.get("gpt 中转")
    if gpt is not None:
        for capability, target in (
            ("explain-standard", "gpt-5.4-mini"),
            ("companion", "gpt-5.4-mini"),
            ("grammar-deep", "gpt-5.4"),
            ("summary", "gpt-5.4"),
        ):
            await bind_chat(session, capability, gpt, target)
            probe = await prober(capability) if prober else None
            lines.append(f"[bind] {capability} → gpt 中转/{target}（{_probe_note(probe)}）")

    # 6) TTS 五场景 → 火山 Skye（vocab 0.9x ≈ rate -10）；7) 实时语音
    if volc_cred is not None:
        for scene in ("tts-word", "tts-sentence", "tts-chapter", "tts-video"):
            await upsert_binding(session, scene, volc_cred.id, VOLC_DEFAULT_VOICE, {"rate": 0})
        await upsert_binding(
            session, "tts-vocab", volc_cred.id, VOLC_DEFAULT_VOICE, {"rate": -10}
        )
        lines.append(f"[bind] tts 五场景 → 火山/{VOLC_DEFAULT_VOICE}（vocab rate=-10）")
        await upsert_binding(session, "realtime-voice", volc_cred.id, REALTIME_SPEAKER)
        lines.append(f"[bind] realtime-voice → 火山/{REALTIME_SPEAKER}")

    # 8) 翻译链
    await upsert_binding(
        session, "translate-chain", None, None, {"chain": ["llm", "google"]}
    )
    lines.append("[bind] translate-chain → llm → google")

    session.add(ConfigAudit(action="seed", summary="种子导入：凭据入库 + 默认绑定（直连部署）"))
    await session.commit()
    return lines


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="配置中心种子导入")
    parser.add_argument("seed", nargs="?", default=DEFAULT_SEED, help="seed.json 路径")
    parser.add_argument("--skip-probe", action="store_true", help="不发真实模型请求")
    parser.add_argument("--keep-seed", action="store_true", help="导入后保留 seed.json")
    return parser.parse_args(argv)


async def main() -> None:
    args = parse_args()
    seed_path = Path(args.seed)
    if not seed_path.exists():
        print(f"seed 文件不存在：{seed_path}")
        sys.exit(1)
    seed = json.loads(seed_path.read_text())

    async with SessionFactory() as session:
        lines = await run_seed(
            session,
            seed,
            prober=None if args.skip_probe else probe_route,
        )

    if not args.keep_seed:
        seed_path.unlink()  # 明文种子用后即删
    print(f"=== 配置中心种子导入完成（seed.json {'已保留' if args.keep_seed else '已删除'}） ===")
    for line in lines:
        print(line)


if __name__ == "__main__":
    asyncio.run(main())
