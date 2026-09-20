#!/usr/bin/env python3
"""Small storefront smoke sample; no WordPress writes."""
import argparse
import hashlib
import html
import json
import re
import time
import urllib.request
from pathlib import Path

p = argparse.ArgumentParser()
p.add_argument('phase', choices=['before', 'after'])
p.add_argument('--directory', required=True)
a = p.parse_args()
directory = Path(a.directory)
directory.mkdir(exist_ok=True, mode=0o700)
base = 'https://slamdunk.shop'

def fetch(url, method='GET', headers=None):
    request = urllib.request.Request(url, method=method, headers=headers or {})
    started = time.monotonic()
    with urllib.request.urlopen(request, timeout=30) as response:
        body = response.read() if method == 'GET' else b''
        return body, response.status, dict(response.headers), round(time.monotonic()-started, 3)

if a.phase == 'before':
    urls = [base+'/shop/', base+'/shop/muzhskoe/obuv-m/krossovki-mens/',
            base+'/shop/muzhskoe/obuv-m/krossovki-mens/krossovki-nike-comme-des-garcons-x-air-force-1-07-mid-dinosaur/',
            base+'/shop/muzhskoe/obuv-m/krossovki-mens/jordan-pro-rx-lakers-cq6116-105/']
    catalog = fetch(urls[1])[0].decode('utf-8', errors='replace')
    for link in re.findall(r'href=[\"\']([^\"\']+)', catalog):
        link = html.unescape(link)
        if link.startswith('/shop/'):
            link = base+link
        if link.startswith(base+'/shop/') and link.count('/') >= 8 and '?' not in link and link not in urls:
            urls.append(link)
        if len(urls) >= 12:
            break
    (directory/'urls.json').write_text(json.dumps(urls))
else:
    urls = json.loads((directory/'urls.json').read_text())

report = []
cdn = set()
for number, url in enumerate(urls):
    try:
        body, code, headers, seconds = fetch(url)
        (directory/(a.phase+'-'+str(number)+'.html')).write_bytes(body)
        text = body.decode('utf-8', errors='replace').replace('\\/', '/')
        images = set(re.findall(r'https://cdn\.slamdunk\.shop/products/[a-z0-9/._-]+', text))
        cdn.update(images)
        record = {'url': url, 'http': code, 'seconds': seconds, 'bytes': len(body),
                  'cdn_unique': len(images), 'local_references': text.count('/wp-content/uploads/'),
                  'last_modified': headers.get('Last-Modified')}
    except Exception as error:
        record = {'url': url, 'error': str(error)}
    report.append(record)
    print(json.dumps(record), flush=True)

if a.phase == 'after':
    image_report = []
    for url in sorted(cdn)[:80]:
        try:
            _, code, headers, seconds = fetch(url, 'HEAD')
            image_report.append({'url': url, 'http': code, 'type': headers.get('content-type', headers.get('Content-Type', ''))})
        except Exception as error:
            image_report.append({'url': url, 'error': str(error)})
    (directory/'image-report.json').write_text(json.dumps(image_report))
    failures = [r for r in image_report if r.get('http') != 200 or not r.get('type','').startswith('image/')]
    print(json.dumps({'cdn_checked': len(image_report), 'cdn_failures': len(failures)}), flush=True)
(directory/(a.phase+'.json')).write_text(json.dumps(report, indent=2))
