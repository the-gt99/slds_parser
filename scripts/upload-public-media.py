#!/usr/bin/env python3
import json
from pathlib import Path
import subprocess

d=Path('/var/www/u0347517/data/media-migration')
plan=json.loads((d/'public-upload-plan.json').read_text())
for category in plan:
    print(json.dumps({'phase':'category','category':category,**plan[category]}),flush=True)
    subprocess.run(['/usr/bin/python3',str(d/'migrate-media-s3-public.py'),'--source-list',str(d/('public-'+category+'.list')),'--manifest',str(d/'manifest.sqlite3'),'--category',category,'--workers','16','--chunk-size','300'],check=True)
print(json.dumps({'phase':'done'}),flush=True)
