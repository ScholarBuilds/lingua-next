"""把 .env 里的保险箱主密钥（LINGUA_CONFIG_KEY）迁进系统钥匙串（CR-007 模块 19，Q4）。

    uv run python scripts/vault_key_to_keychain.py

成功后从 server/.env 删掉 LINGUA_CONFIG_KEY 那一行；库里的密文不用动，密钥本身没变。
Docker 模式下容器里没有钥匙串，那条路继续用环境变量。
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from domain.vault_key import (  # noqa: E402
    KEYRING_ACCOUNT,
    KEYRING_SERVICE,
    move_env_key_to_keychain,
)


def main() -> int:
    try:
        source = move_env_key_to_keychain()
    except RuntimeError as exc:
        print(exc, file=sys.stderr)
        return 1
    print(
        f"主密钥已写进钥匙串（service={KEYRING_SERVICE} account={KEYRING_ACCOUNT}），当前来源：{source}"
    )
    print(
        "现在可以从 server/.env 删掉 LINGUA_CONFIG_KEY 那一行；重启 API 后 GET /vault/status 应报 keychain"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
