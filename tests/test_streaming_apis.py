"""Test streaming API endpoints for usable video data."""
import urllib.request
import urllib.error
import ssl
import sys
import re

ctx = ssl.create_default_context()
ctx.check_hostname = False
ctx.verify_mode = ssl.CERT_NONE

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
}

TMDB_IDS = [680, 550]

ENDPOINTS = [
    # 1. embed.su
    ("embed.su", "https://embed.su/embed/movie/{tmdb}"),
    # 2. vidsrc.xyz
    ("vidsrc.xyz (path)", "https://vidsrc.xyz/embed/movie/{tmdb}"),
    ("vidsrc.xyz (query)", "https://vidsrc.xyz/embed/movie?tmdb={tmdb}"),
    # 3. 2embed.cc
    ("2embed.cc (v1)", "https://2embed.cc/embed/{tmdb}"),
    ("2embed.cc (v2)", "https://www.2embed.cc/embed/movie/{tmdb}"),
    # 4. multiembed.mov
    ("multiembed.mov (direct)", "https://multiembed.mov/directstream.php?video_id={tmdb}"),
    ("multiembed.mov (tmdb)", "https://multiembed.mov/?video_id={tmdb}&tmdb=1"),
    # 5. vidsrc.cc
    ("vidsrc.cc (v2)", "https://vidsrc.cc/v2/embed/movie/{tmdb}"),
    ("vidsrc.cc (v3)", "https://vidsrc.cc/v3/embed/movie/{tmdb}"),
    # 6. vidlink.pro
    ("vidlink.pro (api)", "https://vidlink.pro/api/movie/{tmdb}"),
    ("vidlink.pro (movie)", "https://vidlink.pro/movie/{tmdb}"),
    # 7. vidsrc.net
    ("vidsrc.net", "https://vidsrc.net/embed/movie/?tmdb={tmdb}"),
    # 8. player.autoembed.cc
    ("autoembed.cc", "https://player.autoembed.cc/embed/movie/{tmdb}"),
]


def test_endpoint(name, url_template, tmdb_id):
    url = url_template.replace("{tmdb}", str(tmdb_id))
    print(f"\n{'='*80}")
    print(f"  {name} | TMDB={tmdb_id}")
    print(f"  URL: {url}")
    print(f"{'='*80}")
    
    req = urllib.request.Request(url)
    for k, v in HEADERS.items():
        req.add_header(k, v)
    # Add Referer for some that need it
    req.add_header("Referer", "https://www.google.com/")
    
    try:
        resp = urllib.request.urlopen(req, timeout=12, context=ctx)
        status = resp.status
        ct = resp.headers.get("Content-Type", "N/A")
        body = resp.read(2000).decode("utf-8", errors="replace")
        
        print(f"  STATUS: {status}")
        print(f"  CONTENT-TYPE: {ct}")
        print(f"  BODY (first 800 chars):")
        print(body[:800])
        
        # Quick analysis
        analysis = []
        if re.search(r'<iframe[^>]+src=', body, re.I):
            iframes = re.findall(r'<iframe[^>]+src=["\']([^"\']+)', body, re.I)
            analysis.append(f"IFRAME(s): {iframes[:3]}")
        if re.search(r'\.m3u8', body, re.I):
            m3u8s = re.findall(r'https?://[^\s"\'<>]+\.m3u8[^\s"\'<>]*', body, re.I)
            analysis.append(f"M3U8: {m3u8s[:3]}")
        if re.search(r'\.mp4', body, re.I):
            mp4s = re.findall(r'https?://[^\s"\'<>]+\.mp4[^\s"\'<>]*', body, re.I)
            analysis.append(f"MP4: {mp4s[:3]}")
        if re.search(r'"sources"', body, re.I) or re.search(r'"file"', body, re.I):
            analysis.append("HAS sources/file keys in response")
        if re.search(r'/api/', body, re.I):
            apis = re.findall(r'["\']([^"\']*?/api/[^"\']*)["\']', body, re.I)
            analysis.append(f"API refs: {apis[:5]}")
        if body.strip().startswith('{') or body.strip().startswith('['):
            analysis.append("JSON response")
        if not analysis:
            if '<html' in body.lower():
                analysis.append("HTML page (no video URLs detected in first 2KB)")
            else:
                analysis.append("Unknown content")
        
        print(f"\n  >> ANALYSIS: {'; '.join(analysis)}")
        
    except urllib.error.HTTPError as e:
        print(f"  STATUS: {e.code} {e.reason}")
        ct = e.headers.get("Content-Type", "N/A")
        print(f"  CONTENT-TYPE: {ct}")
        try:
            body = e.read(1000).decode("utf-8", errors="replace")
            print(f"  ERROR BODY: {body[:500]}")
        except:
            print("  (could not read error body)")
    except Exception as e:
        print(f"  ERROR: {type(e).__name__}: {str(e)[:200]}")


def main():
    batch = int(sys.argv[1]) if len(sys.argv) > 1 else 0
    
    if batch == 0:
        # Test all with TMDB 680 first
        print("\n" + "#"*80)
        print("# TESTING ALL ENDPOINTS WITH TMDB ID 680 (Pulp Fiction)")
        print("#"*80)
        for name, url_tpl in ENDPOINTS:
            test_endpoint(name, url_tpl, 680)
    elif batch == 1:
        # Test all with TMDB 550
        print("\n" + "#"*80)
        print("# TESTING ALL ENDPOINTS WITH TMDB ID 550 (Fight Club)")
        print("#"*80)
        for name, url_tpl in ENDPOINTS:
            test_endpoint(name, url_tpl, 550)


if __name__ == "__main__":
    main()
