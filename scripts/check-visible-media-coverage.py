#!/usr/bin/env python3
import html
import json
from pathlib import Path
import re
import sqlite3
from urllib.parse import unquote,urlsplit

d=Path('/var/www/u0347517/data/media-migration')
root=Path('/var/www/u0347517/data/www/slamdunk.shop/wp-content/uploads')
c=sqlite3.connect('file:'+str(d/'manifest.sqlite3')+'?mode=ro',uri=True)
queued=set()
for category in json.loads((d/'public-upload-plan.json').read_text()):
    queued.update((d/('public-'+category+'.list')).read_text().splitlines())
extra=set()
for file in d.glob('public-smoke-before-*.html'):
    text=html.unescape(file.read_text().replace('\\/','/'))
    for relative in re.findall(r'/wp-content/uploads/[^\s\"\'<>),]+',text):
        relative=unquote(urlsplit(relative).path[len('/wp-content/uploads/'):])
        path=str(root/relative)
        if Path(path).suffix.lower() not in {'.avif','.bmp','.gif','.ico','.jpeg','.jpg','.png','.svg','.tif','.tiff','.webp'}:
            continue
        if path in queued or not Path(path).is_file():
            continue
        row=c.execute("SELECT status FROM media_map WHERE source_path=?",(path,)).fetchone()
        if not row or row[0]!='uploaded_verified':
            extra.add(path)
(d/'visible-extra.list').write_text('\n'.join(sorted(extra))+ ('\n' if extra else ''))
print(json.dumps({'extra_public_files':len(extra),'bytes':sum(Path(p).stat().st_size for p in extra)}))
