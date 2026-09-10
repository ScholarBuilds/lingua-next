"""生图下单入口与统一执行器的合同测试。

``/images/jobs``、``/images/edit-jobs`` 与 ``/studio/connectors/edit-job`` 都已经
走 ``start_tool_operation``：路由只做请求体到合同的搬运，校验、建行、入队全在
执行器。这里钉死三件事：ImageJob / StudioTask 逐字段与旧路径等价、入队函数名与
响应形状不变、应用规则（蒙版 / 张数 / LoRA）在任何入口都同一份。
"""

import json

import pytest

from domain import image_pipeline
from domain import storage as storage_mod
from domain.models import (
    CapabilityBinding,
    ImageAsset,
    ImageJob,
    ModelDeployment,
    ProviderCredential,
    StudioTask,
)
from domain.storage import StorageError
from domain.tool_execution import (
    ImageEditInput,
    ToolExecutionError,
    UploadRef,
    start_tool_operation,
)


class FakeQueue:
    """记录入队调用与 Redis 写入；``fail`` 打开时模拟 Redis 不可用。"""

    def __init__(self, *, fail: bool = False) -> None:
        self.enqueued: list[tuple] = []
        self.stored: dict[str, str] = {}
        self.fail = fail

    async def set(self, key: str, value: str, ex: int | None = None) -> None:
        self.stored[key] = value

    async def enqueue_job(self, *args, **kwargs) -> None:
        if self.fail:
            raise RuntimeError("redis down")
        self.enqueued.append(args)


class FakeStorage:
    """内存版存储：只实现编辑入口落上传与清理用到的动词。"""

    def __init__(self) -> None:
        self.blobs: dict[str, bytes] = {}

    async def read(self, key: str) -> bytes:
        if key not in self.blobs:
            raise StorageError(f"不存在：{key}")
        return self.blobs[key]

    async def write(self, key: str, data: bytes) -> None:
        self.blobs[key] = data

    async def delete(self, key: str) -> bool:
        return self.blobs.pop(key, None) is not None

    async def exists(self, key: str) -> bool:
        return key in self.blobs

    def upload_keys(self) -> list[str]:
        return sorted(key for key in self.blobs if key.startswith("studio-task-inputs/"))


@pytest.fixture
def fake_storage():
    fake = FakeStorage()
    storage_mod.set_storage(fake)
    yield fake
    storage_mod.set_storage(None)


@pytest.fixture
async def image_deployment(session) -> ModelDeployment:
    """一条可执行 image.generate / image.edit 的 OpenAI 兼容图片部署，并绑到 image-free。"""
    credential = ProviderCredential(
        name="图像中转",
        kind="llm",
        provider_type="openai_compatible",
        config={"api_base": "https://example.invalid/v1"},
    )
    session.add(credential)
    await session.flush()
    deployment = ModelDeployment(
        credential_id=credential.id,
        upstream_model_id="gpt-image-2",
        adapter_type="openai",
        media_types=["image"],
    )
    session.add(deployment)
    await session.flush()
    session.add(
        CapabilityBinding(
            capability="image-free",
            credential_id=credential.id,
            deployment_id=deployment.id,
            target=deployment.upstream_model_id,
        )
    )
    await session.commit()
    await session.refresh(deployment)
    return deployment


@pytest.fixture
async def reference_asset(session) -> ImageAsset:
    row = ImageAsset(
        sha256="3" * 64,
        storage_key="images/executor-ref.png",
        mime="image/png",
        target_key="free",
        prompt="reference",
    )
    session.add(row)
    await session.commit()
    await session.refresh(row)
    return row


def _patch_queue(monkeypatch, module: str, queue: FakeQueue) -> None:
    async def fake_queue():
        return queue

    monkeypatch.setattr(f"{module}.get_queue", fake_queue)


async def _task_count(client) -> int:
    return len((await client.get("/studio/tasks")).json()["items"])


class TestConnectorEditJobViaExecutor:
    async def test_task_is_built_and_queued_by_unified_entry(
        self, client, session, monkeypatch, image_deployment, reference_asset
    ) -> None:
        queue = FakeQueue()
        _patch_queue(monkeypatch, "app.routers.studio_connectors", queue)

        response = await client.post(
            "/studio/connectors/edit-job",
            json={
                "prompt": "turn it into a night scene",
                "deployment_id": image_deployment.id,
                "ref_asset_ids": [reference_asset.id],
                "size": "1024x1024",
                "quality": "high",
                "n": 2,
            },
        )
        assert response.status_code == 202, response.text
        payload = response.json()
        assert set(payload) == {"studio_task_id"}
        task_id = payload["studio_task_id"]

        task = await session.get(StudioTask, task_id)
        assert task is not None
        assert task.status == "queued"
        assert task.tool_id == "photoshop-connector"
        assert task.task_type == "image.edit"
        assert task.capability == "image-free"
        assert task.deployment_id == image_deployment.id
        assert task.source_route == "/studio/canvas"
        assert task.source_context == {"connector": "photoshop"}
        invocation = dict(task.invocation or {})
        assert "_tool_runtime" in invocation
        invocation.pop("_tool_runtime")
        assert invocation == {
            "prompt": "turn it into a night scene",
            "alias": "image-free",
            "size": "1024x1024",
            "quality": "high",
            "app_key": "image_to_image",
            "parent_id": reference_asset.id,
            "n": 2,
            "ref_asset_ids": [reference_asset.id],
            "uploads": [],
            "mask": None,
        }
        # worker 分派名不变：仍由 edit_image_task 按任务 id 接手
        assert queue.enqueued == [("edit_image_task", task_id)]

    async def test_missing_reference_is_rejected_before_any_task_exists(
        self, client, session, monkeypatch, image_deployment
    ) -> None:
        queue = FakeQueue()
        _patch_queue(monkeypatch, "app.routers.studio_connectors", queue)

        response = await client.post(
            "/studio/connectors/edit-job",
            json={
                "prompt": "turn it into a night scene",
                "deployment_id": image_deployment.id,
                "ref_asset_ids": [999_999],
            },
        )
        assert response.status_code == 404
        assert response.json()["detail"] == "参考资产不存在：999999"
        assert queue.enqueued == []
        assert await _task_count(client) == 0

    async def test_queue_failure_marks_task_failed_and_returns_503(
        self, client, session, monkeypatch, image_deployment, reference_asset
    ) -> None:
        _patch_queue(monkeypatch, "app.routers.studio_connectors", FakeQueue(fail=True))

        response = await client.post(
            "/studio/connectors/edit-job",
            json={
                "prompt": "turn it into a night scene",
                "deployment_id": image_deployment.id,
                "ref_asset_ids": [reference_asset.id],
            },
        )
        assert response.status_code == 503
        assert response.json()["detail"].startswith("任务入队失败：RuntimeError")

        tasks = (await client.get("/studio/tasks")).json()["items"]
        assert len(tasks) == 1
        assert tasks[0]["status"] == "failed"
        assert tasks[0]["stage"] == "queue"
        assert tasks[0]["retryable"] is True


class TestCreateJobContract:
    """``/images/jobs`` 换到统一入口前后都必须成立的外部合同。"""

    async def test_idea_job_keeps_brief_pipeline_and_response_shape(
        self, client, session, monkeypatch, image_deployment
    ) -> None:
        queue = FakeQueue()
        _patch_queue(monkeypatch, "app.routers.images", queue)

        response = await client.post(
            "/images/jobs",
            json={
                "target_key": "free",
                "idea": "雨夜屋檐下的橘猫",
                "style_key": "none",
                "size": None,
                "tier": "1k",
                "alias": "image-free",
                "quality": "medium",
                "n": 1,
                "tool_id": "chat-image",
                "source_route": "/studio/chat/7",
                "source_context": {"chat_id": 7},
            },
        )
        assert response.status_code == 202, response.text
        created = response.json()
        assert set(created) == {"job_id", "image_job_id", "studio_task_id", "domain"}
        assert created["domain"] == image_pipeline.DOMAIN

        job = await session.get(ImageJob, created["image_job_id"])
        task = await session.get(StudioTask, created["studio_task_id"])
        assert job is not None and task is not None
        assert job.studio_task_id == task.id
        assert job.status == "pending"
        # 立意链路：idea 落行、prompt_override 留空，worker 才会跑 brief / prompt 两步
        assert job.idea == "雨夜屋檐下的橘猫"
        assert job.prompt_override is None
        assert job.size is None
        assert job.options == {"tier": "1k"}
        assert task.status == "queued"
        assert task.tool_id == "chat-image"
        assert task.task_type == "image.generate"
        assert task.deployment_id == image_deployment.id
        assert task.source_route == "/studio/chat/7"
        assert task.source_context == {"chat_id": 7}
        assert task.invocation["image_job_id"] == job.id
        assert task.invocation["idea"] == "雨夜屋檐下的橘猫"
        assert task.invocation["prompt_override"] is None
        assert task.invocation["_tool_runtime"]["operation"] == "image.generate"

        # 入队形状与 Redis 令牌不变
        assert queue.enqueued == [("generate_image", job.id, None, None, "downstream")]
        token = json.loads(queue.stored[f"image_job:{created['job_id']}"])
        assert token == {
            "job_id": created["job_id"],
            "image_job_id": job.id,
            "status": "running",
        }

    async def test_override_and_subject_binding_are_persisted(
        self, client, session, monkeypatch, image_deployment
    ) -> None:
        queue = FakeQueue()
        _patch_queue(monkeypatch, "app.routers.images", queue)

        response = await client.post(
            "/images/jobs",
            json={
                "target_key": "free",
                "idea": "",
                "prompt_override": "a white cat on a windowsill",
                "subject_domain": "wordlist",
                "subject_id": 12,
                "size": "1024x1024",
                "quality": "high",
                "alias": "image-free",
                "deployment_id": image_deployment.id,
                "output_format": "webp",
            },
        )
        assert response.status_code == 202, response.text
        created = response.json()

        job = await session.get(ImageJob, created["image_job_id"])
        task = await session.get(StudioTask, created["studio_task_id"])
        assert job is not None and task is not None
        assert job.idea is None
        assert job.prompt_override == "a white cat on a windowsill"
        assert job.subject_domain == "wordlist"
        assert job.subject_id == 12
        assert job.quality == "high"
        assert job.size == "1024x1024"
        assert job.options == {"tier": "1k", "output_format": "webp"}
        assert task.invocation["options"] == {"output_format": "webp"}
        assert task.source_route == "/image"
        assert queue.enqueued[0][0] == "generate_image"

    async def test_old_handler_fields_land_on_job_and_task_identically(
        self, client, session, monkeypatch, image_deployment, reference_asset
    ) -> None:
        """旧 create_job 的全部字段逐项落位：高级参数整包、参考图、默认画风。"""
        queue = FakeQueue()
        _patch_queue(monkeypatch, "app.routers.images", queue)

        response = await client.post(
            "/images/jobs",
            json={
                "target_key": "free",
                "prompt_override": "ink cat",
                "alias": "image-free",
                "n": 2,
                "tier": "2k",
                "background": "transparent",
                "output_compression": 80,
                "moderation": "low",
                "negative_prompt": "text, watermark",
                "seed": 17,
                "steps": 24,
                "guidance": 4.5,
                "loras": "org/ink-style",
                "ref_asset_ids": [reference_asset.id],
            },
        )
        assert response.status_code == 202, response.text
        created = response.json()
        job = await session.get(ImageJob, created["image_job_id"])
        task = await session.get(StudioTask, created["studio_task_id"])
        assert job is not None and task is not None
        expected = {
            "background": "transparent",
            "output_compression": 80,
            "moderation": "low",
            "negative_prompt": "text, watermark",
            "seed": 17,
            "steps": 24,
            "guidance": 4.5,
            "loras": "org/ink-style",
            "ref_asset_ids": [reference_asset.id],
        }
        assert job.options == {"tier": "2k", **expected}
        assert job.n == 2
        assert job.alias == "image-free"
        # 没选画风时落用途默认，与旧 handler 的 `style_key or target.default_style` 一致
        assert job.style_key is not None
        assert task.invocation["options"] == expected
        assert task.invocation["tier"] == "2k"
        assert task.invocation["n"] == 2
        assert task.capability == "image-free"
        assert task.tool_id == "image-console"

    async def test_lora_rules_reject_before_any_row_exists(
        self, client, session, monkeypatch, image_deployment
    ) -> None:
        queue = FakeQueue()
        _patch_queue(monkeypatch, "app.routers.images", queue)
        base = {"target_key": "free", "prompt_override": "ink cat", "alias": "image-free"}

        too_long = await client.post("/images/jobs", json={**base, "loras": "x" * 241})
        assert too_long.status_code == 400
        assert too_long.json()["detail"] == "LoRA 模型 ID 过长"

        too_many = await client.post(
            "/images/jobs",
            json={**base, "loras": {f"org/lora-{index}": 0.5 for index in range(7)}},
        )
        assert too_many.status_code == 400
        assert too_many.json()["detail"] == "ModelScope 单次最多使用 6 个 LoRA"

        bad_weight = await client.post(
            "/images/jobs", json={**base, "loras": {"org/lora": 1.5}}
        )
        assert bad_weight.status_code == 400
        assert bad_weight.json()["detail"] == "LoRA ID 不能为空，权重须在 0~1 之间"

        assert queue.enqueued == []
        assert await _task_count(client) == 0

    async def test_queue_failure_fails_both_job_and_task(
        self, client, session, monkeypatch, image_deployment
    ) -> None:
        _patch_queue(monkeypatch, "app.routers.images", FakeQueue(fail=True))

        response = await client.post(
            "/images/jobs",
            json={"target_key": "free", "prompt_override": "ink cat", "alias": "image-free"},
        )
        assert response.status_code == 503
        assert response.json()["detail"].startswith("任务入队失败：RuntimeError")

        tasks = (await client.get("/studio/tasks")).json()["items"]
        assert len(tasks) == 1 and tasks[0]["status"] == "failed"
        job = await session.get(ImageJob, tasks[0]["invocation"]["image_job_id"])
        assert job is not None
        assert job.status == "failed"
        assert job.error == tasks[0]["error"]


class TestCreateEditJobContract:
    """``/images/edit-jobs`` 换到统一入口前后都必须成立的外部合同。"""

    async def test_uploads_mask_and_explicit_parent_are_persisted(
        self, client, session, monkeypatch, image_deployment, reference_asset, fake_storage
    ) -> None:
        """扩图 / 局部重绘的真实形状：只有上传的合成图与蒙版，底图 id 走 parent_id。"""
        queue = FakeQueue()
        _patch_queue(monkeypatch, "app.routers.images", queue)

        response = await client.post(
            "/images/edit-jobs",
            data={
                "prompt": "把天空换成黄昏",
                "app_key": "inpaint",
                "alias": "image-free",
                "quality": "medium",
                "n": "1",
                "size": "1536x1024",
                "parent_id": str(reference_asset.id),
                "tool_id": "infinite-canvas",
                "source_route": "/studio/canvas/9",
                "source_context": json.dumps({"canvas_id": 9, "node_id": "n1"}),
            },
            files=[
                ("images", ("composite.png", b"composite-bytes", "image/png")),
                ("mask", ("mask.png", b"mask-bytes", "image/png")),
            ],
        )
        assert response.status_code == 202, response.text
        assert set(response.json()) == {"studio_task_id"}
        task_id = response.json()["studio_task_id"]

        task = await session.get(StudioTask, task_id)
        assert task is not None
        assert task.status == "queued"
        assert task.tool_id == "infinite-canvas"
        assert task.task_type == "image.edit"
        assert task.capability == "image-free"
        assert task.deployment_id == image_deployment.id
        assert task.source_route == "/studio/canvas/9"
        assert task.source_context == {"canvas_id": 9, "node_id": "n1"}
        invocation = dict(task.invocation or {})
        invocation.pop("_tool_runtime")
        uploads = invocation.pop("uploads")
        mask = invocation.pop("mask")
        assert invocation == {
            "prompt": "把天空换成黄昏",
            "alias": "image-free",
            "size": "1536x1024",
            "quality": "medium",
            "app_key": "inpaint",
            "parent_id": reference_asset.id,
            "n": 1,
            "ref_asset_ids": [],
        }
        # 上传字节已落存储，worker 只认 storage_key
        assert [item["name"] for item in uploads] == ["composite.png"]
        assert mask["name"] == "mask.png"
        assert fake_storage.blobs[uploads[0]["storage_key"]] == b"composite-bytes"
        assert fake_storage.blobs[mask["storage_key"]] == b"mask-bytes"
        assert all(key.startswith("studio-task-inputs/") for key in fake_storage.upload_keys())
        assert queue.enqueued == [("edit_image_task", task_id)]

    async def test_reference_only_edit_defaults_parent_and_clamps_n(
        self, client, session, monkeypatch, image_deployment, reference_asset, fake_storage
    ) -> None:
        queue = FakeQueue()
        _patch_queue(monkeypatch, "app.routers.images", queue)

        response = await client.post(
            "/images/edit-jobs",
            data={
                "prompt": "保持角色，换成黄昏光线",
                "app_key": "consistent_edit",
                "ref_asset_ids": str(reference_asset.id),
                "n": "9",
                "tool_id": "chat-image",
                "source_route": "/studio/chat/7",
                "source_context": json.dumps({"chat_id": 7}),
            },
        )
        assert response.status_code == 202, response.text
        task = await session.get(StudioTask, response.json()["studio_task_id"])
        assert task is not None
        assert task.tool_id == "chat-image"
        assert task.source_context == {"chat_id": 7}
        assert task.invocation["ref_asset_ids"] == [reference_asset.id]
        assert task.invocation["parent_id"] == reference_asset.id
        assert task.invocation["uploads"] == []
        assert task.invocation["mask"] is None
        # 旧 handler 把张数夹到上限而不是拒绝
        assert task.invocation["n"] == 4
        assert fake_storage.upload_keys() == []

    async def test_mask_app_without_mask_is_rejected_and_uploads_discarded(
        self, client, session, monkeypatch, image_deployment, fake_storage
    ) -> None:
        queue = FakeQueue()
        _patch_queue(monkeypatch, "app.routers.images", queue)

        response = await client.post(
            "/images/edit-jobs",
            data={"prompt": "改", "app_key": "inpaint"},
            files=[("images", ("composite.png", b"composite-bytes", "image/png"))],
        )
        assert response.status_code == 400
        assert response.json()["detail"] == "应用「局部重绘」需要先涂出要改的区域"
        # 校验没过就没有任务会来读这些字节，不能留成孤儿文件
        assert fake_storage.upload_keys() == []
        assert queue.enqueued == []
        assert await _task_count(client) == 0

    async def test_fusion_counts_uploads_and_references_together(
        self, client, session, monkeypatch, image_deployment, reference_asset, fake_storage
    ) -> None:
        queue = FakeQueue()
        _patch_queue(monkeypatch, "app.routers.images", queue)
        data = {
            "prompt": "融合",
            "app_key": "image_fusion",
            "ref_asset_ids": str(reference_asset.id),
        }

        only_one = await client.post("/images/edit-jobs", data=data)
        assert only_one.status_code == 400
        assert only_one.json()["detail"] == "应用「多图融合」至少要两张图"
        assert await _task_count(client) == 0

        combined = await client.post(
            "/images/edit-jobs",
            data=data,
            files=[("images", ("up.png", b"upload-bytes", "image/png"))],
        )
        assert combined.status_code == 202, combined.text
        task = await session.get(StudioTask, combined.json()["studio_task_id"])
        assert task is not None
        assert [item["name"] for item in task.invocation["uploads"]] == ["up.png"]
        assert task.invocation["ref_asset_ids"] == [reference_asset.id]
        assert task.invocation["parent_id"] == reference_asset.id
        assert len(fake_storage.upload_keys()) == 1

    async def test_no_input_and_missing_reference_keep_old_status_codes(
        self, client, session, monkeypatch, image_deployment, fake_storage
    ) -> None:
        queue = FakeQueue()
        _patch_queue(monkeypatch, "app.routers.images", queue)

        empty = await client.post(
            "/images/edit-jobs", data={"prompt": "改", "app_key": "image_to_image"}
        )
        assert empty.status_code == 400
        assert empty.json()["detail"] == "至少要一张参考图（上传或 ref_asset_ids）"

        missing = await client.post(
            "/images/edit-jobs",
            data={"prompt": "改", "app_key": "image_to_image", "ref_asset_ids": "9999"},
        )
        assert missing.status_code == 404
        assert missing.json()["detail"] == "参考资产不存在：9999"

        malformed = await client.post(
            "/images/edit-jobs",
            data={"prompt": "改", "app_key": "image_to_image", "ref_asset_ids": "a,b"},
        )
        assert malformed.status_code == 400
        assert "不是合法的 id 列表" in malformed.json()["detail"]
        assert await _task_count(client) == 0

    async def test_queue_failure_keeps_uploads_for_retry(
        self, client, session, monkeypatch, image_deployment, fake_storage
    ) -> None:
        _patch_queue(monkeypatch, "app.routers.images", FakeQueue(fail=True))

        response = await client.post(
            "/images/edit-jobs",
            data={"prompt": "改", "app_key": "image_to_image"},
            files=[("images", ("up.png", b"upload-bytes", "image/png"))],
        )
        assert response.status_code == 503
        assert response.json()["detail"].startswith("任务入队失败：RuntimeError")
        tasks = (await client.get("/studio/tasks")).json()["items"]
        assert len(tasks) == 1
        assert tasks[0]["status"] == "failed" and tasks[0]["retryable"] is True
        # 任务可重试，worker 重来时还要读这份输入
        assert tasks[0]["invocation"]["uploads"][0]["storage_key"] in fake_storage.blobs


class TestImageEditViaExecutorDirectly:
    """画布 / Agent 不经 HTTP 直接给合同：蒙版类应用现在也能走统一入口。"""

    async def test_mask_app_accepts_upload_refs(
        self, session, image_deployment, reference_asset
    ) -> None:
        queue = FakeQueue()
        result = await start_tool_operation(
            session,
            queue,
            tool_id="infinite-canvas",
            operation="image.edit",
            body=ImageEditInput(
                prompt="扩出更多天空",
                app_key="outpaint",
                uploads=[UploadRef(name="composite.png", storage_key="studio-task-inputs/x/a")],
                mask=UploadRef(name="mask.png", storage_key="studio-task-inputs/x/m"),
                parent_id=reference_asset.id,
                size="1536x1024",
            ),
            source_context={"canvas_id": 1, "node_id": "n1"},
        )
        assert result.task.task_type == "image.edit"
        assert result.task.invocation["uploads"] == [
            {"name": "composite.png", "storage_key": "studio-task-inputs/x/a"}
        ]
        assert result.task.invocation["mask"] == {
            "name": "mask.png",
            "storage_key": "studio-task-inputs/x/m",
        }
        assert result.task.invocation["parent_id"] == reference_asset.id
        assert queue.enqueued == [("edit_image_task", result.task.id)]

    async def test_non_edit_app_is_rejected(
        self, session, image_deployment, reference_asset
    ) -> None:
        with pytest.raises(ToolExecutionError, match="不是编辑类"):
            await start_tool_operation(
                session,
                FakeQueue(),
                tool_id="infinite-canvas",
                operation="image.edit",
                body=ImageEditInput(
                    prompt="x", app_key="avatar", ref_asset_ids=[reference_asset.id]
                ),
            )

    async def test_explicit_parent_must_be_positive(self) -> None:
        with pytest.raises(ValueError):
            ImageEditInput(prompt="x", ref_asset_ids=[1], parent_id=0)
