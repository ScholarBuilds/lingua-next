"""本 → 词集合 / 本名 / 例句语境（清缓存、清进度、AI 补全共用，FR-499~502）。"""

import pytest

from domain import decks
from domain.models import DictEntry, VocabEntry, Wordlist, WordlistItem, WordScene


async def _seed(session) -> Wordlist:
    session.add_all(
        [
            DictEntry(word="apple", tag="zk cet4", exchange="0:apple/s:apples"),
            DictEntry(word="ran", tag="zk", exchange="0:run"),
            DictEntry(word="zebra", tag="gre"),
            WordScene(word="apple", example_en="An apple a day."),
        ]
    )
    custom = Wordlist(name="厨房用具")
    session.add(custom)
    await session.flush()
    session.add_all(
        [
            WordlistItem(wordlist_id=custom.id, word="spoon", example_en="Use a spoon."),
            WordlistItem(wordlist_id=custom.id, word="bowl"),
        ]
    )
    session.add(VocabEntry(user_id="owner", word="kiwi"))
    await session.commit()
    return custom


async def test_deck_words_covers_exam_custom_vocab_and_unknown(session):
    custom = await _seed(session)
    assert await decks.deck_words(session, "zk") == {"apple", "ran"}
    assert await decks.deck_words(session, f"custom:{custom.id}") == {"spoon", "bowl"}
    assert await decks.deck_words(session, decks.VOCAB_KEY) is None
    assert await decks.deck_words(session, "") is None
    with pytest.raises(decks.UnknownDeck):
        await decks.deck_words(session, "nope")
    with pytest.raises(decks.UnknownDeck):
        await decks.deck_words(session, "custom:abc")


async def test_deck_name_matches_wordlist_listing(client, session):
    custom = await _seed(session)
    listing = (await client.get("/wordlists")).json()
    names = {row["key"]: row["name"] for row in listing}
    for key in ("zk", "gre", f"custom:{custom.id}", decks.VOCAB_KEY):
        assert await decks.deck_name(session, key) == names[key]
    with pytest.raises(decks.UnknownDeck):
        await decks.deck_name(session, "custom:999")


@pytest.mark.parametrize(
    ("exchange", "word", "expected"),
    [
        ("0:run/p:ran", "ran", "run"),
        ("0:apple/s:apples", "apple", None),  # 原形就是自己
        ("s:apples", "apple", None),  # 没有 0: 段
        ("", "apple", None),
        (None, "apple", None),
        ("0:", "apple", None),
        (":run", "ran", None),  # 冒号在开头不算段
    ],
)
def test_lemma_of_mirrors_word_card(exchange, word, expected):
    assert decks.lemma_of(exchange, word) == expected


async def test_deck_word_contexts_follow_item_row_sources(session):
    custom = await _seed(session)
    assert await decks.deck_word_contexts(session, "zk", "owner") == [
        ("apple", "An apple a day."),
        ("ran", None),
    ]
    assert await decks.deck_word_contexts(session, f"custom:{custom.id}", "owner") == [
        ("bowl", None),
        ("spoon", "Use a spoon."),
    ]
    assert await decks.deck_word_contexts(session, decks.VOCAB_KEY, "owner") == [("kiwi", None)]


async def test_review_queue_still_404s_unknown_deck(client):
    assert (await client.get("/review/queue", params={"deck": "nope"})).status_code == 404
    assert (await client.get("/review/queue", params={"deck": "custom:x"})).status_code == 404
