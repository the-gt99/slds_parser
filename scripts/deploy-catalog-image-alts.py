from pathlib import Path
import shutil
import hashlib
import os
import time

path = Path('/var/www/u0347517/data/www/slamdunk.shop/wp-content/themes/slds/js/catalog-client/render.js')
original = path.read_bytes()
data = original
def replace(old, new):
    global data
    assert data.count(old) == 1, old
    data = data.replace(old, new)
replace(b'        imgUrl(path) {', b'''        imageAlt(path, title = '') {
            const name = String(path || '').split(/[?#]/)[0].split('/').pop();
            if (!name || !/\\.(avif|bmp|gif|jpe?g|png|svg|tiff?|webp)$/i.test(name)) return title;
            return decodeURIComponent(name).replace(/\\.[^.]+$/, '');
        },
        imgUrl(path) {''')
replace(b'alt="${titleEsc}">${thumbLinkClose}', b'alt="${Render.Helpers.esc(Render.Helpers.imageAlt(src, d.title))}">${thumbLinkClose}')
replace(b'alt="${Render.Helpers.esc(title)}">', b'alt="${Render.Helpers.esc(Render.Helpers.imageAlt(thumbnail_img, title))}">')
replace(b'alt="${alt}"></div>`;', b'alt="${Render.Helpers.esc(Render.Helpers.imageAlt(src, alt))}"></div>`;')
backup = Path('/var/www/u0347517/data/media-migration') / ('catalog-alt-' + time.strftime('%Y%m%d-%H%M%S') + '.js')
shutil.copy2(path, backup)
stage = path.with_name('render.alt-staged.js')
stage.write_bytes(data)
# This exact staged source passed node --check on the deployment workstation.
assert hashlib.sha256(data).hexdigest() == 'cc32a6616b91c6a331ae9b0beb1b29904c452b867f3e9f141cb4fd078ab3ca82'
stat = path.stat()
os.chown(stage, stat.st_uid, stat.st_gid)
os.chmod(stage, stat.st_mode & 0o777)
assert path.read_bytes() == original
os.replace(stage, path)
os.utime('/var/www/u0347517/data/media-cdn/products.sqlite3', None)
print('Catalog image alts installed; backup:', backup)
