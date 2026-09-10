"""测试用的能力绑定种子：给内存库建一套直连部署 + 全能力绑定。

能力没绑定部署时运行时直接抛「未绑定」，所以凡是真的
走一次模型路由的测试都得先有绑定。上游调用照旧由各测试自己打桩（`AsyncOpenAI` /
`route_client` 替身），这里只负责让路由解析得出来。
"""

from __future__ import annotations

from domain.credentials import LLM_CAPABILITIES
from domain.imagegen import IMAGE_CAPABILITIES
from domain.models import CapabilityBinding, ModelDeployment, ProviderCredential

CHAT_MODEL = "direct-chat-model"
IMAGE_MODEL = "direct-image-model"
API_BASE = "https://direct.example/v1"


async def seed_default_bindings(session) -> dict[str, ModelDeployment]:
    """建一条 openai_compatible 凭据、一条 chat 部署、一条 image 部署，并绑全部能力。

    返回 ``{"chat": 部署, "image": 部署}``，需要断言 deployment_id 的用例直接取。
    """
    credential = ProviderCredential(
        name="测试直连",
        kind="llm",
        provider_type="openai_compatible",
        config={"api_base": API_BASE, "api_key": "sk-test-direct"},
    )
    session.add(credential)
    await session.flush()

    deployments: dict[str, ModelDeployment] = {}
    for media, model in (("chat", CHAT_MODEL), ("image", IMAGE_MODEL)):
        row = ModelDeployment(
            credential_id=credential.id,
            upstream_model_id=model,
            adapter_type="openai",
            media_types=[media],
        )
        session.add(row)
        deployments[media] = row
    await session.flush()

    for capability in (*LLM_CAPABILITIES, *IMAGE_CAPABILITIES):
        row = deployments["image" if capability in IMAGE_CAPABILITIES else "chat"]
        session.add(
            CapabilityBinding(
                capability=capability,
                credential_id=credential.id,
                deployment_id=row.id,
                target=row.upstream_model_id,
            )
        )
    await session.commit()
    return deployments
