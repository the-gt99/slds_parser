#!/usr/bin/env python3
"""Deploy the shared CDN resolver with byte-preserving patches and rollback snapshots."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import time

site = Path('/var/www/u0347517/data/www/slamdunk.shop')
stage = Path('/var/www/u0347517/data/media-migration')
theme = site / 'wp-content/themes/slds'
mu = site / 'wp-content/mu-plugins'
snapshot = stage / ('cdn-rollout-' + time.strftime('%Y%m%d-%H%M%S'))
index = Path('/var/www/u0347517/data/media-cdn/products.sqlite3')
assert index.exists()
assert not (mu / 'slds-media-cdn/runtime.php').exists()
php = '/opt/php74/bin/php'
changes = {}
custom = theme / 'custom_index.php'
data = custom.read_bytes()
assert data.startswith(b'<?php\n')
changes[custom] = data.replace(b'<?php\n', b"<?php\nrequire_once __DIR__ . '/../../mu-plugins/slds-media-cdn/runtime.php';\nslds_media_cdn_start();\n", 1)
cache = theme / 'standalone_catalog/lib/http-cache.php'
data = cache.read_bytes()
for signature in [b'function scv3_http_apply_last_modified_header( int $ts ): void {', b'function scv3_http_handle_if_modified_since( int $ts , bool $is_single_product = false): bool {']:
    assert data.count(signature) == 1
    newline = b'\r\n' if b'\r\n' in data else b'\n'
    data = data.replace(signature, signature + newline + b"    if (function_exists('slds_media_cdn_epoch')) { $ts = max($ts, slds_media_cdn_epoch()); }")
changes[cache] = data
changes[mu / 'slds-media-cdn/runtime.php'] = (stage / 'wordpress-cdn-runtime.php').read_bytes()
changes[mu / 'slds-cdn-canary.php'] = (stage / 'wordpress-cdn-plugin.php').read_bytes()
changes[theme / 'single_product/cdn-canary.php'] = b"<?php\nrequire_once dirname(__DIR__, 3) . '/mu-plugins/slds-media-cdn/runtime.php';\n"
snapshot.mkdir(mode=0o700)
manifest = []
for number, (path, content) in enumerate(changes.items()):
    before = path.read_bytes() if path.exists() else None
    backup = snapshot / (str(number) + '.before')
    if before is not None:
        backup.write_bytes(before)
    staged = snapshot / (str(number) + '.php')
    staged.write_bytes(content)
    subprocess.run([php, '-l', str(staged)], check=True, stdout=subprocess.DEVNULL)
    manifest.append({'path': str(path), 'backup': str(backup) if before is not None else None,
                     'before': hashlib.sha256(before).hexdigest() if before is not None else None,
                     'after': hashlib.sha256(content).hexdigest()})
(snapshot / 'manifest.json').write_text(json.dumps(manifest, indent=2))
# Publish the shared runtime first, then switch its callers.
order = [mu / 'slds-media-cdn/runtime.php', theme / 'single_product/cdn-canary.php', mu / 'slds-cdn-canary.php', custom, cache]
for path in order:
    entry = next(item for item in manifest if item['path'] == str(path))
    if entry['before'] is not None:
        assert hashlib.sha256(path.read_bytes()).hexdigest() == entry['before'], 'Concurrent edit: ' + str(path)
    path.parent.mkdir(exist_ok=True, mode=0o755)
    temporary = path.with_name(path.name + '.cdn-new')
    temporary.write_bytes(changes[path])
    if path.exists():
        st = path.stat()
        os.chown(temporary, st.st_uid, st.st_gid)
        os.chmod(temporary, st.st_mode & 0o777)
    else:
        os.chmod(temporary, 0o644)
    os.replace(temporary, path)
print(json.dumps({'snapshot': str(snapshot), 'changed_files': len(changes)}))
