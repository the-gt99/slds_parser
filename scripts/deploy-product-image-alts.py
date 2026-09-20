import os
import shutil
import subprocess
import time
from pathlib import Path

root = Path('/var/www/u0347517/data/www/slamdunk.shop')
stage = Path('/var/www/u0347517/data/media-migration')
backup = stage / ('product-alts-backup-' + time.strftime('%Y%m%d-%H%M%S'))
backup.mkdir(mode=0o700)
runtime = root / 'wp-content/mu-plugins/slds-media-cdn/runtime.php'
plugin = root / 'wp-content/mu-plugins/slds-cdn-canary.php'
gallery = root / 'wp-content/themes/slds/single_product/prepare_images.php'
cards = root / 'wp-content/themes/slds/standalone_catalog/lib/render/catalog-v3/cards.php'
originals = {p: p.read_bytes() for p in [runtime, plugin, gallery, cards]}
changes = {runtime: (stage / 'alt-runtime.php').read_bytes(), plugin: (stage / 'alt-plugin.php').read_bytes()}

def replace(data, old, new, count):
    assert data.count(old) == count, (old, data.count(old))
    return data.replace(old, new)

changes[gallery] = replace(originals[gallery], b'$guid = slds_cdn_canary_rewrite_standalone_url($guid);', b'// Keep the original filename until the shared HTML renderer adds alt and CDN URLs.', 1)
data = originals[cards]
data = replace(data, b"'alt' => (string) ($variant['title'] ?? ($variant['name'] ?? $fallbackAlt)),", b"'alt' => slds_media_filename_alt($src) ?: (string) ($variant['title'] ?? ($variant['name'] ?? $fallbackAlt)),", 1)
data = replace(data, b"'alt'        => $title,", b"'alt'        => slds_media_filename_alt($mainVariantImage) ?: $title,", 2)
newline = b'\r\n' if b'\r\n' in data else b'\n'
old = b"'src' => $src," + newline + b"\t\t\t\t\t'alt' => $title,"
new = b"'src' => $src," + newline + b"\t\t\t\t\t'alt' => slds_media_filename_alt($src) ?: $title,"
data = replace(data, old, new, 1)
changes[cards] = data

staged = {}
for index, (path, content) in enumerate(changes.items()):
    shutil.copy2(path, backup / (str(index) + '-' + path.name))
    candidate = path.with_name(path.name + '.alt-staged')
    candidate.write_bytes(content)
    stat = path.stat()
    os.chown(candidate, stat.st_uid, stat.st_gid)
    os.chmod(candidate, stat.st_mode & 0o777)
    subprocess.run(['/opt/php74/bin/php', '-l', str(candidate)], check=True)
    staged[path] = candidate
for path in changes:
    assert path.read_bytes() == originals[path], str(path)
for path, candidate in staged.items():
    os.replace(candidate, path)
os.utime('/var/www/u0347517/data/media-cdn/products.sqlite3', None)
print('Installed product image alts; backup:', backup)
