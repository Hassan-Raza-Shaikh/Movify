"""Analyze vidsrc.cc embed.min.js for API calls."""
import urllib.request, ssl, re

ctx = ssl.create_default_context()
ctx.check_hostname = False
ctx.verify_mode = ssl.CERT_NONE
h = {'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
     'Referer': 'https://vidsrc.cc/'}

req = urllib.request.Request('https://vidsrc.cc/saas/js/embed.min.js?t=1770001725', headers=h)
js = urllib.request.urlopen(req, timeout=15, context=ctx).read().decode('utf-8', 'replace')

print(f"JS size: {len(js)} bytes")

# Find all string literals that look like API paths
api_paths = re.findall(r'["\'](/[a-zA-Z0-9_/]+(?:\?[^"\']*)?)["\']', js)
print("\nAPI-like paths:")
for p in sorted(set(api_paths)):
    if len(p) > 3 and not p.endswith(('.css', '.png', '.ico', '.svg', '.woff', '.woff2', '.ttf')):
        print(f"  {p}")

# Find axios/fetch/ajax calls
axios_calls = re.findall(r'axios\.(get|post)\s*\(\s*["\']([^"\']+)', js)
print("\nAxios calls:")
for method, url in set(axios_calls):
    print(f"  {method.upper()} {url}")

# Find string concatenations that build URLs
url_concat = re.findall(r'["\']https?://[^"\']+["\']', js)
print("\nFull URLs:")
for u in sorted(set(url_concat)):
    print(f"  {u}")

# Find template literals with API paths  
templates = re.findall(r'`([^`]*(?:/api/|/ajax/|/embed/|/source|/stream)[^`]*)`', js)
print("\nTemplate URLs:")
for t in sorted(set(templates)):
    print(f"  {t}")

# Find variable assignments with 'source', 'stream', 'hls', 'file' keywords
source_assigns = re.findall(r'(\w+(?:_(?:source|file|url|stream|hls|m3u8))\w*)\s*=', js, re.I)
print("\nSource-related vars:")
for v in sorted(set(source_assigns)):
    print(f"  {v}")

# Find JW Player setup calls
jw_setup = re.findall(r'jwplayer[^;]*setup\s*\(([^)]{1,500})\)', js, re.I)
print("\nJW Player setups:")
for s in jw_setup[:3]:
    print(f"  {s[:200]}")

# Find any data-hash or data-id references
data_refs = re.findall(r'data-(?:id|hash|src|key|token)\w*', js)
print("\nData attributes:", sorted(set(data_refs)))

# Search for 'source' in context
source_contexts = []
for m in re.finditer(r'.{0,60}(?:getSources?|loadSource|getStream|getVideo|getEmbed|getServer).{0,60}', js, re.I):
    source_contexts.append(m.group())
print("\nSource function contexts:")
for s in source_contexts[:10]:
    print(f"  ...{s}...")

# Find all function-like definitions
func_names = re.findall(r'(?:function\s+(\w+)|(\w+)\s*=\s*(?:async\s+)?function|\b(\w+)\s*:\s*(?:async\s+)?function)', js)
interesting = [n for grp in func_names for n in grp if n and any(k in n.lower() for k in ['source', 'stream', 'play', 'load', 'embed', 'server', 'video', 'media', 'fetch', 'init', 'setup'])]
print("\nInteresting function names:")
for n in sorted(set(interesting)):
    print(f"  {n}")
