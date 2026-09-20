"""Prepare the reviewed CDN integration in an isolated WordPress worktree."""
from pathlib import Path
import subprocess
import shutil

root = Path('/var/www/u0347517/data/media-migration/cdn-recovery-worktree')
stage = root.parent
theme = root / 'wp-content/themes/slds'
mu = root / 'wp-content/mu-plugins'
(mu / 'slds-media-cdn').mkdir(parents=True, exist_ok=True)
shutil.copyfile(stage / 'alt-runtime.php', mu / 'slds-media-cdn/runtime.php')
shutil.copyfile(stage / 'alt-plugin.php', mu / 'slds-cdn-canary.php')
shutil.copyfile(stage / 'alt-test.php', mu / 'slds-media-cdn/runtime.test.php')

def patch(path, replacements):
    data = path.read_bytes()
    for old, new, count in replacements:
        assert data.count(old) == count, (str(path), old, data.count(old))
        data = data.replace(old, new)
    path.write_bytes(data)

patch(theme / 'custom_index.php', [(b'<?php\n', b"<?php\nrequire_once __DIR__ . '/../../mu-plugins/slds-media-cdn/runtime.php';\nslds_media_cdn_start();\n", 1)])
patch(theme / 'functions.php', [(br"'/^https?:\/\/[^\/]+/'", br"'/^https?:\/\/(?!cdn\.slamdunk\.shop(?:\/|$))[^\/]+/'", 6)])
path = theme / 'standalone_catalog/lib/http-cache.php'
newline = b'\r\n' if b'\r\n' in path.read_bytes() else b'\n'
patch(path, [(sig, sig + newline + b"    if (function_exists('slds_media_cdn_epoch')) { $ts = max($ts, slds_media_cdn_epoch()); }", 1) for sig in [b'function scv3_http_apply_last_modified_header( int $ts ): void {', b'function scv3_http_handle_if_modified_since( int $ts , bool $is_single_product = false): bool {']])
path = theme / 'standalone_catalog/lib/render/catalog-v3/cards.php'
newline = b'\r\n' if b'\r\n' in path.read_bytes() else b'\n'
patch(path, [
    (b"'alt' => (string) ($variant['title'] ?? ($variant['name'] ?? $fallbackAlt)),", b"'alt' => slds_media_filename_alt($src) ?: (string) ($variant['title'] ?? ($variant['name'] ?? $fallbackAlt)),", 1),
    (b"'alt'        => $title,", b"'alt'        => slds_media_filename_alt($mainVariantImage) ?: $title,", 2),
    (b"'src' => $src," + newline + b"\t\t\t\t\t'alt' => $title,", b"'src' => $src," + newline + b"\t\t\t\t\t'alt' => slds_media_filename_alt($src) ?: $title,", 1),
])
path = theme / 'js/catalog-client/render.js'
patch(path, [
    (b'        imgUrl(path) {', b'''        imageAlt(path, title = '') {
            const name = String(path || '').split(/[?#]/)[0].split('/').pop();
            if (!name || !/\\.(avif|bmp|gif|jpe?g|png|svg|tiff?|webp)$/i.test(name)) return title;
            return decodeURIComponent(name).replace(/\\.[^.]+$/, '');
        },
        imgUrl(path) {''', 1),
    (b'alt="${titleEsc}">${thumbLinkClose}', b'alt="${Render.Helpers.esc(Render.Helpers.imageAlt(src, d.title))}">${thumbLinkClose}', 1),
    (b'alt="${Render.Helpers.esc(title)}">', b'alt="${Render.Helpers.esc(Render.Helpers.imageAlt(thumbnail_img, title))}">', 1),
    (b'alt="${alt}"></div>`;', b'alt="${Render.Helpers.esc(Render.Helpers.imageAlt(src, alt))}"></div>`;', 1),
])
paths = subprocess.check_output(['git', 'diff', '--name-only', '1ec41321'], cwd=root, text=True).splitlines()
paths += ['wp-content/mu-plugins/slds-cdn-canary.php', 'wp-content/mu-plugins/slds-media-cdn/runtime.php', 'wp-content/mu-plugins/slds-media-cdn/runtime.test.php']
for name in paths:
    if name.endswith('.php'):
        subprocess.run(['/opt/php74/bin/php', '-l', str(root / name)], check=True)
print('Prepared CDN recovery without changing the live site')
