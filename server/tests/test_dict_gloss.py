"""translation 切 gloss 与极短中文（FR-509、FR-381）。"""

from domain.dict_gloss import Gloss, freq_band, short_gloss, split_glosses


def _keys(translation: str) -> list[str]:
    return [g.gloss for g in split_glosses(translation)]


def test_two_lines_two_pos_with_increasing_sense_idx():
    glosses = split_glosses("vt. 放弃, 抛弃, 遗弃\nn. 放任, 无拘束")
    assert glosses[:2] == [Gloss("放弃", "v", 0), Gloss("抛弃", "v", 1)]
    assert glosses[3] == Gloss("放任", "n", 3)


def test_inflection_line_skipped_and_domain_line_offset():
    text = "n. 跑, 赛跑\nrun的过去式和过去分词\n[计] 运行"
    glosses = split_glosses(text)
    assert [g.gloss for g in glosses] == ["跑", "赛跑", "运行"]
    assert glosses[-1].sense_idx == 102
    assert split_glosses("go的过去式") == []
    assert split_glosses("( persecute的过去式和过去分词 )") == []


def test_parenthesis_and_placeholder_cleanup():
    assert _keys("a. 被迫害的( persecute的过去式和过去分词 )") == ["被迫害的", "被迫害"]
    assert _keys("prep. 在...周围, 关于(欲望)") == ["在…周围", "关于"]


def test_adjective_and_adverb_double_key():
    assert _keys("a. 美丽的, 好的") == ["美丽的", "美丽", "好的"]
    assert _keys("ad. 慢慢地") == ["慢慢地", "慢慢"]


def test_compound_pos_prefix_and_non_cjk_pieces_dropped():
    assert split_glosses("vt.&vi. 放弃, give up") == [Gloss("放弃", "v", 0)]
    assert split_glosses("vt.,vi. 放弃")[0].pos == "v"
    assert split_glosses("vt.vi. 放弃")[0].pos == "v"
    assert split_glosses("abbr. 美国标准局")[0].pos is None
    assert _keys("(pl. acarodomatia) 虱巢, 螨巢") == ["虱巢", "螨巢"]
    assert split_glosses("pl. 标准")[0] == Gloss("标准", None, 0)


def test_long_pieces_and_empty_dropped():
    assert _keys("n. 这是一条超过十二个字的很长很长的解释句子") == []
    assert split_glosses("") == []
    assert split_glosses(None) == []


def test_short_gloss():
    assert short_gloss("n. 兔子\nvi. 猎兔") == "兔子"
    assert short_gloss("vt. 放弃, 抛弃, 遗弃") == "放弃"
    assert short_gloss("vt.&vi. 放弃; 抛弃") == "放弃"
    assert short_gloss("go的过去式") == "go的过去式"
    assert short_gloss("[计] 运行\nn. 奔跑") == "奔跑"
    assert short_gloss("[计] 运行") == "运行"
    assert short_gloss("n. 一二三四五六七八九十一二三四") == "一二三四五六七八九十一二"
    assert short_gloss("") is None
    assert short_gloss("n. ") is None


def test_freq_band():
    assert freq_band(0) is None
    assert freq_band(2182) == "很常见"
    assert freq_band(60000) == "罕见"
