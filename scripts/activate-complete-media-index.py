#!/usr/bin/env python3
"""Verify the requested upload lists and atomically replace the serving index."""
import grp
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import time

d=Path('/var/www/u0347517/data/media-migration')
for unit in ['slds-upload-remaining-products','slds-upload-public-media']:
    active=subprocess.check_output(['systemctl','show',unit,'-p','ActiveState','--value'],text=True).strip()
    result=subprocess.check_output(['systemctl','show',unit,'-p','Result','--value'],text=True).strip()
    if active!='inactive' or result!='success':
        raise SystemExit('Upload is not successfully finished: '+unit)
paths=set((d/'pending-audit-20260911-110406/upload.list').read_text().splitlines())
plan=json.loads((d/'public-upload-plan.json').read_text())
for category in plan:
    paths.update((d/('public-'+category+'.list')).read_text().splitlines())
c=sqlite3.connect('file:'+str(d/'manifest.sqlite3')+'?mode=ro',uri=True)
errors=[]
for path in sorted(paths):
    st=os.stat(path)
    row=c.execute('SELECT size_bytes,mtime_ns,status FROM media_map WHERE source_path=?',(path,)).fetchone()
    if row!=(st.st_size,st.st_mtime_ns,'uploaded_verified'):
        errors.append(path)
if errors:
    (d/'media-activation-errors.json').write_text(json.dumps(errors))
    raise SystemExit('Unverified or changed files: '+str(len(errors)))
c.close()
folder=Path('/var/www/u0347517/data/media-cdn')
stamp=time.strftime('%Y%m%d-%H%M%S')
temporary=folder/('all-media-'+stamp+'.build.sqlite3')
subprocess.run(['/usr/bin/python3',str(d/'build-wordpress-cdn-index.py'),'--manifest',str(d/'manifest.sqlite3'),'--uploads-root','/var/www/u0347517/data/www/slamdunk.shop/wp-content/uploads','--output',str(temporary),'--all-categories'],check=True)
os.chown(temporary,0,grp.getgrnam('u0347517').gr_gid)
os.chmod(temporary,0o640)
backup=folder/('products-before-'+stamp+'.sqlite3')
os.link(folder/'products.sqlite3',backup)
os.replace(temporary,folder/'products.sqlite3')
report={'verified_requested_paths':len(paths),'unverified_paths':0,'previous_index':str(backup),'activated_at':stamp}
(d/'complete-media-activation.json').write_text(json.dumps(report,indent=2))
print(json.dumps(report),flush=True)
