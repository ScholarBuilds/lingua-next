"""场景库：内置 YAML 直读 + 用户场景入库，合并时同 key DB 优先（模块 06）。"""

import json
import re
from functools import lru_cache
from pathlib import Path

import yaml
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import get_settings
from domain.llm import complete_json
from domain.models import UserScenario


class DraftInvalid(Exception):
    """LLM 生成的场景草稿不满足 schema。"""

REQUIRED_FIELDS = (
    "key", "title", "title_en", "level", "role_ai", "role_user",
    "goal", "opening_line", "key_sentences", "hints",
)

KEY_RE = re.compile(r"^[a-z][a-z0-9_]{1,63}$")
LEVELS = ("A1", "A2", "B1", "B2", "C1", "C2")


@lru_cache
def _load_all() -> dict[str, dict]:
    root = Path(get_settings().scenarios_dir)
    scenarios: dict[str, dict] = {}
    if not root.is_dir():
        return scenarios
    for path in sorted(root.glob("*.yaml")):
        try:
            data = yaml.safe_load(path.read_text(encoding="utf-8"))
        except yaml.YAMLError:
            continue  # 单个文件损坏不拖垮整个场景库
        if isinstance(data, dict) and all(data.get(f) for f in REQUIRED_FIELDS):
            data["is_builtin"] = True
            scenarios[str(data["key"])] = data
    return scenarios


def list_scenarios() -> list[dict]:
    """内置场景列表（不触库，供单测与兜底使用）。"""
    return list(_load_all().values())


def get_scenario(key: str) -> dict | None:
    """内置场景单查（不触库）。"""
    return _load_all().get(key)


def is_builtin_key(key: str) -> bool:
    return key in _load_all()


def _from_row(row: UserScenario) -> dict:
    data = dict(row.data or {})
    data["key"] = row.key
    data["is_builtin"] = False
    return data


async def list_scenarios_merged(session: AsyncSession) -> list[dict]:
    """内置 + 用户场景合并列表，同 key 用户覆盖内置。"""
    merged = {key: dict(data) for key, data in _load_all().items()}
    rows = (
        await session.execute(select(UserScenario).order_by(UserScenario.created_at.asc()))
    ).scalars()
    for row in rows:
        merged[row.key] = _from_row(row)
    return list(merged.values())


async def get_scenario_merged(session: AsyncSession, key: str) -> dict | None:
    """单场景合并查询：DB 优先，回落内置。"""
    row = (
        await session.execute(select(UserScenario).where(UserScenario.key == key).limit(1))
    ).scalar_one_or_none()
    if row is not None:
        return _from_row(row)
    builtin = _load_all().get(key)
    return dict(builtin) if builtin else None


def validate_scenario(data: object) -> list[str]:
    """校验场景数据结构，返回错误列表；空列表代表通过。"""
    if not isinstance(data, dict):
        return ["场景必须是 JSON 对象"]
    errors: list[str] = []
    for field in ("title", "title_en", "level", "role_ai", "role_user", "goal", "opening_line"):
        value = data.get(field)
        if not isinstance(value, str) or not value.strip():
            errors.append(f"{field} 必填且为非空字符串")
    key = data.get("key")
    if not isinstance(key, str) or not KEY_RE.match(key):
        errors.append("key 必填：小写字母开头，仅含小写字母/数字/下划线，2-64 位")
    level = data.get("level")
    if isinstance(level, str) and level.strip() and level.upper() not in LEVELS:
        errors.append(f"level 仅支持 {'/'.join(LEVELS)}")
    sentences = data.get("key_sentences")
    if not isinstance(sentences, list) or not sentences:
        errors.append("key_sentences 必填且为非空数组")
    else:
        for i, pair in enumerate(sentences):
            if (
                not isinstance(pair, dict)
                or not str(pair.get("en") or "").strip()
                or not str(pair.get("zh") or "").strip()
            ):
                errors.append(f"key_sentences[{i}] 需要非空的 en/zh 字段")
    hints = data.get("hints")
    if not isinstance(hints, list) or not hints:
        errors.append("hints 必填且为非空数组")
    elif not all(isinstance(h, str) and h.strip() for h in hints):
        errors.append("hints 每项必须为非空字符串")
    return errors


def sanitize_scenario(data: dict) -> dict:
    """只保留 schema 字段，剥掉 is_builtin 等运行期标记，避免脏字段入库。"""
    return {field: data[field] for field in REQUIRED_FIELDS if field in data}


DRAFT_ALIAS = "explain-standard"


def build_draft_prompt(idea: str, level: str | None) -> tuple[str, str]:
    system = (
        "你是英语口语陪练场景设计师，根据用户的一句话想法生成完整的陪练场景配置。"
        "只输出 JSON 对象，字段："
        "key（场景英文标识，小写字母开头，仅含小写字母/数字/下划线，如 coffee_order）、"
        "title（中文场景名）、title_en（英文场景名）、"
        "level（CEFR 难度，A1/A2/B1/B2/C1/C2 之一，用户指定了 level 时必须采用）、"
        "role_ai（AI 扮演的角色，中文）、role_user（学习者扮演的角色，中文）、"
        "goal（对话目标，中文一句话，说明学习者要完成什么）、"
        "opening_line（AI 的英文开场白，符合角色口吻）、"
        "key_sentences（数组恰好 3 项，每项 {en: 学习者用得上的英文关键句, zh: 中文意思}）、"
        "hints（数组恰好 2 条中文提示，告诉学习者怎么推进对话）。"
    )
    user = json.dumps({"idea": idea, "level": level}, ensure_ascii=False)
    return system, user


def _normalize_draft(raw: dict, level: str | None) -> dict:
    draft = sanitize_scenario(raw) if isinstance(raw, dict) else {}
    key = re.sub(r"[^a-z0-9_]+", "_", str(draft.get("key") or "").strip().lower()).strip("_")
    if key and not key[0].isalpha():
        key = f"s_{key}"
    if key and is_builtin_key(key):  # 撞内置 key 自动加后缀，避免 POST 时 409
        key = f"{key}_custom"
    draft["key"] = key
    if level:
        draft["level"] = level.upper()
    if isinstance(draft.get("key_sentences"), list):
        draft["key_sentences"] = [
            {"en": str(p["en"]).strip(), "zh": str(p["zh"]).strip()}
            for p in draft["key_sentences"]
            if isinstance(p, dict) and str(p.get("en") or "").strip()
            and str(p.get("zh") or "").strip()
        ]
    if isinstance(draft.get("hints"), list):
        draft["hints"] = [str(h).strip() for h in draft["hints"] if str(h).strip()]
    return draft


async def generate_scenario_draft(idea: str, level: str | None = None) -> dict:
    """LLM 按场景 schema 生成完整草稿（不入库，前端确认后再 POST）。"""
    system, user = build_draft_prompt(idea, level)
    result, _model, _latency = await complete_json(DRAFT_ALIAS, system, user)
    draft = _normalize_draft(result, level)
    errors = validate_scenario(draft)
    if errors:
        raise DraftInvalid("；".join(errors))
    draft["is_builtin"] = False
    return draft
