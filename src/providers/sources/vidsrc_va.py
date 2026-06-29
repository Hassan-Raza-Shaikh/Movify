"""
VidsrcVA — direct HLS from the NEW vidsrc backend (streamdata.vaplayer.ru), the
data source behind vidsrc.pm / vidsrc.in (nextgencloudfabric player). The old
cloudnestra rcp/prorcp/data-hash flow that legacy scrapers use is dead; this is
a single unauthenticated JSON GET. Verified 2026-06-29.

  GET https://streamdata.vaplayer.ru/api.php?tmdb={id}&type=movie
      (TV: &type=tv&season={s}&episode={e}; also accepts imdb={ttID})
  -> {"status_code":"200","data":{"stream_urls":[ master.m3u8 mirrors ]}}

CDN host inside stream_urls rotates per response, so always use what's returned.
"""
from __future__ import annotations
import logging

from ..base import MediaContext, SourceResult, Stream
from ..fetcher import Fetcher
from ..runner import register_source

log = logging.getLogger("nautilus.providers.vidsrc_va")

API = "https://streamdata.vaplayer.ru/api.php"
HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
    ),
    "Referer": "https://nextgencloudfabric.com/",
}


@register_source
class VidsrcVA:
    id = "vidsrc_va"
    name = "VidSrc (vaplayer)"
    rank = 510                        # verified working 2026, zero-auth JSON
    media_types = ["movie", "tv"]

    async def scrape(self, ctx: MediaContext, fetcher: Fetcher) -> SourceResult:
        params = {
            "type": "movie" if ctx.media_type == "movie" else "tv",
        }
        # Prefer IMDb id when available (the API resolves tmdb->imdb internally anyway)
        if getattr(ctx, "imdb_id", None):
            params["imdb"] = ctx.imdb_id
        else:
            params["tmdb"] = str(ctx.tmdb_id)
        if ctx.media_type != "movie":
            params["season"] = str(ctx.season)
            params["episode"] = str(ctx.episode)

        try:
            data = await fetcher.get_json(API, params=params, headers=HEADERS)
        except Exception as e:
            log.warning("[vidsrc_va] api failed: %s", e)
            return SourceResult()

        if not isinstance(data, dict):
            return SourceResult()
        urls = (data.get("data") or {}).get("stream_urls") or []
        if not urls:
            log.info("[vidsrc_va] no stream_urls for tmdb=%s", ctx.tmdb_id)
            return SourceResult()

        log.info("[vidsrc_va] resolved HLS for tmdb=%s (%d mirrors)", ctx.tmdb_id, len(urls))
        return SourceResult(streams=[
            Stream(stream_type="hls", playlist=urls[0],
                   headers={"Referer": "https://nextgencloudfabric.com/"})
        ])
