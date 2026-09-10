from unittest.mock import AsyncMock, Mock

import httpx
import pytest
from pydantic import ValidationError

from domain import network_policy
from domain.models import UserPref
from domain.network_policy import NetworkPolicy, video_config


async def test_legacy_policy_does_not_expand_authorization(session):
    session.add(UserPref(key="network", value={"enabled": True, "speech": True}))
    await session.commit()
    policy = await network_policy.load_policy(session)
    assert policy.scope == "selected"
    assert policy.proxy_for() is None
    assert policy.proxy_for("speech") == policy.address


@pytest.mark.parametrize("url", ["http://localhost:8100", "http://127.1.2.3/a", "http://[::1]/"])
def test_global_proxy_bypasses_loopback(url):
    policy = NetworkPolicy(enabled=True)
    assert policy.proxy_for(url=url) is None
    assert policy.proxy_for(url="https://api.example.com") == policy.address
    assert policy.proxy_for(url="https://127.remote.example.com") == policy.address


async def test_transport_reloads_policy_and_routes_redirects(monkeypatch):
    policy = NetworkPolicy(enabled=True)
    monkeypatch.setattr(network_policy, "load_policy", AsyncMock(return_value=policy))
    monkeypatch.setenv("HTTPS_PROXY", "http://unwanted.invalid:1234")
    calls = []
    transports = []

    def transport_factory(*, proxy, trust_env):
        assert trust_env is False

        def respond(request):
            calls.append((request.url.host, proxy))
            if request.url.host == "redirect.example":
                return httpx.Response(302, headers={"location": "http://127.0.0.1:8100/health"})
            return httpx.Response(200)

        transport = httpx.MockTransport(respond)
        transport.aclose = AsyncMock()
        transports.append(transport)
        return transport

    monkeypatch.setattr(network_policy.httpx, "AsyncHTTPTransport", transport_factory)
    async with network_policy.routed_http_client(follow_redirects=True) as client:
        await client.get("https://redirect.example")
        policy.enabled = False
        await client.get("https://api.example")
    assert calls == [
        ("redirect.example", policy.address),
        ("127.0.0.1", None),
        ("api.example", None),
    ]
    for transport in transports:
        transport.aclose.assert_awaited_once()


async def test_subprocess_environment_has_one_proxy_source(monkeypatch):
    monkeypatch.setenv("https_proxy", "http://unwanted.invalid:1234")
    policy = NetworkPolicy()
    monkeypatch.setattr(network_policy, "load_policy", AsyncMock(return_value=policy))
    env = await network_policy.subprocess_env()
    assert env["https_proxy"] == env["HTTPS_PROXY"] == ""
    policy.enabled = True
    assert (await network_policy.subprocess_env())["HTTPS_PROXY"] == policy.address


@pytest.mark.parametrize(
    "address",
    [
        "socks5://localhost:7890",
        "http://u:p@localhost:7890",
        "http://localhost",
        "http://localhost:99999",
        "http://localhost:7890/a",
        "http://localhost:7890?x=1",
        "not a url",
    ],
)
def test_invalid_proxy_address(address):
    with pytest.raises(ValidationError):
        NetworkPolicy(address=address)


def test_proxy_scopes_and_master_switch():
    policy = NetworkPolicy(enabled=True, scope="selected")
    assert policy.proxy_for("video") == "http://127.0.0.1:7890"
    assert policy.proxy_for("speech") is None
    policy.speech = True
    assert policy.proxy_for("speech") == policy.address
    policy.enabled = False
    assert policy.proxy_for("speech") is None
    assert policy.proxy_for("video") is None


async def test_settings_roundtrip_and_validation(client):
    assert (await client.get("/config/network")).json()["enabled"] is False
    value = {"enabled": True, "address": "http://127.0.0.1:7890/", "video": False, "speech": True}
    response = await client.put("/config/network", json=value)
    assert response.status_code == 200
    assert response.json()["address"].endswith(":7890")
    assert (await client.get("/config/network")).json() == response.json()
    assert (
        await client.put("/config/network", json={**value, "address": "file:///tmp/x"})
    ).status_code == 422
    assert (await client.put("/config/prefs", json={"network": {}})).status_code == 422


async def test_video_policy_overrides_legacy_proxy_and_disables_env(session, monkeypatch):
    monkeypatch.setenv("HTTPS_PROXY", "http://localhost:9999")
    config = await video_config({"proxy": "http://localhost:7777", "quality": "720"}, session)
    assert config == {"proxy": "", "quality": "720"}
    session.add(UserPref(key="network", value=NetworkPolicy(enabled=True).model_dump()))
    await session.commit()
    assert (await video_config({}, session))["proxy"] == "http://127.0.0.1:7890"


async def test_speech_reads_persisted_policy(session):
    session.add(
        UserPref(key="network", value=NetworkPolicy(enabled=True, speech=True).model_dump())
    )
    await session.commit()
    assert await network_policy.speech_proxy() == "http://127.0.0.1:7890"


async def test_probe_has_no_credential_requirement(client, monkeypatch):
    probe = AsyncMock(return_value={"reachable": True, "message": "network only"})
    monkeypatch.setattr(network_policy, "probe_speech_network", probe)
    response = await client.post("/config/network/probe", json=NetworkPolicy().model_dump())
    assert response.status_code == 200
    probe.assert_awaited_once()


async def test_realtime_passes_explicit_proxy_to_websocket(monkeypatch):
    from domain import volc_realtime

    socket = AsyncMock()
    http = AsyncMock()
    http.ws_connect.return_value = socket
    constructor = Mock(return_value=http)
    monkeypatch.setattr(volc_realtime.aiohttp, "ClientSession", constructor)
    monkeypatch.setattr(
        volc_realtime, "speech_proxy", AsyncMock(return_value="http://localhost:7890")
    )
    client = volc_realtime.VolcRealtimeClient("test-app", "test-token")
    monkeypatch.setattr(
        client, "receive", AsyncMock(return_value=volc_realtime.ServerEvent(event=50))
    )
    await client.connect()
    assert constructor.call_args.kwargs["trust_env"] is False
    assert http.ws_connect.call_args.kwargs["proxy"] == "http://localhost:7890"


@pytest.mark.parametrize("status,reachable", [(404, True), (407, False), (502, False)])
async def test_network_probe_distinguishes_gateway_errors(monkeypatch, status, reachable):
    response = AsyncMock()
    response.status = status
    response.__aenter__.return_value = response
    http = AsyncMock()
    http.__aenter__.return_value = http
    http.get = Mock(return_value=response)
    constructor = Mock(return_value=http)
    monkeypatch.setattr(network_policy.aiohttp, "ClientSession", constructor)
    result = await network_policy.probe_speech_network(NetworkPolicy())
    assert result["reachable"] is reachable
    assert constructor.call_args.kwargs["trust_env"] is False
    assert http.get.call_args.kwargs["proxy"] is None
    assert "headers" not in http.get.call_args.kwargs
