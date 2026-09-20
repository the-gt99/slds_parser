#!/usr/bin/env python3
"""Separate missing content from unmapped copies using the verified upload manifest."""
import hashlib
import json
from pathlib import Path
import sqlite3
import sys

d = Path(sys.argv[1])
c = sqlite3.connect('file:/var/www/u0347517/data/media-migration/manifest.sqlite3?mode=ro',uri=True)
stats = {'pending_paths':0,'already_uploaded_content_paths':0,'new_content_paths':0,'new_unique_objects':0,'new_unique_bytes':0,'unstable_paths':0}
seen = set()
with (d/'pending.jsonl').open() as source, (d/'pending-content.jsonl').open('w') as output:
    for line in source:
        record = json.loads(line)
        path = Path(record['path'])
        try:
            before = path.stat()
            digest = hashlib.sha256()
            with path.open('rb') as image:
                for block in iter(lambda:image.read(1024*1024), b''):
                    digest.update(block)
            after = path.stat()
        except FileNotFoundError:
            stats['unstable_paths'] += 1
            continue
        if (before.st_size,before.st_mtime_ns) != (after.st_size,after.st_mtime_ns):
            stats['unstable_paths'] += 1
            continue
        stats['pending_paths'] += 1
        value = digest.hexdigest()
        uploaded = c.execute("SELECT object_key FROM media_map INDEXED BY media_map_hash_idx WHERE content_hash=? AND status='uploaded_verified' LIMIT 1",(value,)).fetchone()
        if uploaded:
            stats['already_uploaded_content_paths'] += 1
        else:
            stats['new_content_paths'] += 1
            if value not in seen:
                seen.add(value)
                stats['new_unique_objects'] += 1
                stats['new_unique_bytes'] += after.st_size
        output.write(json.dumps({**record,'hash':value,'existing_object':uploaded[0] if uploaded else None},ensure_ascii=False)+'\n')
        if stats['pending_paths'] % 10000 == 0:
            print(json.dumps(stats),flush=True)
(d/'hash-report.json').write_text(json.dumps(stats,indent=2))
print(json.dumps({'phase':'done',**stats}),flush=True)
