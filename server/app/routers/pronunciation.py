import time

import httpx
from fastapi import APIRouter, Form, HTTPException, UploadFile
from pydantic import BaseModel, ConfigDict, Field

from app.routers.dict import SessionDep
from domain.azure_pronunciation import MAX_AUDIO_BYTES, assess
from domain.credentials import decrypt_config
from domain.models import ProviderCredential, UserPref

settings_router = APIRouter()
router = APIRouter()
PREF_KEY = "pronunciation"


class AssessmentSettings(BaseModel):
    model_config = ConfigDict(extra="forbid")
    enabled: bool = False
    credential_id: int | None = Field(default=None, gt=0)


async def _credential(session, credential_id):
    credential = await session.get(ProviderCredential, credential_id) if credential_id else None
    if not credential or not credential.enabled or credential.provider_type != "azure_speech":
        raise HTTPException(409, "请选择已启用的 Azure Speech 凭据")
    return credential


@settings_router.get("/pronunciation")
async def get_settings(session: SessionDep):
    row = await session.get(UserPref, PREF_KEY)
    return AssessmentSettings.model_validate(row.value if row else {}).model_dump()


@settings_router.put("/pronunciation")
async def put_settings(body: AssessmentSettings, session: SessionDep):
    if body.enabled:
        await _credential(session, body.credential_id)
    row = await session.get(UserPref, PREF_KEY)
    if row:
        row.value = body.model_dump()
    else:
        session.add(UserPref(key=PREF_KEY, value=body.model_dump()))
    await session.commit()
    return body.model_dump()


@router.post("/pronunciation")
async def evaluate(
    session: SessionDep, file: UploadFile, text: str = Form(...), consent: bool = Form(False)
):
    settings = await get_settings(session)
    if not settings["enabled"] or not consent:
        raise HTTPException(409, "请先开启发音评测，并确认本次录音发送给 Azure")
    text = text.strip()
    if not 1 <= len(text) <= 500:
        raise HTTPException(422, "参考句需为 1～500 字符")
    credential = await _credential(session, settings["credential_id"])
    audio = await file.read(MAX_AUDIO_BYTES + 1)
    started = time.monotonic()
    try:
        result = await assess(decrypt_config(credential.config), audio, text)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    except httpx.HTTPError as exc:
        raise HTTPException(502, "Azure 评测请求失败，请检查区域、密钥、额度和网络") from exc
    return {**result, "latency_ms": round((time.monotonic() - started) * 1000)}
