#!/usr/bin/env python3
"""Read-only product media audit. Writes only new inventory and report artifacts."""
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import time

base = Path('/var/www/u0347517/data/media-migration')
directory = base / ('pending-audit-' + time.strftime('%Y%m%d-%H%M%S'))
directory.mkdir(mode=0o700)
site = '/var/www/u0347517/data/www/slamdunk.shop'
raw = directory / 'current.raw.list'
unique = directory / 'current.list'
print(json.dumps({'phase': 'inventory', 'directory': str(directory)}), flush=True)
subprocess.run(['/usr/bin/php', '-d', 'memory_limit=768M', str(base/'build-wordpress-product-media-list.php'), site, site+'/wp-content/uploads', str(raw)], check=True)
with unique.open('wb') as out:
    subprocess.run(['sort', '-u', '-S', '128M', str(raw)], stdout=out, env={**os.environ, 'LC_ALL':'C'}, check=True)
c = sqlite3.connect('file:'+str(base/'manifest.sqlite3')+'?mode=ro', uri=True)
cursor = iter(c.execute("SELECT source_path,size_bytes,mtime_ns FROM media_map WHERE status='uploaded_verified' ORDER BY source_path"))
row = next(cursor, None)
stats = {'current_files':0,'verified_unchanged':0,'unmapped_files':0,'unmapped_bytes':0,'changed_files':0,'changed_bytes':0,'vanished_during_audit':0}
with unique.open() as source, (directory/'pending.jsonl').open('w') as pending:
    for line in source:
        path = line.rstrip('\n')
        try:
            info = os.stat(path)
        except FileNotFoundError:
            stats['vanished_during_audit'] += 1
            continue
        stats['current_files'] += 1
        while row is not None and row[0] < path:
            row = next(cursor, None)
        if row is None or row[0] != path:
            category = 'unmapped'
        elif row[1] != info.st_size or row[2] != info.st_mtime_ns:
            category = 'changed'
        else:
            stats['verified_unchanged'] += 1
            category = None
        if category:
            stats[category+'_files'] += 1
            stats[category+'_bytes'] += info.st_size
            pending.write(json.dumps({'path':path,'bytes':info.st_size,'reason':category},ensure_ascii=False)+'\n')
        if stats['current_files'] % 500000 == 0:
            print(json.dumps({'phase':'compare',**stats}),flush=True)
stats['pending_files'] = stats['unmapped_files'] + stats['changed_files']
stats['pending_bytes'] = stats['unmapped_bytes'] + stats['changed_bytes']
(directory/'report.json').write_text(json.dumps(stats,indent=2))
print(json.dumps({'phase':'done',**stats}),flush=True)
