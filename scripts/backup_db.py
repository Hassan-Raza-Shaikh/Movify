"""
Portable DB backup/restore (no pg_dump needed) — dumps every table to a gzipped
JSON file under backups/. Works against the Neon Postgres in .env (DATABASE_URL).

  Backup:   python -m scripts.backup_db
  Restore:  python -m scripts.backup_db --restore backups/nautilus_YYYYMMDD_HHMMSS.json.gz

Restore inserts in FK-safe order and skips rows whose primary key already exists,
so it's safe to run against a partially-populated DB.
"""
import os
import sys
import json
import gzip
import argparse
import datetime
from dotenv import load_dotenv
from sqlalchemy import create_engine, MetaData, select

load_dotenv()
DATABASE_URL = os.getenv("DATABASE_URL")

# Parent-before-child so foreign keys resolve on restore.
TABLE_ORDER = ["users", "movies", "tv_shows", "seasons", "episodes",
               "interactions", "ml_models", "system_logs"]


def _engine():
    if not DATABASE_URL:
        sys.exit("No DATABASE_URL in .env")
    return create_engine(DATABASE_URL)


def backup():
    engine = _engine()
    meta = MetaData()
    meta.reflect(bind=engine)
    names = [t for t in TABLE_ORDER if t in meta.tables] + \
            [t for t in meta.tables if t not in TABLE_ORDER]

    payload = {"_meta": {"created": datetime.datetime.utcnow().isoformat() + "Z",
                         "database": DATABASE_URL.split("@")[-1].split("/")[0]}}
    total = 0
    with engine.connect() as conn:
        for name in names:
            table = meta.tables[name]
            rows = [dict(r._mapping) for r in conn.execute(select(table))]
            payload[name] = rows
            total += len(rows)
            print(f"  {name:14} {len(rows):>7} rows")

    os.makedirs("backups", exist_ok=True)
    stamp = datetime.datetime.utcnow().strftime("%Y%m%d_%H%M%S")
    path = os.path.join("backups", f"nautilus_{stamp}.json.gz")
    with gzip.open(path, "wt", encoding="utf-8") as f:
        json.dump(payload, f, default=str, ensure_ascii=False)
    size = os.path.getsize(path) / 1024
    print(f"\n[backup] {total} rows -> {path} ({size:.0f} KB)")
    return path


def restore(path):
    engine = _engine()
    meta = MetaData()
    meta.reflect(bind=engine)
    with gzip.open(path, "rt", encoding="utf-8") as f:
        data = json.load(f)

    names = [t for t in TABLE_ORDER if t in data and t in meta.tables]
    with engine.begin() as conn:
        for name in names:
            table = meta.tables[name]
            rows = data.get(name) or []
            if not rows:
                continue
            pk = list(table.primary_key.columns)[0].name if table.primary_key.columns else None
            existing = set()
            if pk:
                existing = {r[0] for r in conn.execute(select(table.c[pk]))}
            new_rows = [r for r in rows if not (pk and r.get(pk) in existing)]
            if new_rows:
                conn.execute(table.insert(), new_rows)
            print(f"  {name:14} +{len(new_rows)} (skipped {len(rows) - len(new_rows)} existing)")
    print(f"\n[restore] done from {path}")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--restore", metavar="FILE", help="restore from a backup file instead of backing up")
    args = ap.parse_args()
    if args.restore:
        restore(args.restore)
    else:
        backup()
