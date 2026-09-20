#!/usr/bin/env python3
import json
from pathlib import Path
import re
import sys
import urllib.request

d=Path('/var/www/u0347517/data/media-migration')
phase=sys.argv[1]
urls=['https://slamdunk.shop/']+json.loads((d/'public-smoke-urls.json').read_text())
report=[]
images=set()
for n,url in enumerate(urls):
    with urllib.request.urlopen(url,timeout=30) as response:
        body=response.read().decode('utf-8',errors='replace')
        (d/('public-smoke-'+phase+'-'+str(n)+'.html')).write_text(body)
        cdn=set(re.findall(r'https://cdn\.slamdunk\.shop/(?:products|content|categories|brands|banners)/[a-z0-9/._-]+',body.replace('\\/','/')))
        images.update(cdn)
        wrong = re.findall(r'https://slamdunk\.shop/(?:products|content|categories|brands|banners)/[a-f0-9]{2}/[a-f0-9]{2}/[a-f0-9]{64}',body)
        report.append({'url':url,'http':response.status,'cdn_unique':len(cdn),'uploads_references':body.count('/wp-content/uploads/'),'wrong_origin_keys':len(wrong)})
if phase=='after':
    errors=[]
    selected=sorted(images,key=lambda u:('/products/' in u,u))[:100]
    for url in selected:
        try:
            with urllib.request.urlopen(urllib.request.Request(url,method='HEAD'),timeout=20) as r:
                if r.status!=200 or not r.headers.get('Content-Type','').startswith('image/'):
                    errors.append({'url':url,'http':r.status})
        except Exception as error:
            errors.append({'url':url,'error':str(error)})
    print(json.dumps({'images_checked':len(selected),'image_errors':len(errors)}),flush=True)
    (d/'public-smoke-image-errors.json').write_text(json.dumps(errors))
(d/('public-smoke-'+phase+'.json')).write_text(json.dumps(report,indent=2))
print(json.dumps(report),flush=True)
