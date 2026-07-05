"""Analyze vidsrc.cc v2 structure."""
import urllib.request, ssl, re, base64, json

ctx = ssl.create_default_context()
ctx.check_hostname = False
ctx.verify_mode = ssl.CERT_NONE
h = {'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'}

# 1. Get the embed page
req = urllib.request.Request('https://vidsrc.cc/v2/embed/movie/680', headers=h)
body = urllib.request.urlopen(req, timeout=10, context=ctx).read().decode()

# Decode base64 vars
for m in re.finditer(r'var\s+(\w+)\s*=\s*"([^"]+)"', body):
    name, val = m.group(1), m.group(2)
    try:
        decoded = base64.b64decode(val).decode('utf-8', 'replace')
        print(f"  {name} = {val} -> DECODED: {decoded}")
    except:
        print(f"  {name} = {val}")

# Find JS files
scripts = re.findall(r'src="([^"]+\.js[^"]*)"', body)
print("\nJS files:", scripts)

# Show full body from var autoPlay onwards
idx = body.find('var autoPlay')
if idx > 0:
    print("\n--- Page content (from autoPlay) ---")
    print(body[idx:idx+4000])

# 2. Fetch the main embed.min.js
for s in scripts:
    if 'embed' in s.lower() or 'main' in s.lower() or 'app' in s.lower():
        surl = s if s.startswith('http') else f'https://vidsrc.cc{s}'
        print(f"\n--- Fetching {surl} ---")
        try:
            req2 = urllib.request.Request(surl, headers={**h, 'Referer': 'https://vidsrc.cc/'})
            js = urllib.request.urlopen(req2, timeout=10, context=ctx).read().decode('utf-8', 'replace')
            print(f"JS size: {len(js)} bytes")
            
            # Find API endpoints
            apis = re.findall(r'["\'](/v2/[^"\']+)["\']', js)
            fetches = re.findall(r'fetch\s*\(["\']([^"\']+)', js)
            ajax = re.findall(r'(?:ajax|api|source|embed)[^"\']*["\']([^"\']+)', js, re.I)
            urls = re.findall(r'https?://[^\s"\'`]+', js)
            
            print("API patterns:", list(set(apis))[:10])
            print("Fetch calls:", list(set(fetches))[:10])
            print("URLs:", list(set(urls))[:10])
            
            # Look for source/stream patterns
            source_patterns = re.findall(r'(?:source|stream|hls|m3u8|file|video|player)\w*\s*[:=]', js, re.I)
            print("Source patterns:", list(set(source_patterns))[:10])
        except Exception as e:
            print(f"  Failed: {e}")
