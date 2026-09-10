from __future__ import annotations

import argparse
import json
from pathlib import Path

from domain.grammar_library import import_markdown_tree


def main() -> None:
    parser = argparse.ArgumentParser(description="Import a Markdown lecture library into NEXUS")
    parser.add_argument("source", type=Path)
    parser.add_argument("target", type=Path)
    args = parser.parse_args()
    print(
        json.dumps(
            import_markdown_tree(args.source, args.target).view(),
            ensure_ascii=False,
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
