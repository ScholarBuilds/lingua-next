"""绑定回填脚本与旧别名清单端点（需求 17 调研 §2.8 V6 · §5.4）。

回填三种情形：同凭据已有直连部署（复用）、只有一条 adapter 没插件的历史行
（按 provider_type 推断新建）、推断不出（ollama 没有插件认领，跳过）。
dry-run 不写库，apply 幂等。库里的历史行以退役的 litellm 部署为样本。
"""

from __future__ import annotations

from sqlalchemy import func, select

from domain.models import CapabilityBinding, ConfigAudit, ModelDeployment, ProviderCredential
from scripts import backfill_bindings as backfill


async def _seed(session) -> dict:
    gpt = ProviderCredential(
        name="gpt 中转",
        kind="llm",
        provider_type="openai_compatible",
        config={"api_base": "https://gw.example/v1"},
    )
    deepseek = ProviderCredential(
        name="DeepSeek 官方", kind="llm", provider_type="deepseek", config={}
    )
    ollama = ProviderCredential(
        name="本机 Ollama",
        kind="llm",
        provider_type="ollama",
        config={"api_base": "http://localhost:11434"},
    )
    session.add_all([gpt, deepseek, ollama])
    await session.flush()

    def dep(cred: ProviderCredential, model: str, adapter: str, media: str) -> ModelDeployment:
        return ModelDeployment(
            credential_id=cred.id,
            upstream_model_id=model,
            adapter_type=adapter,
            media_types=[media],
            discovered=True,
        )

    # 成对部署：历史 litellm 行先建、id 更小，直连 openai 行后建
    chat_gateway = dep(gpt, "gpt-5.4-mini", "litellm", "chat")
    chat_direct = dep(gpt, "gpt-5.4-mini", "openai", "chat")
    image_gateway = dep(gpt, "gpt-image-2", "litellm", "image")
    image_direct = dep(gpt, "gpt-image-2", "openai", "image")
    deepseek_gateway = dep(deepseek, "deepseek-chat", "litellm", "chat")
    ollama_gateway = dep(ollama, "qwen3", "litellm", "chat")
    session.add_all(
        [chat_gateway, chat_direct, image_gateway, image_direct, deepseek_gateway, ollama_gateway]
    )
    await session.flush()

    def bind(capability: str, cred: ProviderCredential, target: str, deployment_id=None):
        return CapabilityBinding(
            capability=capability,
            credential_id=cred.id,
            deployment_id=deployment_id,
            target=target,
        )

    session.add_all(
        [
            bind("explain-standard", gpt, "gpt-5.4-mini"),  # 复用已有直连
            bind("image-free", gpt, "gpt-image-2"),  # 复用已有直连（生图）
            bind("image-cover", gpt, "gpt-image-1"),  # 一条部署都没有 → 新建 image
            bind("translate-fast", deepseek, "deepseek-chat"),  # 只有历史行 → 新建 openai
            bind("summary", ollama, "qwen3"),  # 推断不出直连 → 跳过
            bind("companion", gpt, "gpt-5.4-mini", chat_gateway.id),  # 显式挂历史部署
            bind("chat-general", gpt, "gpt-5.4-mini", chat_direct.id),  # 已直连，不进计划
        ]
    )
    await session.commit()
    return {
        "gpt": gpt,
        "deepseek": deepseek,
        "ollama": ollama,
        "chat_gateway": chat_gateway,
        "chat_direct": chat_direct,
        "image_direct": image_direct,
    }


async def _binding(session, capability: str) -> CapabilityBinding:
    # 绑定行可能已在身份映射里且被别的 session 改过，强制按库里的值刷新
    return (
        await session.execute(
            select(CapabilityBinding)
            .where(CapabilityBinding.capability == capability)
            .execution_options(populate_existing=True)
        )
    ).scalar_one()


async def _deployment_count(session) -> int:
    return (await session.execute(select(func.count()).select_from(ModelDeployment))).scalar_one()


async def test_plan_classifies_link_create_skip_without_writing(session) -> None:
    seeded = await _seed(session)
    before = await _deployment_count(session)

    plan = await backfill.plan_backfill(session)
    by_cap = {item.capability: item for item in plan}

    # 已挂部署的（不论网关还是直连）不进计划
    assert set(by_cap) == {
        "explain-standard",
        "image-free",
        "image-cover",
        "translate-fast",
        "summary",
    }
    assert by_cap["explain-standard"].action == "link"
    assert by_cap["explain-standard"].deployment_id == seeded["chat_direct"].id
    assert by_cap["image-free"].deployment_id == seeded["image_direct"].id
    assert by_cap["image-cover"].action == "create"
    assert by_cap["image-cover"].adapter_type == "openai"
    assert by_cap["translate-fast"].action == "create"
    assert by_cap["translate-fast"].adapter_type == "openai"
    assert by_cap["summary"].action == "skip"
    assert "ollama" in by_cap["summary"].note
    # 计划是只读的
    assert await _deployment_count(session) == before
    assert (await _binding(session, "explain-standard")).deployment_id is None
    assert "explain-standard" in backfill.render_plan(plan)


async def test_apply_links_creates_direct_deployments_and_is_idempotent(session) -> None:
    seeded = await _seed(session)
    before = await _deployment_count(session)

    applied = await backfill.apply_backfill(session, await backfill.plan_backfill(session))
    await session.commit()

    assert (await _binding(session, "explain-standard")).deployment_id == seeded["chat_direct"].id
    assert (await _binding(session, "image-free")).deployment_id == seeded["image_direct"].id

    translate = await _binding(session, "translate-fast")
    created = await session.get(ModelDeployment, translate.deployment_id)
    assert created is not None
    assert created.credential_id == seeded["deepseek"].id
    assert created.upstream_model_id == "deepseek-chat"
    assert created.adapter_type == "openai"
    assert created.media_types == ["chat"]
    assert created.discovered is False

    cover = await _binding(session, "image-cover")
    cover_row = await session.get(ModelDeployment, cover.deployment_id)
    assert cover_row is not None
    assert cover_row.adapter_type == "openai"
    assert cover_row.media_types == ["image"]

    # 跳过的原样不动，网关显式绑定也不动
    assert (await _binding(session, "summary")).deployment_id is None
    assert (await _binding(session, "companion")).deployment_id == seeded["chat_gateway"].id
    assert await _deployment_count(session) == before + 2
    assert {item.capability for item in applied if item.deployment_id is not None} >= {
        "translate-fast",
        "image-cover",
    }

    audits = list((await session.execute(select(ConfigAudit))).scalars())
    assert [a.action for a in audits] == ["binding.backfill"]
    assert "translate-fast" in audits[0].summary

    # 再跑一遍：只剩跳过项，不再新建部署、不再记审计
    again = await backfill.apply_backfill(session, await backfill.plan_backfill(session))
    await session.commit()
    assert [item.action for item in again] == ["skip"]
    assert await _deployment_count(session) == before + 2
    assert len(list((await session.execute(select(ConfigAudit))).scalars())) == 1


async def test_cli_dry_run_prints_plan_and_apply_writes(
    session, session_factory, monkeypatch, capsys
) -> None:
    await _seed(session)
    monkeypatch.setattr(backfill, "SessionFactory", session_factory)

    assert await backfill.run(apply=False) == 0
    out = capsys.readouterr().out
    assert "dry-run" in out
    assert "translate-fast" in out and "openai" in out
    assert (await _binding(session, "translate-fast")).deployment_id is None

    assert await backfill.run(apply=True) == 0
    out = capsys.readouterr().out
    assert "已写库" in out
    assert (await _binding(session, "translate-fast")).deployment_id is not None

    assert await backfill.run(apply=True) == 0
    assert "跳过 1" in capsys.readouterr().out


async def test_legacy_bindings_endpoint_lists_alias_paths(client, session) -> None:
    seeded = await _seed(session)

    resp = await client.get("/config/bindings/legacy")
    assert resp.status_code == 200, resp.text
    body = resp.json()
    by_cap = {item["capability"]: item for item in body["items"]}
    assert body["count"] == len(by_cap)

    # 已直连的不在清单里
    assert "chat-general" not in by_cap
    # 没挂部署：给出同凭据可直接切换的直连部署
    explain = by_cap["explain-standard"]
    assert explain["reason"] == "no_deployment"
    assert explain["credential_name"] == "gpt 中转"
    assert explain["suggested_adapter"] == "openai"
    assert explain["direct_deployment_id"] == seeded["chat_direct"].id
    # 显式挂在 adapter 已无插件的历史部署上
    companion = by_cap["companion"]
    assert companion["reason"] == "stale_deployment"
    assert companion["deployment_id"] == seeded["chat_gateway"].id
    assert companion["adapter_type"] == "litellm"
    assert companion["direct_deployment_id"] == seeded["chat_direct"].id
    # 推断不出直连的
    summary = by_cap["summary"]
    assert summary["suggested_adapter"] is None
    assert summary["direct_deployment_id"] is None
    # 根本没绑定的也走旧别名
    assert by_cap["grammar-deep"]["reason"] == "unbound"
    assert by_cap["grammar-deep"]["credential_id"] is None
