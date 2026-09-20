#!/usr/bin/env python3
import collections
import html
import json
from pathlib import Path
import re
import sqlite3
import urllib.parse

d = Path('/var/www/u0347517/data/media-migration/cdn-smoke-20260911')
c = sqlite3.connect('file:/var/www/u0347517/data/media-cdn/products.sqlite3?mode=ro', uri=True)
paths = set()
for file in d.glob('after-*.html'):
    text = file.read_text(errors='replace').replace('\\/', '/')
    for path in re.findall(r'/wp-content/uploads/[^\s\"\'<>),]+', text):
        paths.add(urllib.parse.unquote(urllib.parse.urlsplit(html.unescape(path)).path[len('/wp-content/uploads/'):]))
reasons = collections.Counter()
for path in paths:
    row = c.execute('SELECT size_bytes,mtime FROM images WHERE path=?', (path,)).fetchone()
    if not row:
        reasons['not_in_verified_product_index'] += 1
        continue
    local = Path('/var/www/u0347517/data/www/slamdunk.shop/wp-content/uploads') / path
    if not local.is_file():
        reasons['local_missing'] += 1
    else:
        stat = local.stat()
        if (stat.st_size, int(stat.st_mtime)) != row:
            reasons['changed_since_upload'] += 1
        else:
            reasons['verified_but_not_rewritten'] += 1
print(json.dumps({'remaining_unique_local_paths':len(paths),'reasons':dict(reasons)}))
