import argparse
import json
from pathlib import Path

from domain.desktop_migrations import upgrade_database


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("database", type=Path)
    parser.add_argument("--backups", type=Path, required=True)
    args = parser.parse_args()
    print(json.dumps(upgrade_database(args.database, args.backups), ensure_ascii=False))


if __name__ == "__main__":
    main()
