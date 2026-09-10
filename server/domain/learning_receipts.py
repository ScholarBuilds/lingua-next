"""同一事务中的提交占位与结果回放。"""

import hashlib
import json

from fastapi import HTTPException
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.dialects.sqlite import insert as sqlite_insert
from sqlalchemy.ext.asyncio import AsyncSession

from domain.models import LearningReceipt


def fingerprint(body: dict) -> str:
    return hashlib.sha256(json.dumps(body, sort_keys=True, ensure_ascii=False).encode()).hexdigest()


async def claim(
    session: AsyncSession, user_id: str, submission_id: str, scope: str, body: dict
) -> tuple[LearningReceipt, bool]:
    insert = sqlite_insert if session.bind.dialect.name == "sqlite" else pg_insert
    digest = fingerprint(body)
    result = await session.execute(
        insert(LearningReceipt)
        .values(user_id=user_id, id=submission_id, scope=scope, fingerprint=digest, response={})
        .on_conflict_do_nothing(index_elements=["user_id", "id"])
    )
    receipt = await session.get(LearningReceipt, (user_id, submission_id), populate_existing=True)
    if receipt.scope != scope or receipt.fingerprint != digest:
        raise HTTPException(409, "提交标识已用于不同内容，请重新读取练习")
    return receipt, result.rowcount == 0
