async def test_scene_endpoints_are_not_registered(client):
    schema = (await client.get("/openapi.json")).json()
    assert not any("scene-atlas" in path for path in schema["paths"])
    assert (await client.get("/scene-atlas/progress")).status_code == 404
    assert (await client.post("/wordlists/catalog/scene-atlas")).status_code == 404
