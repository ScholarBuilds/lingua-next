import unicodedata

from domain.analysis import content_key, get_cached, save_result

ADDR = dict(scope="word", content_hash="c", context_hash="x", kind="word_explain", provider="llm:t")


def test_whitespace_variants_share_key() -> None:
    base = content_key("It is a truth universally acknowledged.")
    assert content_key("  It is a truth   universally\nacknowledged.  ") == base
    assert content_key("It is a truth\tuniversally acknowledged.\r\n") == base


def test_nfc_normalization_shares_key() -> None:
    composed = "café"
    decomposed = unicodedata.normalize("NFD", composed)  # e + 组合重音符
    assert composed != decomposed
    assert content_key(composed) == content_key(decomposed)


def test_distinct_content_distinct_key() -> None:
    assert content_key("hello world") != content_key("hello, world")


def test_key_is_sha256_hex() -> None:
    key = content_key("word")
    assert len(key) == 64
    assert all(c in "0123456789abcdef" for c in key)


async def test_concurrent_save_on_same_address_reuses_existing_row(session, monkeypatch):
    """AI 补全任务与用户同时打开同一张词卡：后到的 INSERT 撞唯一约束时复用先到的行，
    不能把用户那一侧的请求变成 500。"""
    first = await save_result(session, **ADDR, result={"n": 1})

    real_execute = session.execute

    async def stale_execute(stmt, *args, **kwargs):
        # 让「查最大版本号」这一步看到的是撞车前的世界：没有任何版本
        descriptions = getattr(stmt, "column_descriptions", None) or []
        if len(descriptions) == 1 and descriptions[0].get("name") == "version":
            class _Empty:
                def scalar_one_or_none(self):
                    return None

            return _Empty()
        return await real_execute(stmt, *args, **kwargs)

    monkeypatch.setattr(session, "execute", stale_execute)
    second = await save_result(session, **ADDR, result={"n": 2})
    assert second.id == first.id
    assert second.result == {"n": 1}
    monkeypatch.undo()
    cached = await get_cached(session, **ADDR)
    assert cached is not None and cached.version == 1
