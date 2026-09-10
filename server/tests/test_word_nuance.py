"""近义词辨析（FR-510）：按目标词 + 同义词表寻址缓存，列表顺序无关。"""

from sqlalchemy import insert

from app.routers import analyze
from domain.models import DictHead


async def _seed_heads(session):
    await session.execute(
        insert(DictHead),
        [
            {"word": "abandon", "lc": "abandon", "tier": 1, "brief": "放弃", "proper": False},
            {"word": "desert", "lc": "desert", "tier": 1, "brief": "放弃", "proper": False},
        ],
    )
    await session.commit()


async def test_nuance_cached_only_then_generate_then_cached(client, session, monkeypatch):
    await _seed_heads(session)
    calls: list[str] = []

    async def fake(alias, system, user, *, deployment_id=None):
        calls.append(user)
        return (
            {
                "summary": "都表示放弃。",
                "items": [
                    {
                        "word": "desert",
                        "difference": "更强调抛下不管",
                        "example_en": "x",
                        "example_zh": "y",
                    }
                ],
            },
            "gpt-test",
            12,
        )

    monkeypatch.setattr(analyze, "complete_json", fake)
    body = {"word": "Abandon", "synonyms": ["desert"]}
    probe = (await client.post("/analyze/nuance?cached_only=true", json=body)).json()
    assert probe == {"result": None, "cached": False}
    assert calls == []

    first = (await client.post("/analyze/nuance", json=body)).json()
    assert first["cached"] is False and first["model"] == "gpt-test"
    assert first["result"]["items"][0]["word"] == "desert"
    assert len(calls) == 1 and '"brief": "放弃"' in calls[0]

    # 同一组同义词换个顺序、换个大小写还是同一槽
    again = (
        await client.post("/analyze/nuance", json={"word": "abandon", "synonyms": ["Desert "]})
    ).json()
    assert again["cached"] is True and len(calls) == 1
    probe = (await client.post("/analyze/nuance?cached_only=true", json=body)).json()
    assert probe["cached"] is True


async def test_nuance_rejects_empty(client):
    resp = await client.post("/analyze/nuance", json={"word": "abandon", "synonyms": ["abandon"]})
    assert resp.status_code == 400
    resp = await client.post("/analyze/nuance", json={"word": "abandon", "synonyms": []})
    assert resp.status_code == 422
