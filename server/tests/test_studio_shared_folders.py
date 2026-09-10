"""共享目录：只读挂载、越界保护与复制入素材库。"""

from pathlib import Path

from domain import storage as storage_mod
from domain import studio_shared_folders
from domain.storage import LocalStorage
from tests.test_studio import noise_png


def _project_tree(tmp_path: Path) -> tuple[Path, Path, Path]:
    project = tmp_path / "project"
    shared = project / "assets" / "shared"
    outside = tmp_path / "outside"
    shared.mkdir(parents=True)
    outside.mkdir()
    return project, shared, outside


async def test_register_browse_preview_and_unregister_without_deleting(
    client, tmp_path, monkeypatch
) -> None:
    project, shared, outside = _project_tree(tmp_path)
    image = noise_png()
    (shared / "photo.png").write_bytes(image)
    (shared / "ignore.txt").write_text("not media", encoding="utf-8")
    nested = shared / "clips"
    nested.mkdir()
    (nested / "demo.mp4").write_bytes(b"fake-video")
    (outside / "secret.png").write_bytes(image)
    (shared / "escape.png").symlink_to(outside / "secret.png")
    monkeypatch.setattr(studio_shared_folders, "PROJECT_ROOT", project)

    registered = await client.post(
        "/studio/shared-folders",
        json={"path": str(shared), "name": "团队素材"},
    )
    assert registered.status_code == 201
    folder = registered.json()
    assert folder["name"] == "团队素材"
    assert folder["rel_path"] == "assets/shared"

    duplicate = await client.post(
        "/studio/shared-folders",
        json={"path": "assets/shared", "name": "共享素材"},
    )
    assert duplicate.status_code == 201
    assert duplicate.json()["id"] == folder["id"]
    assert (await client.get("/studio/shared-folders")).json()["items"][0]["name"] == "共享素材"

    tree = (await client.get(f"/studio/shared-folders/{folder['id']}/tree")).json()["tree"]
    assert [item["name"] for item in tree["items"]] == ["photo.png"]
    assert tree["children"][0]["items"][0]["relative_path"] == "clips/demo.mp4"

    content = await client.get(
        f"/studio/shared-folders/{folder['id']}/file", params={"path": "photo.png"}
    )
    assert content.status_code == 200
    assert content.content == image

    traversal = await client.get(
        f"/studio/shared-folders/{folder['id']}/file",
        params={"path": "../../../outside/secret.png"},
    )
    assert traversal.status_code == 400
    escaped_link = await client.get(
        f"/studio/shared-folders/{folder['id']}/file", params={"path": "escape.png"}
    )
    assert escaped_link.status_code == 400

    removed = await client.delete(f"/studio/shared-folders/{folder['id']}")
    assert removed.json() == {"ok": True}
    assert (shared / "photo.png").read_bytes() == image


async def test_registration_rejects_project_root_and_external_folder(
    client, tmp_path, monkeypatch
) -> None:
    project, _shared, outside = _project_tree(tmp_path)
    monkeypatch.setattr(studio_shared_folders, "PROJECT_ROOT", project)

    root = await client.post("/studio/shared-folders", json={"path": str(project)})
    assert root.status_code == 400
    assert "根目录" in root.json()["detail"]
    external = await client.post("/studio/shared-folders", json={"path": str(outside)})
    assert external.status_code == 400
    assert "项目目录内" in external.json()["detail"]


async def test_import_copies_image_and_media_into_selected_group(
    client, tmp_path, monkeypatch
) -> None:
    project, shared, _outside = _project_tree(tmp_path)
    (shared / "photo.png").write_bytes(noise_png())
    (shared / "voice.mp3").write_bytes(b"fake-audio")
    monkeypatch.setattr(studio_shared_folders, "PROJECT_ROOT", project)
    storage_mod.set_storage(LocalStorage(tmp_path / "storage"))
    try:
        folder = (
            await client.post("/studio/shared-folders", json={"path": str(shared)})
        ).json()
        group = (await client.post("/studio/asset-groups", json={"name": "共享导入"})).json()
        imported = await client.post(
            f"/studio/shared-folders/{folder['id']}/import",
            json={"paths": ["photo.png", "voice.mp3", "missing.png"], "group_id": group["id"]},
        )
        assert imported.status_code == 200
        body = imported.json()
        assert [(item["asset_type"], item["kind"]) for item in body["items"]] == [
            ("image", "image"),
            ("media", "audio"),
        ]
        assert body["failed"][0]["path"] == "missing.png"

        image_id = body["items"][0]["id"]
        image = (await client.get(f"/images/assets/{image_id}")).json()
        assert image["group_id"] == group["id"]
        media = (
            await client.get(
                "/studio/media-assets",
                params={"kind": "audio", "group_id": group["id"]},
            )
        ).json()
        assert media["total"] == 1
        assert media["items"][0]["details"]["source"] == "shared-folder"
    finally:
        storage_mod.set_storage(None)
