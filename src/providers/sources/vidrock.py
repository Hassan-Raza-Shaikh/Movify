"""
Vidrock — direct HLS from vidrock.net. The TMDB id is AES-256-CBC encrypted with
a hardcoded passphrase, url-safe base64'd, and used as the API path. Returns a
dict of named servers, each with a master .m3u8. Verified 2026-06-29.

  enc = urlsafe_b64( AES-256-CBC( id, key=PASS, iv=PASS[:16], PKCS7 ) )
  GET https://vidrock.net/api/movie/{enc}      (TV id = "{tmdb}_{season}_{episode}", path /api/tv/)
  -> { "Nova": {"url": "...master.m3u8", "type": "hls"}, "Orion": {...}, ... }

Segments are origin-locked (CDN 403 without Referer=vidrock.net) — the player
must send that Referer (carried in Stream.headers, re-attached by /proxy_stream).
"""
from __future__ import annotations
import base64
import logging
from urllib.parse import quote

from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
from cryptography.hazmat.primitives import padding as _padding

from ..base import MediaContext, SourceResult, Stream
from ..fetcher import Fetcher
from ..runner import register_source

log = logging.getLogger("nautilus.providers.vidrock")

PASSPHRASE = b"x7k9mPqT2rWvY8zA5bC3nF6hJ2lK4mN9"   # 32-byte key; iv = first 16 bytes
HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
    ),
    "Origin": "https://vidrock.net",
    "Referer": "https://vidrock.net/",
}


def _encrypt_id(plain: str) -> str:
    padder = _padding.PKCS7(128).padder()
    data = padder.update(plain.encode()) + padder.finalize()
    enc = Cipher(algorithms.AES(PASSPHRASE), modes.CBC(PASSPHRASE[:16])).encryptor()
    ct = enc.update(data) + enc.finalize()
    b64 = base64.b64encode(ct).decode().replace("+", "-").replace("/", "_").rstrip("=")
    return quote(b64, safe="")


@register_source
class Vidrock:
    id = "vidrock"
    name = "Vidrock"
    rank = 480
    media_types = ["movie", "tv"]

    async def scrape(self, ctx: MediaContext, fetcher: Fetcher) -> SourceResult:
        if ctx.media_type == "movie":
            ident, path = str(ctx.tmdb_id), "movie"
        else:
            ident, path = f"{ctx.tmdb_id}_{ctx.season}_{ctx.episode}", "tv"

        url = f"https://vidrock.net/api/{path}/{_encrypt_id(ident)}"
        try:
            data = await fetcher.get_json(url, headers=HEADERS)
        except Exception as e:
            log.warning("[vidrock] failed: %s", e)
            return SourceResult()

        if not isinstance(data, dict):
            return SourceResult()

        for name, srv in data.items():
            if isinstance(srv, dict) and srv.get("url") and srv.get("type") == "hls":
                log.info("[vidrock] resolved HLS via %s for tmdb=%s", name, ctx.tmdb_id)
                return SourceResult(streams=[
                    Stream(stream_type="hls", playlist=srv["url"],
                           headers={"Referer": "https://vidrock.net/"})
                ])
        return SourceResult()
