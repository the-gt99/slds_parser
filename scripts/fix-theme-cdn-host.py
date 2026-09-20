#!/usr/bin/env python3
"""Preserve the trusted CDN host in existing theme image normalization filters."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import time

path=Path('/var/www/u0347517/data/www/slamdunk.shop/wp-content/themes/slds/functions.php')
before=path.read_bytes()
old=br"'/^https?:\/\/[^\/]+/'"
new=br"'/^https?:\/\/(?!cdn\.slamdunk\.shop(?:\/|$))[^\/]+/'"
assert before.count(old)==6, 'Unexpected theme filter definitions'
after=before.replace(old,new)
d=Path('/var/www/u0347517/data/media-migration')/('theme-cdn-host-'+time.strftime('%Y%m%d-%H%M%S'))
d.mkdir(mode=0o700)
(d/'functions.before').write_bytes(before)
(d/'functions.php').write_bytes(after)
subprocess.run(['/opt/php74/bin/php','-l',str(d/'functions.php')],check=True)
assert path.read_bytes()==before, 'Concurrent theme edit'
temporary=path.with_name('functions.php.cdn-new')
temporary.write_bytes(after)
st=path.stat()
os.chown(temporary,st.st_uid,st.st_gid)
os.chmod(temporary,st.st_mode & 0o777)
os.replace(temporary,path)
(d/'manifest.json').write_text(json.dumps({'path':str(path),'before':hashlib.sha256(before).hexdigest(),'after':hashlib.sha256(after).hexdigest()},indent=2))
print(json.dumps({'changed_regexes':6,'backup':str(d)}))
