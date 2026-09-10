"""统一学习记录词名并合并大小写重复记录。"""

import sqlalchemy as sa
from alembic import op

revision = "c9d0e1f2a3b4"
down_revision = "b8c9d0e1f2a3"
branch_labels = None
depends_on = None


def upgrade():
    bind = op.get_bind()
    metadata = sa.MetaData()
    vocab = sa.Table("vocab_entry", metadata, autoload_with=bind)
    log = sa.Table("review_log", metadata, autoload_with=bind)
    occurrence = sa.Table("vocab_occurrence", metadata, autoload_with=bind)
    groups = {}
    for row in bind.execute(sa.select(vocab)).mappings():
        groups.setdefault((row["user_id"], row["word"].strip().lower()), []).append(dict(row))
    for (_, word), rows in groups.items():
        if len(rows) == 1:
            if rows[0]["word"] != word:
                bind.execute(vocab.update().where(vocab.c.id == rows[0]["id"]).values(word=word))
            continue
        target = next((row for row in rows if row["word"] == word), rows[0])
        ids = [row["id"] for row in rows if row["id"] != target["id"]]
        marked = max(rows, key=lambda row: (str(row["marked_at"] or ""), row["id"]))
        scheduled = max(
            rows,
            key=lambda row: (bool(row["fsrs_card"]), str(row["last_review_at"] or ""), row["id"]),
        )
        values = {
            key: scheduled[key] for key in ["fsrs_card", "due_at", "last_review_at", "status"]
        }
        values.update(
            mark=marked["mark"],
            marked_at=marked["marked_at"],
            exposures=sum(row["exposures"] or 0 for row in rows),
        )
        for key in ["last_seen_at", "self_test_at"]:
            values[key] = max((row[key] for row in rows if row[key]), default=None)
        values["created_at"] = min(row["created_at"] for row in rows)
        bind.execute(vocab.update().where(vocab.c.id == target["id"]).values(**values))
        bind.execute(log.update().where(log.c.vocab_id.in_(ids)).values(vocab_id=target["id"]))
        fingerprints = set(
            bind.execute(
                sa.select(occurrence.c.source_fingerprint).where(
                    occurrence.c.vocab_id == target["id"]
                )
            ).scalars()
        )
        for item in bind.execute(
            sa.select(occurrence).where(occurrence.c.vocab_id.in_(ids))
        ).mappings():
            if item["source_fingerprint"] in fingerprints:
                bind.execute(occurrence.delete().where(occurrence.c.id == item["id"]))
            else:
                bind.execute(
                    occurrence.update()
                    .where(occurrence.c.id == item["id"])
                    .values(vocab_id=target["id"])
                )
                fingerprints.add(item["source_fingerprint"])
        bind.execute(vocab.delete().where(vocab.c.id.in_(ids)))
        bind.execute(vocab.update().where(vocab.c.id == target["id"]).values(word=word))


def downgrade():
    # 合并前的词名与行归属只能从迁移备份恢复。
    pass
