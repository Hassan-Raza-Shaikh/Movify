"""
ShowBox / FebBox — real release files (1080p BluRay etc.), multi-quality HLS.

Flow (verified 2026-06-30):
  1. Showbox mobile API (3DES-CBC signed) Search5  -> internal id + box_type
  2. showbox.media/index/share_link?id=&type=       -> febbox share_key
  3. febbox file_share_list (no auth)                -> file id (movie file, or season->episode)
  4. febbox file/player  (REQUIRES the 'ui' cookie)  -> signed HLS qualities

Needs a febbox 'ui' session token in env FEBBOX_UI_TOKEN — without it this source
is inert (returns nothing). The final HLS URLs are signed + time-limited, so this
resolves fresh per play.
"""
from __future__ import annotations
import os
import re
import time
import json
import base64
import hashlib
import logging

import httpx
from cryptography.hazmat.primitives.ciphers import Cipher, modes
from cryptography.hazmat.primitives import padding as _padding
try:
    from cryptography.hazmat.decrepit.ciphers.algorithms import TripleDES
except ImportError:  # older cryptography
    from cryptography.hazmat.primitives.ciphers.algorithms import TripleDES

from ..base import MediaContext, SourceResult, Stream
from ..fetcher import Fetcher
from ..runner import register_source

log = logging.getLogger("nautilus.providers.showbox")

KEY = b"123d6cedf626dy54233aa1w6"   # 24-byte 3DES key
IV = b"wEiphTn!"                    # 8-byte IV
APP_KEY = "moviebox"
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36")


def _md5(s) -> str:
    return hashlib.md5(s.encode() if isinstance(s, str) else s).hexdigest()


def _enc_3des(text: str) -> str:
    padder = _padding.PKCS7(64).padder()
    data = padder.update(text.encode()) + padder.finalize()
    enc = Cipher(TripleDES(KEY), modes.CBC(IV)).encryptor()
    return base64.b64encode(enc.update(data) + enc.finalize()).decode()


@register_source
class Showbox:
    id = "showbox"
    name = "ShowBox"
    rank = 490                       # high-quality release files; slower (multi-step) so a fallback
    media_types = ["movie", "tv"]

    async def _sb_api(self, cl: httpx.AsyncClient, req: dict) -> dict:
        ak = _md5(APP_KEY)
        ed = _enc_3des(json.dumps(req))
        verify = _md5(ak + KEY.decode() + ed)
        payload = json.dumps({"app_key": ak, "verify": verify, "encrypt_data": ed})
        body = {
            "data": base64.b64encode(payload.encode()).decode(),
            "appid": "27", "platform": "android", "version": "129", "medium": "Website",
        }
        r = await cl.post("https://mbpapi.shegu.net/api/api_client/index/",
                          data=body, headers={"Platform": "android", "User-Agent": "okhttp/3.2.0"})
        return r.json()

    async def scrape(self, ctx: MediaContext, fetcher: Fetcher) -> SourceResult:
        ui = os.getenv("FEBBOX_UI_TOKEN")
        if not ui or not ctx.title:
            return SourceResult()

        try:
            async with httpx.AsyncClient(timeout=20.0, follow_redirects=True) as cl:
                # 1) search -> showbox id + box_type
                exp = int(time.time()) + 12 * 3600
                res = await self._sb_api(cl, {
                    "childmode": "0", "app_version": "11.5", "appid": "27", "lang": "en",
                    "platform": "android", "channel": "Website", "medium": "Website",
                    "expired_date": str(exp), "module": "Search5", "version": "129",
                    "page": 1, "type": "all", "keyword": ctx.title, "pagelimit": 20,
                })
                items = res.get("data") or []
                want = 1 if ctx.media_type == "movie" else 2
                cands = [m for m in items if m.get("box_type") == want]
                if not cands:
                    return SourceResult()

                def _yr(m):
                    try:
                        return int(str(m.get("year") or "0")[:4])
                    except Exception:
                        return 0
                pick = None
                if ctx.media_type == "movie" and ctx.year:
                    pick = next((m for m in cands if _yr(m) == ctx.year), None)
                pick = pick or cands[0]

                # 2) share_link -> febbox share_key
                sl = (await cl.get(
                    f"https://www.showbox.media/index/share_link?id={pick['id']}&type={pick['box_type']}"
                )).json()
                link = (sl.get("data") or {}).get("link")
                if not link:
                    return SourceResult()
                share = link.rstrip("/").rsplit("/", 1)[-1]

                async def _list(parent):
                    r = await cl.get(
                        f"https://www.febbox.com/file/file_share_list"
                        f"?share_key={share}&pwd=&parent_id={parent}&is_html=0",
                        headers={"x-requested-with": "XMLHttpRequest",
                                 "Referer": f"https://www.febbox.com/share/{share}"})
                    return (r.json().get("data") or {}).get("file_list") or []

                # 3) locate the file id
                files = await _list(0)
                vid_ext = (".mp4", ".mkv", ".avi")
                fid = None
                if ctx.media_type == "movie":
                    vids = [f for f in files if not f.get("is_dir")
                            and str(f.get("file_name", "")).lower().endswith(vid_ext)]
                    if vids:
                        fid = sorted(vids, key=lambda f: f.get("file_size", 0), reverse=True)[0]["fid"]
                else:
                    sdir = next((f for f in files if f.get("is_dir") and re.search(
                        rf"season\s*0*{ctx.season}\b|\bs0*{ctx.season}\b",
                        str(f.get("file_name", "")), re.I)), None)
                    season_files = await _list(sdir["fid"]) if sdir else files
                    ep = next((f for f in season_files if not f.get("is_dir")
                               and str(f.get("file_name", "")).lower().endswith(vid_ext)
                               and re.search(rf"s0*{ctx.season}e0*{ctx.episode}\b|\be0*{ctx.episode}\b|\b0*{ctx.episode}\b",
                                             str(f.get("file_name", "")), re.I)), None)
                    if ep:
                        fid = ep["fid"]
                if not fid:
                    return SourceResult()

                # 4) file/player (cookie-gated) -> signed HLS qualities
                pr = await cl.post("https://www.febbox.com/file/player",
                                   data={"fid": fid, "share_key": share},
                                   headers={"Cookie": f"ui={ui}", "x-requested-with": "XMLHttpRequest",
                                            "Referer": f"https://www.febbox.com/share/{share}",
                                            "User-Agent": UA})
                mm = re.search(r"var sources\s*=\s*(\[.*?\]);", pr.text, re.S)
                if not mm:
                    log.info("[showbox] no sources (token expired?) for %s", ctx.title)
                    return SourceResult()
                srcs = json.loads(mm.group(1))
                vids = [s for s in srcs if s.get("file")
                        and "audio" not in str(s.get("label", "")).lower()]
                if not vids:
                    return SourceResult()
                chosen = next((s for s in vids if str(s.get("label", "")).upper() == "AUTO"), vids[0])
                log.info("[showbox] resolved HLS (%s) for %s", chosen.get("label"), ctx.title)
                return SourceResult(streams=[
                    Stream(stream_type="hls", playlist=chosen["file"],
                           headers={"Referer": "https://www.febbox.com/"})
                ])
        except Exception as e:
            log.warning("[showbox] failed: %s", e)
            return SourceResult()
