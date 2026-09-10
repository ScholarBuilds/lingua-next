"""凭据保险箱 API（CR-007 模块 19）。

表还是 provider_credential，这里只多三件事：通用秘密（站点密码 / 令牌 / cookies）的增删改、
带台账的读出、带口令的导出导入。模型供应商的凭据仍在设置 · 模型服务里加与测（那边有探测、
拉模型、试连），保险箱页只把它们列出来、能读出、能看访问记录。
"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Annotated, Any

from fastapi import APIRouter, Form, HTTPException, Response, UploadFile
from pydantic import BaseModel, Field
from sqlalchemy import func, select

from app.config import get_settings
from app.routers.config import _audit, _referencing_bindings
from app.routers.dict import SessionDep
from domain import vault, vault_key
from domain.credentials import CredentialError, encrypt_config, masked_config, provider_spec
from domain.models import CapabilityBinding, CredentialAccess, ModelDeployment, ProviderCredential

router = APIRouter(prefix="/vault", tags=["vault"])


def _iso(value: datetime | None) -> str | None:
    return value.isoformat() if value else None


def _key_source() -> str:
    settings = get_settings()
    if settings.vault_key_backend == "env" or (
        settings.config_key and settings.vault_key_backend == "auto"
    ):
        return "env"
    return vault_key.key_source()


@router.get("/status")
async def vault_status(session: SessionDep) -> dict:
    count = await session.scalar(select(func.count()).select_from(ProviderCredential))
    return {"key_source": _key_source(), "count": int(count or 0)}


@router.get("/secret-types")
async def secret_types() -> list[dict]:
    return [
        {
            "provider_type": ptype,
            "label": provider_spec(ptype)["label"],
            "fields": provider_spec(ptype)["fields"],
            "notes": provider_spec(ptype).get("notes", ""),
            "secret_kind": vault.secret_kind(ptype),
        }
        for ptype in vault.SECRET_PROVIDER_TYPES
    ]


async def _usage_maps(session) -> tuple[dict[int, int], dict[int, list[str]]]:
    deployments = dict(
        (
            await session.execute(
                select(ModelDeployment.credential_id, func.count()).group_by(
                    ModelDeployment.credential_id
                )
            )
        ).all()
    )
    capabilities: dict[int, list[str]] = {}
    for binding in (await session.execute(select(CapabilityBinding))).scalars():
        ids = {binding.credential_id}
        for item in binding.fallback or []:
            if isinstance(item, dict):
                ids.add(item.get("credential_id"))
        for cid in ids:
            if isinstance(cid, int):
                capabilities.setdefault(cid, []).append(binding.capability)
    return deployments, capabilities


def _view(
    cred: ProviderCredential,
    deployments: int,
    capabilities: list[str],
    last: CredentialAccess | None,
) -> dict:
    try:
        spec = provider_spec(cred.provider_type)
        kind = vault.secret_kind(cred.provider_type)
        secret_fields = vault.secret_fields(cred.provider_type)
        provider_label = spec["label"]
    except CredentialError:
        kind = "none"
        secret_fields = []
        provider_label = f"{cred.provider_type}（已停用）"
    return {
        "id": cred.id,
        "name": cred.name,
        "kind": cred.kind,
        "provider_type": cred.provider_type,
        "provider_label": provider_label,
        "secret_kind": kind,
        "secret_label": vault.SECRET_LABELS[kind],
        "secret_fields": secret_fields,
        "enabled": cred.enabled,
        "status": cred.status,
        "status_detail": cred.status_detail,
        "last_tested_at": _iso(cred.last_tested_at),
        "masked": masked_config(cred.config),
        "used_by": vault.used_by_labels(cred, deployments, capabilities),
        "last_access": {"mode": last.mode, "at": _iso(last.created_at)}
        if last is not None
        else None,
        "managed_in": "vault" if cred.kind == "secret" else "settings",
        "created_at": _iso(cred.created_at),
    }


@router.get("/credentials")
async def list_credentials(session: SessionDep) -> list[dict]:
    rows = list(
        (
            await session.execute(select(ProviderCredential).order_by(ProviderCredential.id))
        ).scalars()
    )
    deployments, capabilities = await _usage_maps(session)
    last = await vault.last_access_by_credential(session)
    return [
        _view(c, deployments.get(c.id, 0), capabilities.get(c.id, []), last.get(c.id)) for c in rows
    ]


class SecretCreate(BaseModel):
    name: str = Field(min_length=1, max_length=128)
    provider_type: str = Field(min_length=1, max_length=32)
    config: dict[str, Any] = Field(default_factory=dict)


def _require_secret_type(provider_type: str) -> dict:
    if provider_type not in vault.SECRET_PROVIDER_TYPES:
        raise HTTPException(
            status_code=400,
            detail="模型供应商的凭据在设置 · 模型服务里添加；保险箱页只收站点密码、令牌与 cookies",
        )
    return provider_spec(provider_type)


async def _load(session, credential_id: int) -> ProviderCredential:
    cred = await session.get(ProviderCredential, credential_id)
    if cred is None:
        raise HTTPException(status_code=404, detail="凭据不存在")
    return cred


@router.post("/credentials", status_code=201)
async def create_secret(body: SecretCreate, session: SessionDep) -> dict:
    spec = _require_secret_type(body.provider_type)
    for field in spec["fields"]:
        value = body.config.get(field["name"])
        if field["required"] and not (isinstance(value, str) and value.strip()):
            raise HTTPException(status_code=400, detail=f"缺少必填字段：{field['label']}")
    try:
        stored = encrypt_config(body.config)
    except CredentialError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    cred = ProviderCredential(
        name=body.name, kind="secret", provider_type=body.provider_type, config=stored
    )
    session.add(cred)
    _audit(session, "credential.create", f"保险箱新增「{body.name}」（{body.provider_type}）")
    await session.commit()
    await session.refresh(cred)
    return _view(cred, 0, [], None)


class SecretPatch(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=128)
    enabled: bool | None = None
    config: dict[str, Any] | None = None


@router.patch("/credentials/{credential_id}")
async def patch_credential(credential_id: int, body: SecretPatch, session: SessionDep) -> dict:
    cred = await _load(session, credential_id)
    if body.config is not None and cred.kind != "secret":
        raise HTTPException(status_code=409, detail="模型供应商的字段在设置 · 模型服务里改")
    if body.name is not None:
        cred.name = body.name
    if body.enabled is not None:
        cred.enabled = body.enabled
    if body.config is not None:
        # 留空 = 不改：密码框不回显明文，用户没重填就沿用旧值
        merged = dict(cred.config)
        for key, value in body.config.items():
            if isinstance(value, str) and value == "":
                continue
            merged[key] = value
        cred.config = encrypt_config(merged)
    _audit(session, "credential.update", f"保险箱修改「{cred.name}」")
    await session.commit()
    await session.refresh(cred)
    deployments, capabilities = await _usage_maps(session)
    last = await vault.last_access_by_credential(session)
    return _view(
        cred, deployments.get(cred.id, 0), capabilities.get(cred.id, []), last.get(cred.id)
    )


@router.delete("/credentials/{credential_id}")
async def delete_secret(credential_id: int, session: SessionDep) -> dict:
    cred = await _load(session, credential_id)
    if cred.kind != "secret":
        raise HTTPException(
            status_code=409, detail="模型供应商的凭据在设置 · 模型服务里删（那边会检查绑定引用）"
        )
    if await _referencing_bindings(session, credential_id):
        raise HTTPException(status_code=409, detail="凭据被能力绑定引用")
    name = cred.name
    await session.delete(cred)
    _audit(session, "credential.delete", f"保险箱删除「{name}」")
    await session.commit()
    return {"deleted": credential_id}


class RevealBody(BaseModel):
    field: str = Field(min_length=1, max_length=64)


@router.post("/credentials/{credential_id}/reveal")
async def reveal_field(credential_id: int, body: RevealBody, session: SessionDep) -> dict:
    cred = await _load(session, credential_id)
    try:
        value = await vault.reveal(session, cred, body.field, purpose="vault.reveal")
    except CredentialError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    await session.commit()
    return {"field": body.field, "value": value}


@router.get("/credentials/{credential_id}/access")
async def access_log(credential_id: int, session: SessionDep, limit: int = 50) -> list[dict]:
    await _load(session, credential_id)
    rows = (
        await session.execute(
            select(CredentialAccess)
            .where(CredentialAccess.credential_id == credential_id)
            .order_by(CredentialAccess.created_at.desc(), CredentialAccess.id.desc())
            .limit(max(1, min(limit, 200)))
        )
    ).scalars()
    return [
        {
            "id": row.id,
            "mode": row.mode,
            "field": row.field,
            "purpose": row.purpose,
            "at": _iso(row.created_at),
        }
        for row in rows
    ]


class ExportBody(BaseModel):
    passphrase: str = Field(min_length=8, max_length=256)


@router.post("/export")
async def export_vault(body: ExportBody, session: SessionDep) -> Response:
    rows = list(
        (
            await session.execute(select(ProviderCredential).order_by(ProviderCredential.id))
        ).scalars()
    )
    try:
        data = vault.export_bundle(rows, body.passphrase)
    except CredentialError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    await vault.record_access(session, None, "export", purpose=f"{len(rows)} 条")
    _audit(session, "vault.export", f"导出保险箱 {len(rows)} 条（带口令）")
    await session.commit()
    stamp = datetime.now(UTC).strftime("%Y%m%d")
    return Response(
        content=data,
        media_type="application/json",
        headers={"Content-Disposition": f'attachment; filename="lingua-vault-{stamp}.json"'},
    )


@router.post("/import")
async def import_vault(
    session: SessionDep,
    file: UploadFile,
    passphrase: Annotated[str, Form(min_length=1)],
) -> dict:
    raw = await file.read()
    try:
        items = vault.import_bundle(raw, passphrase)
        imported, skipped = await vault.import_items(session, items)
    except CredentialError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    await vault.record_access(
        session, None, "import", purpose=f"导入 {imported} 条，跳过 {skipped} 条"
    )
    _audit(session, "vault.import", f"导入保险箱：{imported} 条，跳过 {skipped} 条")
    await session.commit()
    return {"imported": imported, "skipped": skipped}
