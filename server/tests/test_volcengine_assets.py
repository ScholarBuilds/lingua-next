"""火山 Ark 私域素材签名与异步注册合同。"""

import json

import httpx
import pytest

from domain import volcengine_assets
from domain.volcengine_assets import VolcengineAssetError


def _config() -> dict:
    return {
        "access_key_id": "AKIDEXAMPLE",
        "secret_access_key": "secret-example",
        "project_name": "default",
        "region": "cn-beijing",
    }


def _install_transport(monkeypatch, handler) -> None:
    real_client = httpx.AsyncClient

    def factory(*args, **kwargs):
        kwargs["transport"] = httpx.MockTransport(handler)
        return real_client(*args, **kwargs)

    monkeypatch.setattr(volcengine_assets.httpx, "AsyncClient", factory)


def test_sign_v4_headers_has_stable_canonical_post_signature() -> None:
    body = b'{"Id":"asset-1","ProjectName":"default"}'
    headers = volcengine_assets.sign_v4_headers(
        "AKIDEXAMPLE",
        "secret-example",
        "GetAsset",
        body,
        x_date="20260822T120000Z",
    )
    assert headers["X-Content-Sha256"] == (
        "f350a83877d1ff873274e702ef71d8adc3953c20c2b932d346bc50156831cc99"
    )
    assert headers["Authorization"] == (
        "HMAC-SHA256 Credential=AKIDEXAMPLE/20260822/cn-beijing/ark/request, "
        "SignedHeaders=content-type;host;x-content-sha256;x-date, "
        "Signature=7fbf6e56e4a76a69b948d9f3c31a57197f129f96cb7da348d2ef706caa40ee11"
    )


async def test_create_and_get_asset_follow_ark_group_contract(monkeypatch) -> None:
    actions: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        action = request.url.params["Action"]
        actions.append(action)
        assert request.headers["authorization"].startswith(
            "HMAC-SHA256 Credential=AKIDEXAMPLE/"
        )
        body = json.loads(request.content)
        assert body["ProjectName"] == "default"
        if action == "ListAssetGroups":
            return httpx.Response(200, json={"Result": {"Items": []}})
        if action == "CreateAssetGroup":
            return httpx.Response(200, json={"Result": {"Id": "group-1"}})
        if action == "CreateAsset":
            assert body == {
                "GroupId": "group-1",
                "URL": "https://cdn.example/person.png",
                "AssetType": "Image",
                "Name": "人物参考",
                "ProjectName": "default",
            }
            return httpx.Response(200, json={"Result": {"Id": "asset-1"}})
        if action == "GetAsset":
            return httpx.Response(
                200,
                json={"Result": {"Id": "asset-1", "Status": "Active"}},
            )
        return httpx.Response(404)

    _install_transport(monkeypatch, handler)
    created = await volcengine_assets.create_asset(
        _config(),
        public_url="https://cdn.example/person.png",
        name="人物参考",
        asset_type="Image",
    )
    fetched = await volcengine_assets.get_asset(_config(), "asset-1")
    assert created == {
        "asset_id": "asset-1",
        "asset_uri": "asset://asset-1",
        "status": "Processing",
    }
    assert fetched["status"] == "Active"
    assert fetched["asset_uri"] == "asset://asset-1"
    assert actions == ["ListAssetGroups", "CreateAssetGroup", "CreateAsset", "GetAsset"]


async def test_asset_registration_rejects_local_url_before_network() -> None:
    with pytest.raises(VolcengineAssetError, match="公网可访问"):
        await volcengine_assets.create_asset(
            _config(), public_url="/api/images/1/file", name="local", asset_type="Image"
        )


async def test_ark_error_never_exposes_secret_access_key(monkeypatch) -> None:
    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={
                "ResponseMetadata": {
                    "Error": {"Code": "InvalidSignature", "Message": "signature mismatch"}
                }
            },
        )

    _install_transport(monkeypatch, handler)
    with pytest.raises(VolcengineAssetError) as caught:
        await volcengine_assets.get_asset(_config(), "asset-1")
    assert "secret-example" not in str(caught.value)
