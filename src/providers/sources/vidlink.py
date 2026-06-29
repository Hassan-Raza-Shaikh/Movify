"""
Vidlink — direct MP4 (+ .srt subtitles) from vidlink.pro. The TMDB id is wrapped
in a NaCl SecretBox token. The API sits behind a Cloudflare TLS-fingerprint WAF,
so this source uses curl_cffi (chrome110 impersonation) rather than the shared
aiohttp fetcher — plain httpx/aiohttp just get an empty 200. Verified 2026-06-29.

(The old vidlink.pro/api/movie/{tmdb} AES-CBC flow is dead — returns empty 200.)

  token = urlsafe_b64( nonce(24 zero bytes)
                       + SecretBox(KEY).encrypt(id + be64(now+480), nonce).ciphertext )
  GET https://vidlink.pro/api/b/movie/{token}?multiLang=1   (TV: /api/b/tv/{token}/{s}/{e})
  -> data.stream.qualities["1080"]["url"]  (signed mp4, time-limited) + captions[]

CDN omits CORS headers, so the MP4 must be served through /proxy_stream.
"""
from __future__ import annotations
import base64
import struct
import time
import logging

from ..base import MediaContext, SourceResult, Stream, StreamFile, Caption
from ..fetcher import Fetcher
from ..runner import register_source

log = logging.getLogger("nautilus.providers.vidlink")

KEY = bytes.fromhex("c75136c5668bbfe65a7ecad431a745db68b5f381555b38d8f6c699449cf11fcd")
HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
    ),
    "Origin": "https://vidlink.pro",
    "Referer": "https://vidlink.pro/",
}


def _token(media_id: str) -> str:
    from nacl.secret import SecretBox
    nonce = bytes(24)
    msg = media_id.encode() + struct.pack(">Q", int(time.time()) + 480)
    ct = SecretBox(KEY).encrypt(msg, nonce).ciphertext
    return base64.urlsafe_b64encode(nonce + ct).decode().rstrip("=")


@register_source
class VidLink:
    id = "vidlink"
    name = "VidLink"
    rank = 470          # verified working 2026 (new NaCl-token flow)
    media_types = ["movie", "tv"]

    async def scrape(self, ctx: MediaContext, fetcher: Fetcher) -> SourceResult:
        # NOTE: ignores the shared fetcher — needs curl_cffi TLS impersonation.
        tok = _token(str(ctx.tmdb_id))
        if ctx.media_type == "movie":
            url = f"https://vidlink.pro/api/b/movie/{tok}?multiLang=1"
        else:
            url = f"https://vidlink.pro/api/b/tv/{tok}/{ctx.season}/{ctx.episode}?multiLang=1"

        try:
            from curl_cffi.requests import AsyncSession
            async with AsyncSession() as s:
                r = await s.get(url, headers=HEADERS, impersonate="chrome110", timeout=15)
            data = r.json()
        except Exception as e:
            log.warning("[vidlink] failed: %s", e)
            return SourceResult()

        stream = (data or {}).get("stream") or {}
        captions = []
        for c in stream.get("captions") or []:
            cu = c.get("url") or c.get("file")
            if cu:
                lang = (c.get("language") or c.get("label") or "en")
                captions.append(Caption(url=cu, lang=str(lang)[:2].lower(), format="srt"))

        # Some titles return type "hls" with a playlist instead of mp4 files
        if stream.get("type") == "hls" and stream.get("playlist"):
            return SourceResult(streams=[
                Stream(stream_type="hls", playlist=stream["playlist"], captions=captions)
            ])

        files = []
        for label, q in (stream.get("qualities") or {}).items():
            qu = q.get("url") if isinstance(q, dict) else None
            if qu:
                files.append(StreamFile(url=qu, quality=str(label)))
        if files:
            log.info("[vidlink] resolved %d mp4 qualities for tmdb=%s", len(files), ctx.tmdb_id)
            return SourceResult(streams=[
                Stream(stream_type="file", qualities=files, captions=captions)
            ])

        return SourceResult()
