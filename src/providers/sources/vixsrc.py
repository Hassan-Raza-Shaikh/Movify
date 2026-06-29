"""
Vixsrc — direct HLS from vixsrc.to (the backend behind vidfast / 111movies /
vidking / vidzee). No auth, no browser, no embeds (so no ads).

Flow (verified 2026-06-29):
  1. GET https://vixsrc.to/api/movie/{tmdb}            -> {"src": "/embed/{id}?token=...&expires=..."}
     TV: GET https://vixsrc.to/api/tv/{tmdb}/{season}/{episode}
  2. GET https://vixsrc.to{src}                        -> HTML with `window.masterPlaylist = {url, token, expires}`
  3. master = {url}?token={token}&expires={expires}&h=1&lang=en   -> HLS master playlist

Segments are AES-128 (key served openly at /storage/enc.key); hls.js handles it.
token+expires are short-lived (~1h) so this resolves fresh per play.
"""
from __future__ import annotations
import re
import logging

from ..base import MediaContext, SourceResult, Stream
from ..fetcher import Fetcher
from ..runner import register_source

log = logging.getLogger("nautilus.providers.vixsrc")

BASE = "https://vixsrc.to"
HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
    ),
    "Referer": "https://vixsrc.to/",
}


@register_source
class Vixsrc:
    id = "vixsrc"
    name = "Vixsrc"
    rank = 520                        # verified working 2026, broad catalog — top priority
    media_types = ["movie", "tv"]

    async def scrape(self, ctx: MediaContext, fetcher: Fetcher) -> SourceResult:
        if ctx.media_type == "movie":
            api = f"{BASE}/api/movie/{ctx.tmdb_id}"
        else:
            api = f"{BASE}/api/tv/{ctx.tmdb_id}/{ctx.season}/{ctx.episode}"

        try:
            data = await fetcher.get_json(api, headers=HEADERS)
        except Exception as e:
            log.warning("[vixsrc] api failed: %s", e)
            return SourceResult()

        src = data.get("src") if isinstance(data, dict) else None
        if not src:
            log.info("[vixsrc] no src for tmdb=%s", ctx.tmdb_id)
            return SourceResult()

        embed_url = src if src.startswith("http") else f"{BASE}{src}"
        try:
            html = await fetcher.get(embed_url, headers=HEADERS)
        except Exception as e:
            log.warning("[vixsrc] embed fetch failed: %s", e)
            return SourceResult()

        m_url = re.search(r"url:\s*'([^']+)'", html)
        m_tok = re.search(r"'token':\s*'([^']+)'", html)
        m_exp = re.search(r"'expires':\s*'([^']+)'", html)
        if not (m_url and m_tok and m_exp):
            log.info("[vixsrc] masterPlaylist not found in embed")
            return SourceResult()

        master = (
            f"{m_url.group(1)}?token={m_tok.group(1)}"
            f"&expires={m_exp.group(1)}&h=1&lang=en"
        )
        log.info("[vixsrc] resolved HLS for tmdb=%s", ctx.tmdb_id)
        return SourceResult(streams=[
            Stream(stream_type="hls", playlist=master,
                   headers={"Referer": "https://vixsrc.to/"})
        ])
