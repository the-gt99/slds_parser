#!/usr/bin/env python3
"""Restore exactly this rollout, refusing to overwrite later changes."""
import hashlib
import json
import os
from pathlib import Path
import sys

snapshot = Path(sys.argv[1]).resolve()
assert snapshot.parent == Path('/var/www/u0347517/data/media-migration')
manifest = json.loads((snapshot/'manifest.json').read_text())
for item in manifest:
    path = Path(item['path'])
    assert path.is_relative_to('/var/www/u0347517/data/www/slamdunk.shop')
    assert hashlib.sha256(path.read_bytes()).hexdigest() == item['after'], 'Later edit: '+str(path)
for item in manifest:
    path = Path(item['path'])
    if item['backup'] is None:
        continue
    st = path.stat()
    temporary = path.with_name(path.name+'.cdn-restore')
    temporary.write_bytes(Path(item['backup']).read_bytes())
    os.chown(temporary, st.st_uid, st.st_gid)
    os.chmod(temporary, st.st_mode & 0o777)
    os.replace(temporary, path)
print('Restored previous storefront files; media and the unused index were retained.')
