"""
Provider engine — discovers source scrapers, resolves embeds, returns direct streams.

Usage:
    engine = ProviderEngine()
    result = await engine.run_all(media)
    if result:
        print(result.to_dict())
    await engine.close()
"""
from __future__ import annotations
import asyncio
import logging
from typing import Optional

from .base import (
    MediaContext, RunOutput, Stream, SourceResult, EmbedResult,
)
from .fetcher import Fetcher

log = logging.getLogger("nautilus.providers")


# ──────────────────────────────
#  Scraper registries
# ──────────────────────────────
class _SourceScraper:
    id: str
    name: str
    rank: int
    media_types: list[str]          # ["movie"] or ["movie", "show"]

    async def scrape(self, ctx: MediaContext, fetcher: Fetcher) -> SourceResult:
        raise NotImplementedError


class _EmbedScraper:
    id: str
    name: str
    rank: int

    async def scrape(self, url: str, fetcher: Fetcher) -> EmbedResult:
        raise NotImplementedError


# Global registries — populated when source/embed modules are imported
_SOURCES: list[_SourceScraper] = []
_EMBEDS: dict[str, _EmbedScraper] = {}


def register_source(scraper):
    """Decorator to register a source scraper class."""
    # Deduplicate: remove any existing entry with same id
    global _SOURCES
    _SOURCES = [s for s in _SOURCES if s.id != scraper.id]
    inst = scraper()
    if not getattr(inst, 'disabled', False):
        _SOURCES.append(inst)
        _SOURCES.sort(key=lambda s: s.rank, reverse=True)
    return scraper


def register_embed(scraper):
    """Decorator to register an embed scraper class."""
    inst = scraper()
    _EMBEDS[inst.id] = inst
    return scraper


# ──────────────────────────────
#  Engine
# ──────────────────────────────
class ProviderEngine:
    def __init__(self, *, timeout: int = 12):
        self.fetcher = Fetcher(timeout=timeout)

    async def close(self):
        await self.fetcher.close()

    def list_sources(self):
        return [{'id': s.id, 'name': s.name, 'rank': s.rank, 'disabled': False}
                for s in _SOURCES if not getattr(s, 'disabled', False)]

    def list_embeds(self):
        return [{'id': e.id, 'name': e.name, 'rank': e.rank, 'disabled': False}
                for e in _EMBEDS.values() if not getattr(e, 'disabled', False)]

    # Anime-only source IDs (skip these for non-anime content)
    ANIME_SOURCE_IDS = {"animepahe", "anitaku"}

    async def run_all(self, media: MediaContext) -> Optional[RunOutput]:
        """Try all sources concurrently, return highest-rank working stream."""
        applicable = [
            s for s in _SOURCES
            if media.media_type in s.media_types
            and not getattr(s, 'disabled', False)
            and (s.id not in self.ANIME_SOURCE_IDS or media.is_anime)
        ]
        # If anime, boost anime sources to top priority
        if media.is_anime:
            applicable.sort(key=lambda s: (s.id in self.ANIME_SOURCE_IDS, s.rank), reverse=True)

        async def _try_source(source) -> Optional[RunOutput]:
            try:
                log.info(f"[{source.id}] Trying source scraper...")
                result = await asyncio.wait_for(
                    source.scrape(media, self.fetcher), timeout=15)
            except Exception as e:
                log.warning(f"[{source.id}] Source failed: {e}")
                return None

            for stream in result.streams:
                if self._valid(stream):
                    log.info(f"[{source.id}] Direct stream found")
                    return RunOutput(source_id=source.id, embed_id=None, stream=stream)

            for embed_ref in result.embeds:
                scraper = _EMBEDS.get(embed_ref.embed_id)
                if not scraper or getattr(scraper, 'disabled', False):
                    continue
                try:
                    log.info(f"  [{source.id} → {scraper.id}] Resolving embed...")
                    embed_out = await asyncio.wait_for(
                        scraper.scrape(embed_ref.url, self.fetcher), timeout=12)
                except Exception as e:
                    log.warning(f"  [{scraper.id}] Embed failed: {e}")
                    continue
                for stream in embed_out.streams:
                    if self._valid(stream):
                        log.info(f"  [{scraper.id}] Stream resolved")
                        return RunOutput(source_id=source.id, embed_id=scraper.id, stream=stream)
            return None

        # Fire all sources concurrently, but award the win to the HIGHEST-RANK
        # source that resolves within a short window — not merely the first to
        # finish. This prefers quality (e.g. vixsrc 1080p) over a faster but
        # lower-quality source (e.g. vidrock 800p). The lower-rank sources keep
        # resolving in the background, so falling through to them is instant.
        tasks = {id(s): asyncio.create_task(_try_source(s)) for s in applicable}
        try:
            for source in applicable:            # applicable is sorted highest-rank first
                try:
                    res = await asyncio.wait_for(tasks[id(source)], timeout=6)
                except asyncio.TimeoutError:
                    continue                     # too slow — a lower-rank source is likely ready
                except Exception:
                    continue
                if isinstance(res, RunOutput):
                    return res
            log.warning("All providers exhausted, no stream found")
            return None
        finally:
            for t in tasks.values():
                if not t.done():
                    t.cancel()

    async def run_all_streams(self, media: MediaContext) -> list[RunOutput]:
        """Try ALL sources/embeds, collect every working stream for the player UI."""
        results: list[RunOutput] = []
        applicable = [
            s for s in _SOURCES
            if media.media_type in s.media_types
            and not getattr(s, 'disabled', False)
            and (s.id not in self.ANIME_SOURCE_IDS or media.is_anime)
        ]

        async def _try_source(source):
            found = []
            try:
                result = await asyncio.wait_for(
                    source.scrape(media, self.fetcher), timeout=8)
            except Exception as e:
                log.warning(f"[{source.id}] Source failed: {e}")
                return found

            for stream in result.streams:
                if self._valid(stream):
                    found.append(RunOutput(source_id=source.id, embed_id=None, stream=stream))

            for ref in result.embeds:
                scraper = _EMBEDS.get(ref.embed_id)
                if not scraper or getattr(scraper, 'disabled', False):
                    continue
                try:
                    out = await asyncio.wait_for(
                        scraper.scrape(ref.url, self.fetcher), timeout=6)
                except Exception:
                    continue
                for stream in out.streams:
                    if self._valid(stream):
                        found.append(RunOutput(source_id=source.id, embed_id=scraper.id, stream=stream))
            return found

        # Run all sources concurrently for speed
        tasks = [_try_source(s) for s in applicable]
        task_results = await asyncio.gather(*tasks, return_exceptions=True)
        for r in task_results:
            if isinstance(r, list):
                results.extend(r)

        return results

    async def run_source(self, source_id: str, media: MediaContext) -> Optional[RunOutput]:
        """Run a single named source."""
        source = next((s for s in _SOURCES if s.id == source_id), None)
        if not source:
            return None
        try:
            result = await source.scrape(media, self.fetcher)
        except Exception:
            return None

        for stream in result.streams:
            if self._valid(stream):
                return RunOutput(source_id=source.id, embed_id=None, stream=stream)

        for ref in result.embeds:
            scraper = _EMBEDS.get(ref.embed_id)
            if not scraper:
                continue
            try:
                out = await scraper.scrape(ref.url, self.fetcher)
            except Exception:
                continue
            for stream in out.streams:
                if self._valid(stream):
                    return RunOutput(source_id=source.id, embed_id=scraper.id, stream=stream)
        return None

    @staticmethod
    def _valid(stream: Stream) -> bool:
        if stream.stream_type == "hls":
            return bool(stream.playlist)
        if stream.stream_type == "file":
            return len(stream.qualities) > 0 and any(q.url for q in stream.qualities)
        return False


# ──────────────────────────────
#  Import all scrapers to register them
# ──────────────────────────────
def _load_scrapers():
    # ── Sources ──
    from .sources import vixsrc         # noqa: F401  rank 520 — VERIFIED 2026 (vixsrc.to direct HLS)
    from .sources import vidsrc_va      # noqa: F401  rank 510 — VERIFIED 2026 (streamdata.vaplayer.ru JSON)
    from .sources import vidrock        # noqa: F401  rank 480 — VERIFIED 2026 (vidrock.net AES-CBC, HLS)
    from .sources import vidlink        # noqa: F401  rank 470 — VERIFIED 2026 (vidlink.pro MP4, curl_cffi)
    from .sources import flix2day       # noqa: F401  rank 500 — RELIABLE (flix2day AES decrypt)
    from .sources import vidplus        # noqa: F401  rank 450 — RELIABLE (vidplus.to AES decrypt, multi-quality)
    from .sources import moviesapi      # noqa: F401  rank 400 — RELIABLE (vidora HLS)
    from .sources import whvx           # noqa: F401  rank 300
    from .sources import vidsrcsu       # noqa: F401  rank 229
    from .sources import fsharetv       # noqa: F401  rank 220
    from .sources import hdrezka        # noqa: F401  rank 190
    from .sources import soapertv       # noqa: F401  rank 160
    from .sources import nsbx           # noqa: F401  rank 150
    from .sources import showbox        # noqa: F401  rank 490 — VERIFIED 2026 (febbox ui token, release-file HLS)
    from .sources import vidsrcto       # noqa: F401  rank 130
    from .sources import remotestream   # noqa: F401  rank 120
    from .sources import ridomovies     # noqa: F401  rank 120
    from .sources import primewire      # noqa: F401  rank 110
    from .sources import bombtheirish   # noqa: F401  rank 100
    from .sources import nites          # noqa: F401  rank 90
    from .sources import autoembed_src  # noqa: F401  rank 90
    from .sources import vidsrc         # noqa: F401  rank 350 (cloudnestra)
    from .sources import animepahe      # noqa: F401  rank 88 — ANIME
    from .sources import anitaku        # noqa: F401  rank 85 — ANIME
    from .sources import warezcdn       # noqa: F401  rank 81
    from .sources import ee3            # noqa: F401  rank 80
    from .sources import nepu           # noqa: F401  rank 80 (disabled)
    from .sources import tugaflix       # noqa: F401  rank 73
    from .sources import goojara       # noqa: F401  rank 70 (disabled)
    from .sources import zoechip        # noqa: F401  rank 62 (disabled)
    from .sources import flixhq         # noqa: F401  rank 61 (disabled)
    from .sources import gomovies       # noqa: F401  rank 60 (disabled)
    from .sources import lookmovie      # noqa: F401  rank 50 (disabled)
    from .sources import kissasian      # noqa: F401  rank 40 (disabled)
    from .sources import smashystream   # noqa: F401  rank 30
    # ── Embeds (35) ──
    from .embeds import vidplay         # noqa: F401  rank 401
    from .embeds import filemoon        # noqa: F401  rank 400
    from .embeds import filemoon_mp4    # noqa: F401  rank 399
    from .embeds import streamwish      # noqa: F401  rank 216
    from .embeds import streamvid       # noqa: F401  rank 215
    from .embeds import vidcloud        # noqa: F401  rank 201 (disabled)
    from .embeds import upcloud         # noqa: F401  rank 200 (disabled)
    from .embeds import upstream        # noqa: F401  rank 199
    from .embeds import mixdrop         # noqa: F401  rank 198
    from .embeds import vidsrcembed     # noqa: F401  rank 197
    from .embeds import streambucket    # noqa: F401  rank 196 (disabled)
    from .embeds import febbox_mp4      # noqa: F401  rank 190
    from .embeds import voe             # noqa: F401  rank 180
    from .embeds import dood            # noqa: F401  rank 173
    from .embeds import wootly          # noqa: F401  rank 172
    from .embeds import mp4upload       # noqa: F401  rank 170
    from .embeds import febbox_hls      # noqa: F401  rank 160 (disabled)
    from .embeds import streamtape      # noqa: F401  rank 160
    from .embeds import streamsb        # noqa: F401  rank 150
    from .embeds import vtube           # noqa: F401  rank 145
    from .embeds import turbovid        # noqa: F401  rank 122
    from .embeds import dropload        # noqa: F401  rank 120
    from .embeds import filelions       # noqa: F401  rank 115
    from .embeds import bflix           # noqa: F401  rank 113
    from .embeds import closeload       # noqa: F401  rank 106
    from .embeds import ridoo           # noqa: F401  rank 105
    from .embeds import warezcdn_hls    # noqa: F401  rank 83
    from .embeds import warezcdn_mp4    # noqa: F401  rank 82
    from .embeds import smashystream_f  # noqa: F401  rank 71
    from .embeds import smashystream_o  # noqa: F401  rank 70
    from .embeds import autoembed       # noqa: F401  rank 10
    # WHVX embeds (nova/astra/orion registered in whvx.py)
    # NSBX embeds (delta registered in nsbx.py)

_load_scrapers()
