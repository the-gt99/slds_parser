#!/usr/bin/env python3
import collections
import json
import os
from pathlib import Path
import sqlite3

d = Path('/var/www/u0347517/data/media-migration')
rows = json.loads((d/'public-media.json').read_text())
c = sqlite3.connect('file:'+str(d/'manifest.sqlite3')+'?mode=ro',uri=True)
groups = collections.defaultdict(list)
size = collections.Counter()
for path, category in rows.items():
    info = os.stat(path)
    row = c.execute('SELECT size_bytes,mtime_ns,status FROM media_map WHERE source_path=?',(path,)).fetchone()
    if row and row == (info.st_size,info.st_mtime_ns,'uploaded_verified'):
        continue
    groups[category].append(path)
    size[category] += info.st_size
for category, paths in groups.items():
    (d/('public-'+category+'.list')).write_text('\n'.join(paths)+'\n')
report = {k:{'files':len(v),'bytes':size[k]} for k,v in groups.items()}
(d/'public-upload-plan.json').write_text(json.dumps(report,indent=2))
print(json.dumps(report))
