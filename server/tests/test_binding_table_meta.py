"""GET /config/bindings 驱动通用绑定表：全部能力各一行、元数据随行、可选部署按媒体类型筛。

能力清单只有 credentials.ALL_CAPABILITIES 一份，config.CAPABILITY_META 必须与它一一对应；
设置页不再维护副本。
"""

from __future__ import annotations

from app.routers.config import CAPABILITY_META
from domain.credentials import ALL_CAPABILITIES, encrypt_config
from domain.model_plugins import get_model_plugin, has_model_plugin
from domain.models import CapabilityBinding, ModelDeployment, ProviderCredential

EXISTING_KEYS = {
    "capability",
    "credential_id",
    "deployment_id",
    "target",
    "params",
    "fallback",
    "healthy",
}


def test_capability_meta_covers_all_capabilities_exactly() -> None:
    assert set(CAPABILITY_META) == set(ALL_CAPABILITIES)
    for capability, meta in CAPABILITY_META.items():
        assert meta["label"], capability
        assert meta["group"] in {"llm", "image", "voice", "realtime", "translate"}, capability
        if meta["group"] == "translate":
            assert meta["media_type"] is None and meta["operation"] is None
        else:
            assert meta["media_type"] in {"chat", "image", "audio"}
            assert "." in meta["operation"]


async def _seed(session) -> dict:
    gpt = ProviderCredential(
        name="gpt 中转",
        kind="llm",
        provider_type="openai_compatible",
        config=encrypt_config({"api_base": "https://gw.example/v1", "api_key": "sk-x-1234567890"}),
    )
    off = ProviderCredential(
        name="停用的中转",
        kind="llm",
        provider_type="openai_compatible",
        enabled=False,
        config={"api_base": "https://off.example/v1"},
    )
    session.add_all([gpt, off])
    await session.flush()

    def dep(cred, model, adapter, media, **kw):
        return ModelDeployment(
            credential_id=cred.id,
            upstream_model_id=model,
            adapter_type=adapter,
            media_types=[media],
            **kw,
        )

    # adapter 已经没有插件的历史行（退役的 litellm 网关部署），候选里要标成不可用
    chat_stale = dep(gpt, "gpt-5.4-mini", "litellm", "chat")
    chat_direct = dep(gpt, "gpt-5.4-mini", "openai", "chat")
    chat_disabled = dep(gpt, "gpt-5.4", "openai", "chat", enabled=False)
    image_direct = dep(gpt, "gpt-image-2", "openai", "image")
    off_direct = dep(off, "gpt-5.5", "openai", "chat")
    session.add_all([chat_stale, chat_direct, chat_disabled, image_direct, off_direct])
    await session.flush()
    session.add_all(
        [
            CapabilityBinding(
                capability="explain-standard",
                credential_id=gpt.id,
                deployment_id=chat_direct.id,
                target="gpt-5.4-mini",
                fallback=[{"deployment_id": chat_stale.id}],
            ),
            CapabilityBinding(
                capability="summary",
                credential_id=gpt.id,
                deployment_id=chat_disabled.id,
                target="gpt-5.4",
            ),
            CapabilityBinding(capability="translate-chain", params={"chain": ["llm", "google"]}),
        ]
    )
    await session.commit()
    return {
        "gpt": gpt,
        "chat_stale": chat_stale,
        "chat_direct": chat_direct,
        "chat_disabled": chat_disabled,
        "image_direct": image_direct,
        "off_direct": off_direct,
    }


async def test_list_bindings_returns_every_capability_with_metadata(client, session) -> None:
    seeded = await _seed(session)
    resp = await client.get("/config/bindings")
    assert resp.status_code == 200, resp.text
    rows = {row["capability"]: row for row in resp.json()}
    # 顺序跟 ALL_CAPABILITIES，未绑定的也在
    assert [row["capability"] for row in resp.json()] == list(ALL_CAPABILITIES)
    for capability, row in rows.items():
        assert set(row) >= EXISTING_KEYS
        meta = CAPABILITY_META[capability]
        assert row["label"] == meta["label"]
        assert row["group"] == meta["group"]
        assert row["media_type"] == meta["media_type"]
        assert row["operation"] == meta["operation"]

    bound = rows["explain-standard"]
    assert bound["bound"] is True and bound["healthy"] is True
    assert bound["credential_name"] == "gpt 中转"
    assert bound["provider_type"] == "openai_compatible"
    assert bound["deployment"]["id"] == seeded["chat_direct"].id
    assert bound["deployment"]["adapter_type"] == "openai"
    assert bound["deployment"]["credential_name"] == "gpt 中转"
    assert bound["fallback"] == [{"deployment_id": seeded["chat_stale"].id}]

    unbound = rows["translate-fast"]
    assert unbound["bound"] is False
    assert unbound["healthy"] is False
    assert unbound["credential_id"] is None and unbound["deployment"] is None

    # 所绑部署停用 → 不健康，表上要能看出来
    disabled = rows["summary"]
    assert disabled["bound"] is True and disabled["healthy"] is False

    chain = rows["translate-chain"]
    assert chain["bound"] is True and chain["healthy"] is True
    assert chain["deployment_options"] == [] and chain["ready_plugins"] == []


async def test_list_bindings_deployment_options_follow_media_type_and_readiness(
    client, session
) -> None:
    seeded = await _seed(session)
    rows = {row["capability"]: row for row in (await client.get("/config/bindings")).json()}

    chat_ids = {opt["id"] for opt in rows["explain-standard"]["deployment_options"]}
    assert seeded["chat_stale"].id in chat_ids
    assert seeded["chat_direct"].id in chat_ids
    assert seeded["image_direct"].id not in chat_ids  # image 媒体
    assert seeded["chat_disabled"].id not in chat_ids  # 部署停用
    assert seeded["off_direct"].id not in chat_ids  # 凭据停用

    image_ids = {opt["id"] for opt in rows["image-free"]["deployment_options"]}
    assert image_ids == {seeded["image_direct"].id}

    # 未绑定的同媒体能力拿到同一份候选；ready 标记与插件注册表一致
    assert {opt["id"] for opt in rows["translate-fast"]["deployment_options"]} == chat_ids
    for opt in rows["explain-standard"]["deployment_options"]:
        if not has_model_plugin(opt["adapter_type"]):
            assert opt["ready"] is False, opt  # 历史行的 adapter 没有插件，只能标不可用
            continue
        expected = get_model_plugin(opt["adapter_type"]).is_ready("chat.complete")
        assert opt["ready"] is expected, opt
    ready_ids = {item["id"] for item in rows["explain-standard"]["ready_plugins"]}
    assert ready_ids == {
        item["id"]
        for item in rows["explain-standard"]["ready_plugins"]
        if get_model_plugin(item["id"]).is_ready("chat.complete")
    }


async def test_put_binding_response_keeps_contract_and_adds_deployment_view(
    client, session
) -> None:
    seeded = await _seed(session)

    resp = await client.put(
        "/config/bindings/grammar-deep", json={"deployment_id": seeded["chat_direct"].id}
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert set(body) >= EXISTING_KEYS
    assert "gateway_sync" not in body
    assert body["bound"] is True
    assert body["label"] == "深度语法" and body["group"] == "llm"
    assert body["deployment"]["upstream_model_id"] == "gpt-5.4-mini"
    assert body["deployment"]["adapter_type"] == "openai"
