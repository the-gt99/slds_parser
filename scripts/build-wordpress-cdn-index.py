#!/usr/bin/env python3
"""Build a read-only serving index from verified product uploads."""
import argparse
import json
import os
import sqlite3
import time

p = argparse.ArgumentParser()
p.add_argument('--manifest', required=True)
p.add_argument('--uploads-root', required=True)
p.add_argument('--output', required=True)
p.add_argument('--all-categories', action='store_true', help='Include all verified public uploads categories')
a = p.parse_args()
root = a.uploads_root.rstrip('/') + '/'
source = sqlite3.connect('file:' + a.manifest + '?mode=ro', uri=True)
if os.path.exists(a.output):
    raise SystemExit('Output already exists')
target = sqlite3.connect(a.output)
target.execute('PRAGMA journal_mode=OFF')
target.execute('PRAGMA synchronous=OFF')
target.execute('CREATE TABLE images (path TEXT PRIMARY KEY, object_key TEXT NOT NULL, size_bytes INTEGER NOT NULL, mtime INTEGER NOT NULL) WITHOUT ROWID')
count = 0
started = time.time()
category_filter = '' if a.all_categories else " AND object_key LIKE 'products/%'"
rows = source.execute("SELECT source_path,object_key,size_bytes,mtime_ns FROM media_map WHERE status='uploaded_verified'" + category_filter + " ORDER BY source_path")
while True:
    batch = rows.fetchmany(10000)
    if not batch:
        break
    selected = [(path[len(root):], key, size, ns // 1000000000)
                for path, key, size, ns in batch if path.startswith(root)]
    target.executemany('INSERT INTO images VALUES (?,?,?,?)', selected)
    target.commit()
    count += len(selected)
    if count and count % 500000 == 0:
        print(json.dumps({'indexed': count, 'seconds': round(time.time()-started)}), flush=True)
assert target.execute('PRAGMA quick_check').fetchone()[0] == 'ok'
target.close()
source.close()
print(json.dumps({'indexed': count, 'bytes': os.path.getsize(a.output), 'seconds': round(time.time()-started)}), flush=True)
