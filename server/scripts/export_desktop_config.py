"""把开发用桌面库里的配置（凭据 / 模型部署 / 能力绑定 / 按词音色 / 设置项）导出成随包的小库。

用法（server 目录）：
    uv run python -m scripts.export_desktop_config out.sqlite3 --from ../data/desktop/nexus.sqlite3 \\
        --source-vault-key ../data/desktop/vault.key --bundle-vault-key out-vault.key

敏感字段从开发主密钥换成一把新生成的包密钥，开发主密钥不出本机；个人账号（Gmail 刷新令牌）
默认不带，`--include-personal-accounts` 才带。合并进用户库的口径见 domain/desktop_config。
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from domain.desktop_config import export_bundle


def main() -> None:
    parser = argparse.ArgumentParser(description="Export the NEXUS desktop config bundle")
    parser.add_argument("destination", type=Path)
    parser.add_argument("--from", dest="source", type=Path, required=True, help="开发用的桌面库")
    parser.add_argument(
        "--source-vault-key", type=Path, required=True, help="能解开源库凭据的主密钥文件"
    )
    parser.add_argument(
        "--bundle-vault-key", type=Path, required=True, help="新生成的包密钥写到这里"
    )
    parser.add_argument(
        "--include-personal-accounts",
        action="store_true",
        help="连个人账号（Gmail 刷新令牌）一起带",
    )
    args = parser.parse_args()
    result = export_bundle(
        args.source,
        args.source_vault_key.read_text(encoding="utf-8").strip(),
        args.destination,
        args.bundle_vault_key,
        include_personal=args.include_personal_accounts,
    )
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
