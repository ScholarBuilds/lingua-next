"""桌面包内容升级（M91）：库已存在时按内容戳把基线里缺的内容合并进来，用户自己的东西一行不动。"""

import json
import sqlite3
from pathlib import Path

from sqlalchemy import create_engine

from domain.desktop_content import merge_bundled_content, read_stamp
from domain.models import Base

ANALYSIS_INSERT = (
    "INSERT INTO analysis_result (scope, content_hash, context_hash, kind, provider, lang_pair, "
    "result, version, is_active) "
    "VALUES ('sentence', 'h1', '', 'translate', 'mt', 'en->zh', json_object('zh', ?), 1, 1)"
)


def _fresh(path: Path) -> None:
    engine = create_engine(f"sqlite:///{path}")
    Base.metadata.create_all(engine)
    engine.dispose()


def _seed_baseline(path: Path) -> None:
    con = sqlite3.connect(path)
    con.executemany(
        "INSERT INTO dict_head (word, lc, tier, proper) VALUES (?, ?, ?, 0)",
        [("abandon", "abandon", 1), ("go", "go", 1)],
    )
    con.execute(
        "INSERT INTO book (id, slug, title, source, status) "
        "VALUES (1, 'alice', 'Alice', 'builtin', 'ready')"
    )
    con.execute(
        "INSERT INTO video (id, source_url, title, status, progress) "
        "VALUES (1, 'u', 'Bundled video', 'ready', 100)"
    )
    con.execute(
        "INSERT INTO subtitle_track (id, video_id, kind, lang, label, is_default) "
        "VALUES (1, 1, 'auto', 'en', 'English', 1)"
    )
    con.execute(ANALYSIS_INSERT, ("你好",))
    con.execute("INSERT INTO user_pref (key, value) VALUES ('dict_search.build', '{\"stamp\": 1}')")
    con.commit()
    con.close()


def test_merge_adds_missing_content_and_keeps_user_rows(tmp_path):
    baseline, target, stamp_file = (
        tmp_path / "base.sqlite3",
        tmp_path / "user.sqlite3",
        tmp_path / "stamp.json",
    )
    _fresh(baseline)
    _fresh(target)
    _seed_baseline(baseline)
    con = sqlite3.connect(target)
    # 用户库里已有一条同词的 dict_head、一条自己导入的视频（id 撞号）、一条同地址的译文
    con.execute(
        "INSERT INTO dict_head (word, lc, tier, proper) VALUES ('abandon', 'abandon', 1, 0)"
    )
    con.execute(
        "INSERT INTO video (id, source_url, title, status, progress) "
        "VALUES (1, 'mine', 'My own video', 'ready', 100)"
    )
    con.execute(ANALYSIS_INSERT, ("旧译",))
    con.commit()
    con.close()

    result = merge_bundled_content(target, baseline, "stamp-A", stamp_file)
    assert result["skipped"] is False
    assert result["merged"]["dict_head"] == 1  # 只补了 go
    assert "videos" in result["skipped_groups"]  # 撞号：整组不动
    assert result["merged"]["book"] == 1 and result["merged"]["analysis_result"] == 0
    con = sqlite3.connect(target)
    assert con.execute("SELECT title FROM video").fetchall() == [("My own video",)]
    assert con.execute("SELECT count(*) FROM subtitle_track").fetchone() == (0,)
    assert con.execute("SELECT result FROM analysis_result").fetchone() == ('{"zh":"旧译"}',)
    assert con.execute("SELECT count(*) FROM dict_head").fetchone() == (2,)
    assert con.execute("SELECT value FROM user_pref WHERE key='dict_search.build'").fetchone() == (
        '{"stamp": 1}',
    )
    con.close()
    assert read_stamp(stamp_file) != "stamp-A"
    assert json.loads(stamp_file.read_text())["pending_stamp"] == "stamp-A"
    assert json.loads(stamp_file.read_text())["skipped_groups"] == ["videos"]

    retried = merge_bundled_content(target, baseline, "stamp-A", stamp_file)
    assert retried["skipped"] is False
    assert retried["partial"] is True


def test_merge_copies_video_group_when_user_has_none(tmp_path):
    baseline, target, stamp_file = (
        tmp_path / "base.sqlite3",
        tmp_path / "user.sqlite3",
        tmp_path / "stamp.json",
    )
    _fresh(baseline)
    _fresh(target)
    _seed_baseline(baseline)
    result = merge_bundled_content(target, baseline, "stamp-B", stamp_file)
    assert result["merged"]["video"] == 1 and result["merged"]["subtitle_track"] == 1
    assert result["merged"]["analysis_result"] == 1 and result["skipped_groups"] == []
    con = sqlite3.connect(target)
    assert con.execute("SELECT title FROM video").fetchone() == ("Bundled video",)
    con.close()
    # 换了戳但内容一样：内容表全是 OR IGNORE 零新增；查词索引标记是 OR REPLACE，每次都重写
    again = merge_bundled_content(target, baseline, "stamp-C", stamp_file)
    content_added = {k: v for k, v in again["merged"].items() if k != "user_pref"}
    assert again["skipped"] is False and sum(content_added.values()) == 0
    assert again["merged"]["user_pref"] == 1
    assert read_stamp(stamp_file) == "stamp-C"
