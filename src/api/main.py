from fastapi import FastAPI, Depends, Request, UploadFile, File, BackgroundTasks
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, StreamingResponse, Response
from sqlalchemy.orm import Session, joinedload
from sqlalchemy.sql import func
from src.core.database import get_db, engine
from src.core import models
from src.services.scrapers.universal import UniversalScraper
from src.providers.runner import ProviderEngine
from src.providers.base import MediaContext
import httpx
import os
import requests
import shutil
import logging
import glob
import ctypes
import sys
from datetime import datetime
from datetime import timedelta
import threading
import json
from pathlib import Path
from dotenv import load_dotenv
from fastapi.encoders import jsonable_encoder
from pydantic import BaseModel
from typing import List
TMDB_API_KEY = os.getenv("TMDB_API_KEY")
TMDB_BASE_URL = "https://api.themoviedb.org/3"


TMDB_GENRE_MAP = {
    28: "Action", 12: "Adventure", 16: "Animation", 35: "Comedy",
    80: "Crime", 99: "Documentary", 18: "Drama", 10751: "Family",
    14: "Fantasy", 36: "History", 27: "Horror", 10402: "Music",
    9648: "Mystery", 10749: "Romance", 878: "Sci-Fi", 10770: "TV Movie",
    53: "Thriller", 10752: "War", 37: "Western"
}

def normalize_genres(genres):
    """Return list of {id,name} dicts from stored genres (list of dicts, ids, or names)."""
    out = []
    if not genres:
        return out
    if isinstance(genres, dict):
        genres = [{"id": k, "name": v} for k, v in genres.items()]
    for g in genres:
        if isinstance(g, dict):
            gid = g.get("id")
            name = g.get("name") or TMDB_GENRE_MAP.get(gid)
            if gid is not None and name:
                out.append({"id": int(gid), "name": name})
            elif name:
                out.append({"id": None, "name": name})
        elif isinstance(g, int):
            out.append({"id": g, "name": TMDB_GENRE_MAP.get(g, str(g))})
        elif isinstance(g, str):
            out.append({"id": None, "name": g})
    return out

def genre_id_set(genres):
    norm = normalize_genres(genres)
    return {g["id"] for g in norm if g.get("id") is not None}

load_dotenv()
TMDB_API_KEY = os.getenv("TMDB_API_KEY")

app = FastAPI(title="Nautilus | Deep Dive")

# Watch parties ("Crews") — WebSocket-synced group playback. In-memory rooms,
# so the app must run single-worker (see src/api/watchparty.py).
from src.api.watchparty import router as party_router
app.include_router(party_router)

# Tiny in-memory TTL cache for read-only TMDB-backed endpoints — makes re-opening
# the same modal instant (TMDB recommendations/trailers are stable).
import functools as _functools
import time as _t
_TTL_CACHE: dict = {}

def _ttl_cache(ttl: int):
    def deco(fn):
        @_functools.wraps(fn)
        def wrapper(*args, **kwargs):
            key = (fn.__name__,) + tuple(
                (k, v) for k, v in sorted(kwargs.items()) if not isinstance(v, Session)
            )
            hit = _TTL_CACHE.get(key)
            if hit and (_t.time() - hit[0]) < ttl:
                return hit[1]
            result = fn(*args, **kwargs)
            _TTL_CACHE[key] = (_t.time(), result)
            return result
        return wrapper
    return deco

# MOUNT STATIC ASSETS
app.mount("/static", StaticFiles(directory="src/frontend/static"), name="static")

@app.get("/")
async def read_index():
    return FileResponse('src/frontend/static/index.html')

@app.get("/admin")
async def read_admin():
    return FileResponse('src/frontend/static/admin.html')

@app.get("/show")
async def read_show():
    return FileResponse('src/frontend/static/show.html')

# --- 1. ML INFERENCE & STATS ---

@app.get("/admin/stats")
def get_admin_stats(db: Session = Depends(get_db)):
    """
    Returns system vitals and ML metrics history.
    """
    user_count = db.query(models.User).count()
    movie_count = db.query(models.Movie).count()
    show_count = db.query(models.TVShow).count()
    
    # Fetch all models to plot performance history
    models_list = db.query(models.MLModel).order_by(models.MLModel.created_at.desc()).all()

    # Leaderboard: top movies by popularity_score (top 5)
    top_movies = db.query(models.Movie).order_by(models.Movie.popularity_score.desc()).limit(5).all()
    leaderboard = [{"title": m.title, "tmdb_id": m.tmdb_id, "popularity": m.popularity_score} for m in top_movies]

    # New Releases (by release_date descending) - movies
    try:
        new_releases_movies = db.query(models.Movie).order_by(models.Movie.release_date.desc()).limit(5).all()
        new_releases_movies = [{"title": m.title, "tmdb_id": m.tmdb_id, "release_date": m.release_date} for m in new_releases_movies]
    except Exception:
        new_releases_movies = []

    # Top Rated Movies (by average rating if available, otherwise fallback to popularity)
    try:
        avg_ratings = db.query(
            models.Movie.id,
            models.Movie.title,
            models.Movie.tmdb_id,
            func.avg(models.Interaction.rating_value).label('avg_rating')
        ).join(models.Interaction, models.Interaction.movie_id == models.Movie.id).group_by(models.Movie.id).order_by(func.avg(models.Interaction.rating_value).desc()).limit(5).all()

        if avg_ratings:
            top_rated_movies = [{"title": row.title, "tmdb_id": row.tmdb_id, "avg_rating": float(row.avg_rating)} for row in avg_ratings]
        else:
            # Fallback to popularity
            top_pop = db.query(models.Movie).order_by(models.Movie.popularity_score.desc()).limit(5).all()
            top_rated_movies = [{"title": m.title, "tmdb_id": m.tmdb_id, "popularity": m.popularity_score} for m in top_pop]
    except Exception:
        top_rated_movies = []

    # Repeat for TV Shows
    try:
        # TVShow doesn't have a release_date field in the model; use popularity as a proxy for recent/interesting
        new_releases_shows = db.query(models.TVShow).order_by(models.TVShow.popularity_score.desc()).limit(5).all()
        new_releases_shows = [{"title": s.title, "tmdb_id": s.tmdb_id, "popularity": s.popularity_score} for s in new_releases_shows]
    except Exception:
        new_releases_shows = []

    try:
        avg_ratings_shows = db.query(
            models.TVShow.id,
            models.TVShow.title,
            models.TVShow.tmdb_id,
            func.avg(models.Interaction.rating_value).label('avg_rating')
        ).join(models.Interaction, models.Interaction.tv_show_id == models.TVShow.id).group_by(models.TVShow.id).order_by(func.avg(models.Interaction.rating_value).desc()).limit(5).all()

        if avg_ratings_shows:
            top_rated_shows = [{"title": row.title, "tmdb_id": row.tmdb_id, "avg_rating": float(row.avg_rating)} for row in avg_ratings_shows]
        else:
            top_pop_shows = db.query(models.TVShow).order_by(models.TVShow.popularity_score.desc()).limit(5).all()
            top_rated_shows = [{"title": s.title, "tmdb_id": s.tmdb_id, "popularity": s.popularity_score} for s in top_pop_shows]
    except Exception:
        top_rated_shows = []

    return {
        "users": user_count,
        "movies": movie_count,
        "shows": show_count,
        "models": models_list,
        "leaderboard": leaderboard,
        "new_releases_movies": new_releases_movies,
        "top_rated_movies": top_rated_movies,
        "new_releases_shows": new_releases_shows,
        "top_rated_shows": top_rated_shows
    }

# --- Periodic ingestion helper (simple file-backed last-fetch marker)
LAST_FETCH_PATH = Path("reports") / "last_fetch.json"

def _read_last_fetch():
    try:
        if LAST_FETCH_PATH.exists():
            data = json.loads(LAST_FETCH_PATH.read_text())
            return data
    except Exception as e:
        print(f"read_last_fetch error: {e}")
    return {}

def _write_last_fetch(dct: dict):
    try:
        LAST_FETCH_PATH.parent.mkdir(parents=True, exist_ok=True)
        LAST_FETCH_PATH.write_text(json.dumps(dct))
    except Exception as e:
        print(f"write_last_fetch error: {e}")

def should_refetch(kind: str):
    data = _read_last_fetch()
    key = f"last_fetch_{kind}"
    if key not in data:
        return True
    try:
        last = datetime.fromisoformat(data[key])
        return (datetime.utcnow() - last) >= timedelta(days=2)
    except Exception:
        return True

def mark_fetched(kind: str):
    data = _read_last_fetch()
    data[f"last_fetch_{kind}"] = datetime.utcnow().isoformat()
    _write_last_fetch(data)

def run_fetch(kind: str = 'movies', pages: int = 2):
    try:
        print(f"Starting fetch job for: {kind}")
        if kind in ('movies', 'all'):
            from src.services.ingestion.ingest_movies import fetch_movies
            fetch_movies(pages=pages)
            mark_fetched('movies')
        if kind in ('shows', 'all'):
            from src.services.ingestion.ingest_shows import fetch_shows
            fetch_shows(pages=pages)
            mark_fetched('shows')
        print(f"Fetch job for {kind} completed.")
    except Exception as e:
        print(f"run_fetch error ({kind}): {e}")

def background_periodic_worker(interval_hours: int = 24):
    try:
        while True:
            try:
                # Movies
                if should_refetch('movies'):
                    print("Periodic worker: movies need refresh")
                    run_fetch('movies', pages=2)
                else:
                    print("Periodic worker: movies up-to-date")

                # Shows
                if should_refetch('shows'):
                    print("Periodic worker: shows need refresh")
                    run_fetch('shows', pages=2)
                else:
                    print("Periodic worker: shows up-to-date")
            except Exception as inner:
                print(f"background_periodic_worker inner error: {inner}")

            import time as _time
            _time.sleep(interval_hours * 3600)
    except Exception as e:
        print(f"background_periodic_worker error: {e}")


# Keep the cached home endpoints warm so no user (especially a first-timer) hits
# the ~14s cold DB path — pre-fetch on startup and re-warm on a short interval.
_HOME_WARM_URLS = [
    '/trending?days=7&limit=30', '/trending?days=30&limit=40',
    '/movies/top_rated_alltime?limit=80', '/movies/new_releases?days=90&limit=80',
    '/shows/top_rated_alltime?limit=80', '/shows/new_releases?days=90&limit=80',
    '/collections/ai', '/movies/genre/16?limit=20',
]
def _warm_home_cache_loop():
    import time as _time
    _time.sleep(4)   # let uvicorn bind the port first
    while True:
        for path in _HOME_WARM_URLS:
            try:
                requests.get(f"http://127.0.0.1:8000{path}", timeout=40)
            except Exception:
                pass
        _time.sleep(600)   # re-warm every 10 min so expiries refresh before users hit them


@app.on_event("startup")
def startup_periodic_fetch():
    # Automatically initialize SQLite database tables
    try:
        models.Base.metadata.create_all(bind=engine)
        print("Database schema verified/created.")
    except Exception as e:
        print(f"Database initialization error on startup: {e}")
        
    # Start a daemon thread that periodically checks and fetches
    try:
        t = threading.Thread(target=background_periodic_worker, kwargs={'interval_hours': 24}, daemon=True)
        t.start()
        threading.Thread(target=_warm_home_cache_loop, daemon=True).start()
    except Exception as e:
        print(f"startup_periodic_fetch error: {e}")


@app.post("/admin/refresh_movies")
def refresh_movies(request: Request, background_tasks: BackgroundTasks, kind: str = 'movies', pages: int = 2):
    """Manual trigger to refresh movies/shows ingestion. Protected by ADMIN_TRIGGER_TOKEN if set."""
    # If ADMIN_TRIGGER_TOKEN is configured, require it in X-ADMIN-TOKEN header
    token = os.getenv('ADMIN_TRIGGER_TOKEN')
    if token:
        header = request.headers.get('X-ADMIN-TOKEN')
        if not header or header != token:
            return {"ok": False, "reason": "forbidden"}

    if not TMDB_API_KEY:
        return {"ok": False, "reason": "No TMDB API key configured"}

    if kind not in ('movies', 'shows', 'all'):
        return {"ok": False, "reason": "invalid kind"}

    background_tasks.add_task(run_fetch, kind, pages)
    return {"ok": True, "scheduled": True, "kind": kind}

@app.post("/admin/train_model")
def train_model():
    """Trigger recommender model training in background (Stubbed for streaming-only build)."""
    return {"ok": True, "message": "ML training is disabled for this build."}

def get_media_item(db, tmdb_id):
    # Helper to find item in either table
    movie = db.query(models.Movie).filter(models.Movie.tmdb_id == tmdb_id).first()
    if movie: 
        return movie, 'movie'
    
    show = db.query(models.TVShow).filter(models.TVShow.tmdb_id == tmdb_id).first()
    if show: 
        return show, 'tv'
    
    return None, None

@app.get("/movie/{tmdb_id}/prediction")
def get_revenue_prediction(tmdb_id: int, db: Session = Depends(get_db)):
    return {"prediction": "N/A", "label": "UNKNOWN", "value": "N/A"}

@app.get("/predict/genre/{tmdb_id}")
def get_genre_prediction(tmdb_id: int, db: Session = Depends(get_db)):
    """Predict genres from plot (Replaced with DB lookup)."""
    item, type_ = get_media_item(db, tmdb_id)

    # If we have genres in DB, use them
    if item and item.genres:
        genres = normalize_genres(item.genres)
        genres_with_score = [{"id": g.get("id"), "name": g.get("name"), "score": 1.0} for g in genres]
        primary = genres_with_score[0] if genres_with_score else None
        return {"genres": genres_with_score, "primary": primary}

    # Fallback to TMDB metadata when DB lacks genres
    if TMDB_API_KEY:
        try:
            m_url = f"{TMDB_BASE_URL}/movie/{tmdb_id}?api_key={TMDB_API_KEY}&language=en-US"
            t_url = f"{TMDB_BASE_URL}/tv/{tmdb_id}?api_key={TMDB_API_KEY}&language=en-US"
            resp = requests.get(m_url, timeout=5)
            if resp.status_code != 200:
                resp = requests.get(t_url, timeout=5)
            data = resp.json() if resp.status_code == 200 else {}
            g_list = data.get("genres", []) or []
            genres = [{"id": g.get("id"), "name": g.get("name"), "score": 1.0} for g in g_list if g.get("name")]
            primary = genres[0] if genres else None
            return {"genres": genres, "primary": primary}
        except Exception:
            pass

    return {"genres": [], "primary": None}
    
@app.get("/related/{tmdb_id}")
@_ttl_cache(1800)
def get_related_movies(tmdb_id: int, db: Session = Depends(get_db)):
    """
    Smart 'More Like This' using a 3-tier strategy:
      1. TMDB collection (same franchise/universe — e.g. all MCU, all Harry Potter)
      2. TMDB /recommendations + /similar (cast/crew/keyword overlap — near-perfect results)
      3. Local genre Jaccard fallback (when TMDB API unavailable)
    Results are cross-referenced with the local DB so every card is playable.
    """
    movie = db.query(models.Movie).filter(models.Movie.tmdb_id == tmdb_id).first()
    show = db.query(models.TVShow).filter(models.TVShow.tmdb_id == tmdb_id).first()
    is_tv = bool(show and not movie)
    media_type = "tv" if is_tv else "movie"

    # --- TIER 1 + 2: Use TMDB APIs ------------------------------------------
    if TMDB_API_KEY:
        tmdb_ids_seen = set()
        ordered_results = []

        try:
            base_type = "tv" if is_tv else "movie"

            # TIER 1: Collection / franchise (movies only — TV doesn't have collections)
            if not is_tv:
                detail_url = f"{TMDB_BASE_URL}/movie/{tmdb_id}?api_key={TMDB_API_KEY}&language=en-US"
                detail = requests.get(detail_url, timeout=5).json()
                collection = detail.get("belongs_to_collection")
                if collection and collection.get("id"):
                    coll_url = f"{TMDB_BASE_URL}/collection/{collection['id']}?api_key={TMDB_API_KEY}&language=en-US"
                    coll_data = requests.get(coll_url, timeout=5).json()
                    for part in coll_data.get("parts", []):
                        pid = part.get("id")
                        if pid and pid != tmdb_id and pid not in tmdb_ids_seen:
                            tmdb_ids_seen.add(pid)
                            # Try to find in local DB first
                            local = db.query(models.Movie).filter(models.Movie.tmdb_id == pid).first()
                            if local:
                                ordered_results.append(dict(jsonable_encoder(local), media_type="movie"))
                            else:
                                # Use TMDB data directly so the card renders (poster, title)
                                ordered_results.append({
                                    "tmdb_id": pid, "title": part.get("title", ""),
                                    "poster_path": part.get("poster_path"),
                                    "overview": part.get("overview", ""),
                                    "release_date": part.get("release_date", ""),
                                    "media_type": "movie",
                                    "popularity_score": part.get("popularity", 0),
                                })

            # TIER 2: TMDB recommendations + similar
            for endpoint in ["recommendations", "similar"]:
                if len(ordered_results) >= 12:
                    break
                rec_url = f"{TMDB_BASE_URL}/{base_type}/{tmdb_id}/{endpoint}?api_key={TMDB_API_KEY}&language=en-US&page=1"
                rec_data = requests.get(rec_url, timeout=5).json()
                for item in rec_data.get("results", [])[:15]:
                    iid = item.get("id")
                    if not iid or iid in tmdb_ids_seen or iid == tmdb_id:
                        continue
                    tmdb_ids_seen.add(iid)
                    if is_tv:
                        local = db.query(models.TVShow).filter(models.TVShow.tmdb_id == iid).first()
                        if local:
                            ordered_results.append(dict(jsonable_encoder(local), media_type="tv"))
                        else:
                            ordered_results.append({
                                "tmdb_id": iid, "name": item.get("name", ""),
                                "poster_path": item.get("poster_path"),
                                "overview": item.get("overview", ""),
                                "first_air_date": item.get("first_air_date", ""),
                                "media_type": "tv",
                                "popularity_score": item.get("popularity", 0),
                            })
                    else:
                        local = db.query(models.Movie).filter(models.Movie.tmdb_id == iid).first()
                        if local:
                            ordered_results.append(dict(jsonable_encoder(local), media_type="movie"))
                        else:
                            ordered_results.append({
                                "tmdb_id": iid, "title": item.get("title", ""),
                                "poster_path": item.get("poster_path"),
                                "overview": item.get("overview", ""),
                                "release_date": item.get("release_date", ""),
                                "media_type": "movie",
                                "popularity_score": item.get("popularity", 0),
                            })
                    if len(ordered_results) >= 12:
                        break

            if ordered_results:
                return ordered_results[:12]
        except Exception as e:
            print(f"TMDB related lookup failed: {e}")

    # --- TIER 3: Local genre Jaccard fallback --------------------------------
    if is_tv and show:
        src_genres = genre_id_set(show.genres)
        max_pop = db.query(func.max(models.TVShow.popularity_score)).scalar() or 1
        candidates = db.query(models.TVShow).filter(models.TVShow.id != show.id, models.TVShow.popularity_score.isnot(None)).limit(600).all()
        scored = []
        for cand in candidates:
            j = 0
            if src_genres:
                inter = src_genres.intersection(genre_id_set(cand.genres))
                union = src_genres.union(genre_id_set(cand.genres))
                j = (len(inter) / len(union)) if union else 0
            pop_norm = (cand.popularity_score or 0) / max_pop
            hybrid = 0.7 * j + 0.3 * pop_norm
            scored.append((cand, hybrid))
        scored.sort(key=lambda x: x[1], reverse=True)
        return [dict(jsonable_encoder(s[0]), media_type="tv") for s in scored[:10]]

    if movie:
        src_genres = genre_id_set(movie.genres)
        max_pop = db.query(func.max(models.Movie.popularity_score)).scalar() or 1
        candidates = db.query(models.Movie).filter(models.Movie.id != movie.id, models.Movie.popularity_score.isnot(None)).limit(900).all()
        scored = []
        for cand in candidates:
            inter = src_genres.intersection(genre_id_set(cand.genres)) if src_genres else set()
            union = src_genres.union(genre_id_set(cand.genres)) if src_genres else genre_id_set(cand.genres)
            j = (len(inter) / len(union)) if union else 0
            pop_norm = (cand.popularity_score or 0) / max_pop
            hybrid = 0.7 * j + 0.3 * pop_norm
            scored.append((cand, hybrid))
        scored.sort(key=lambda x: x[1], reverse=True)
        return [dict(jsonable_encoder(s[0]), media_type="movie") for s in scored[:10]]

    popular = db.query(models.Movie).order_by(models.Movie.popularity_score.desc()).limit(10).all()
    return [dict(jsonable_encoder(m), media_type="movie") for m in popular]

# --- 2. CORE FEATURES ---

@app.get("/search")
def search_content(query: str, db: Session = Depends(get_db)):
    local_movies = db.query(models.Movie).filter(models.Movie.title.ilike(f"%{query}%")).limit(5).all()
    local_shows = db.query(models.TVShow).filter(models.TVShow.title.ilike(f"%{query}%")).limit(5).all()
    
    if len(local_movies) + len(local_shows) > 0:
        results = []
        for m in local_movies:
            payload = jsonable_encoder(m)
            payload["media_type"] = "movie"
            results.append(payload)
        for s in local_shows:
            payload = jsonable_encoder(s)
            payload["media_type"] = "tv"
            results.append(payload)
        return results
    
    if not TMDB_API_KEY: 
        return []
    
    url = f"https://api.themoviedb.org/3/search/multi?api_key={TMDB_API_KEY}&query={query}&include_adult=false"
    data = requests.get(url).json()
    
    results = []
    for item in data.get('results', []):
        if item['media_type'] == 'movie':
            if not db.query(models.Movie).filter_by(tmdb_id=item['id']).first():
                movie = models.Movie(
                    title=item.get('title'), tmdb_id=item.get('id'), overview=item.get('overview'),
                    poster_path=item.get('poster_path'), popularity_score=item.get('popularity'),
                    release_date=item.get('release_date')
                )
                db.add(movie)
                results.append(jsonable_encoder(movie) | {"media_type": "movie"})
        elif item['media_type'] == 'tv':
            if not db.query(models.TVShow).filter_by(tmdb_id=item['id']).first():
                show = models.TVShow(
                    title=item.get('name'), tmdb_id=item.get('id'), overview=item.get('overview'),
                    poster_path=item.get('poster_path'), popularity_score=item.get('popularity')
                )
                db.add(show)
                results.append(jsonable_encoder(show) | {"media_type": "tv"})
    try:
        db.commit()
    except Exception: 
        db.rollback()
    return results

@app.get("/play/{media_type}/{tmdb_id}")
async def play_content(media_type: str, tmdb_id: int, season: int = 1, episode: int = 1, provider: str = None):
    scraper = UniversalScraper()
    target_provider = None if provider == "auto" else provider
    result = await scraper.get_stream(tmdb_id, media_type, season, episode, target_provider)
    if not result:
        return {"url": "https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8", "type": "direct", "source": "Test Stream"}
    return result

# ─── Direct Stream Provider Engine ───────────────────────────────
# Returns direct HLS/MP4 streams (NOT embeds) with captions.
# Tries all providers in rank order.
_provider_engine = ProviderEngine(timeout=12)

@app.get("/stream/{media_type}/{tmdb_id}")
async def stream_content(media_type: str, tmdb_id: int, season: int = 1, episode: int = 1, source: str = None, db: Session = Depends(get_db)):
    """Resolve direct streams via the provider engine. Returns HLS/MP4 URLs."""
    # Build media context with title from DB/TMDB
    title = ""
    imdb_id = None
    year = 0
    genres = []
    original_language = ""
    try:
        item = db.query(models.Movie if media_type == "movie" else models.TVShow).filter_by(tmdb_id=tmdb_id).first()
    except Exception:
        item = None  # DB may be offline — not critical for streaming
    if item:
        title = item.title or ""
        imdb_id = getattr(item, "imdb_id", None)
        rd = getattr(item, "release_date", "") or ""
        year = int(rd[:4]) if rd and rd[:4].isdigit() else 0
    # Always try TMDB for IMDB ID + genre/language info
    if TMDB_API_KEY:
        try:
            ep = "movie" if media_type == "movie" else "tv"
            r = requests.get(f"https://api.themoviedb.org/3/{ep}/{tmdb_id}?api_key={TMDB_API_KEY}&append_to_response=external_ids", timeout=4)
            if r.ok:
                d = r.json()
                if not title:
                    title = d.get("title") or d.get("name", "")
                if not imdb_id:
                    imdb_id = d.get("imdb_id") or (d.get("external_ids") or {}).get("imdb_id")
                if not year:
                    yr = d.get("release_date") or d.get("first_air_date", "")
                    year = int(yr[:4]) if yr and yr[:4].isdigit() else 0
                genres = [g.get("name", "") for g in d.get("genres", [])]
                original_language = d.get("original_language", "")
        except Exception:
            pass

    # Detect anime: Animation genre + Japanese language
    is_anime = ("Animation" in genres and original_language == "ja")

    media = MediaContext(
        tmdb_id=tmdb_id,
        imdb_id=imdb_id,
        title=title,
        year=year,
        media_type=media_type,
        season=season,
        episode=episode,
        is_anime=is_anime,
        genres=genres,
    )

    try:
        if source:
            result = await _provider_engine.run_source(source, media)
        else:
            result = await _provider_engine.run_all(media)
    except Exception as e:
        logging.error(f"Provider engine error: {e}")
        result = None

    if result:
        return result.to_dict()

    # No direct HLS/MP4 stream found from any provider
    return {"error": "No streams found", "stream": None}

@app.get("/stream/providers")
async def list_providers():
    """List all available source and embed scrapers with their ranks."""
    return {
        "sources": _provider_engine.list_sources(),
        "embeds": _provider_engine.list_embeds(),
    }

@app.get("/stream/hunt/{media_type}/{tmdb_id}")
async def hunt_all_streams(media_type: str, tmdb_id: int, season: int = 1, episode: int = 1, db: Session = Depends(get_db)):
    """Scan ALL providers concurrently, return every working stream found."""
    title = ""
    imdb_id = None
    year = 0
    genres = []
    original_language = ""
    try:
        item = db.query(models.Movie if media_type == "movie" else models.TVShow).filter_by(tmdb_id=tmdb_id).first()
    except Exception:
        item = None  # DB may be offline — not critical for streaming
    if item:
        title = item.title or ""
        imdb_id = getattr(item, "imdb_id", None)
        rd = getattr(item, "release_date", "") or ""
        year = int(rd[:4]) if rd and rd[:4].isdigit() else 0
    if TMDB_API_KEY:
        try:
            ep = "movie" if media_type == "movie" else "tv"
            r = requests.get(f"https://api.themoviedb.org/3/{ep}/{tmdb_id}?api_key={TMDB_API_KEY}&append_to_response=external_ids", timeout=4)
            if r.ok:
                d = r.json()
                if not title:
                    title = d.get("title") or d.get("name", "")
                if not imdb_id:
                    imdb_id = d.get("imdb_id") or (d.get("external_ids") or {}).get("imdb_id")
                if not year:
                    yr = d.get("release_date") or d.get("first_air_date", "")
                    year = int(yr[:4]) if yr and yr[:4].isdigit() else 0
                genres = [g.get("name", "") for g in d.get("genres", [])]
                original_language = d.get("original_language", "")
        except Exception:
            pass

    is_anime = ("Animation" in genres and original_language == "ja")

    media = MediaContext(
        tmdb_id=tmdb_id, imdb_id=imdb_id, title=title, year=year,
        media_type=media_type, season=season, episode=episode,
        is_anime=is_anime, genres=genres,
    )

    results = await _provider_engine.run_all_streams(media)
    return {
        "streams": [r.to_dict() for r in results],
        "count": len(results),
    }

# One pooled HTTP client for the proxy — keepalive across the dozens of small
# .ts segment fetches per playlist (no fresh TLS handshake each time). Lives for
# the process; StreamingResponse keeps the upstream connection open until drained.
_PROXY_CLIENT: httpx.AsyncClient | None = None

def _get_proxy_client() -> httpx.AsyncClient:
    global _PROXY_CLIENT
    if _PROXY_CLIENT is None or _PROXY_CLIENT.is_closed:
        _PROXY_CLIENT = httpx.AsyncClient(
            follow_redirects=True,
            timeout=httpx.Timeout(20.0, connect=8.0, read=None),
            limits=httpx.Limits(max_keepalive_connections=50, max_connections=200,
                                keepalive_expiry=30.0),
        )
    return _PROXY_CLIENT


@app.get("/proxy_stream")
async def proxy_stream(url: str, request: Request, referer: str = None, origin: str = None):
    import re as _re
    from urllib.parse import urljoin, urlencode
    from starlette.background import BackgroundTask

    headers = { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" }
    if referer:
        headers["Referer"] = referer
    if origin:
        headers["Origin"] = origin
    # Forward the browser's Range header so MP4/segment seeking works and the
    # player doesn't have to re-buffer the whole file.
    client_range = request.headers.get("range")
    if client_range:
        headers["Range"] = client_range
    # Ask upstream NOT to gzip — we stream raw bytes through, so compressed bytes
    # would corrupt manifests and break Content-Length on segments.
    headers["Accept-Encoding"] = "identity"

    def _make_proxy_url(raw_url: str) -> str:
        """Build a /proxy_stream URL preserving referer/origin."""
        abs_url = urljoin(url, raw_url)
        pp = {"url": abs_url}
        if referer: pp["referer"] = referer
        if origin:  pp["origin"] = origin
        return f"/proxy_stream?{urlencode(pp)}"

    def _rewrite_uri_attr(line_text: str) -> str:
        """Rewrite all URI=\"...\" attributes in an HLS tag line."""
        def _replace(m):
            return f'URI="{_make_proxy_url(m.group(1))}"'
        return _re.sub(r'URI="([^"]+)"', _replace, line_text)

    is_manifest_ext = url.split("?")[0].rstrip("/").endswith((".m3u8", ".m3u"))

    client = _get_proxy_client()
    try:
        req = client.build_request("GET", url, headers=headers)
        resp = await client.send(req, stream=True)
    except Exception as e:
        logging.error(f"[proxy_stream] Failed to fetch {url}: {e}")
        return Response(content=f"Proxy fetch error: {e}", status_code=502,
                        headers={"Access-Control-Allow-Origin": "*"})

    content_type = resp.headers.get("content-type", "").lower()
    is_manifest = is_manifest_ext or "mpegurl" in content_type or "x-mpegurl" in content_type

    if is_manifest:
        # Small text body — read it fully (httpx decompresses), rewrite every sub-URL.
        try:
            text = (await resp.aread()).decode("utf-8", errors="replace")
        finally:
            await resp.aclose()
        rewritten = []
        for line in text.split("\n"):
            stripped = line.strip()
            if not stripped:
                rewritten.append(line)
            elif not stripped.startswith("#"):
                rewritten.append(_make_proxy_url(stripped))
            elif 'URI="' in stripped:
                rewritten.append(_rewrite_uri_attr(stripped))
            else:
                rewritten.append(line)
        return Response(content="\n".join(rewritten), media_type="application/vnd.apple.mpegurl",
                        headers={
                            "Access-Control-Allow-Origin": "*",
                            "Access-Control-Allow-Headers": "*",
                            "Cache-Control": "no-cache",
                        })

    # Binary segment / MP4 — zero-buffer streaming passthrough (no RAM blow-up),
    # preserving status (206 for Range) and the byte-range headers for seeking.
    resp_headers = {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "*",
        "Access-Control-Expose-Headers": "Content-Length, Content-Range, Accept-Ranges",
        "Accept-Ranges": resp.headers.get("accept-ranges", "bytes"),
    }
    if "content-length" in resp.headers:
        resp_headers["Content-Length"] = resp.headers["content-length"]
    if "content-range" in resp.headers:
        resp_headers["Content-Range"] = resp.headers["content-range"]

    return StreamingResponse(
        resp.aiter_raw(),
        status_code=resp.status_code,
        media_type=resp.headers.get("content-type"),
        headers=resp_headers,
        background=BackgroundTask(resp.aclose),
    )

@app.options("/proxy_stream")
async def proxy_stream_options():
    """Handle CORS preflight for proxy requests."""
    return Response(
        status_code=204,
        headers={
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, OPTIONS",
            "Access-Control-Allow-Headers": "*",
            "Access-Control-Max-Age": "86400",
        },
    )

@app.get("/proxy_subtitle")
async def proxy_subtitle(url: str):
    """Proxy subtitle files to avoid CORS issues. Returns raw subtitle text."""
    headers = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"}
    try:
        async with httpx.AsyncClient(follow_redirects=True, timeout=15.0) as client:
            r = await client.get(url, headers=headers)
            content = r.content
            # OpenSubtitles (and some hosts) serve gzipped .srt — decompress.
            if content[:2] == b"\x1f\x8b":
                import gzip as _gz
                try:
                    content = _gz.decompress(content)
                except Exception:
                    pass
            # Try to decode as text
            try:
                text = content.decode("utf-8")
            except UnicodeDecodeError:
                try:
                    text = content.decode("latin-1")
                except Exception:
                    text = content.decode("utf-8", errors="replace")
            return Response(
                content=text,
                media_type="text/plain; charset=utf-8",
                headers={
                    "Access-Control-Allow-Origin": "*",
                    "Access-Control-Allow-Headers": "*",
                    "Cache-Control": "public, max-age=86400",
                },
            )
    except Exception as e:
        logging.error(f"[proxy_subtitle] Failed to fetch {url}: {e}")
        return Response(content=f"Subtitle fetch error: {e}", status_code=502,
                        headers={"Access-Control-Allow-Origin": "*"})

@app.get("/subtitles/{media_type}/{tmdb_id}")
async def get_subtitles(media_type: str, tmdb_id: int, season: int = 1, episode: int = 1):
    """Keyless, unlimited subtitle search via the legacy OpenSubtitles REST API
    (rest.opensubtitles.org — no API key, no daily quota). Covers movies + TV.
    Returns a normalized list using the player's caption shape; each `url` points
    at /proxy_subtitle (which gunzips the OpenSubtitles .gz transparently)."""
    from urllib.parse import quote as _q

    # Resolve IMDb id from TMDB (the legacy API is imdb-keyed)
    imdb_id = None
    if TMDB_API_KEY:
        try:
            ep = "movie" if media_type == "movie" else "tv"
            r = requests.get(
                f"https://api.themoviedb.org/3/{ep}/{tmdb_id}"
                f"?api_key={TMDB_API_KEY}&append_to_response=external_ids", timeout=5)
            if r.ok:
                d = r.json()
                imdb_id = d.get("imdb_id") or (d.get("external_ids") or {}).get("imdb_id")
        except Exception:
            pass
    if not imdb_id:
        return []

    num = imdb_id[2:] if imdb_id.startswith("tt") else imdb_id
    if media_type == "movie":
        path = f"/search/imdbid-{num}"
    else:
        path = f"/search/episode-{episode}/imdbid-{num}/season-{season}"

    try:
        async with httpx.AsyncClient(timeout=15.0, follow_redirects=True) as client:
            resp = await client.get(f"https://rest.opensubtitles.org{path}",
                                    headers={"User-Agent": "Nautilus v1"})
        data = resp.json() if resp.status_code == 200 else []
    except Exception as e:
        logging.error(f"[subtitles] {e}")
        return []

    out = []
    for s in (data if isinstance(data, list) else []):
        dl = s.get("SubDownloadLink")
        if not dl:
            continue
        fmt = (s.get("SubFormat") or "srt").lower()
        out.append({
            "url": f"/proxy_subtitle?url={_q(dl, safe='')}",
            "lang": (s.get("ISO639") or (s.get("SubLanguageID") or "")[:2] or "en"),
            "format": "vtt" if fmt == "vtt" else "srt",
            "display": s.get("LanguageName") or s.get("SubLanguageID") or "Unknown",
            "hearing_impaired": s.get("SubHearingImpaired") == "1",
            "downloads": int(s.get("SubDownloadsCnt") or 0),
            "source": "opensubtitles",
        })
    # Most-downloaded first (best quality/sync), cap the payload.
    out.sort(key=lambda x: -x["downloads"])
    return out[:60]


class ProgressInput(BaseModel):
    guest_id: str
    media_type: str
    tmdb_id: int
    season: int = 0
    episode: int = 0
    position_seconds: float = 0
    duration_seconds: float = 0


@app.post("/progress")
def save_progress(p: ProgressInput, db: Session = Depends(get_db)):
    """Upsert watch progress (server-backed, keyed by guest id)."""
    pct = (p.position_seconds / p.duration_seconds * 100.0) if p.duration_seconds else 0.0
    row = db.query(models.WatchProgress).filter_by(
        guest_id=p.guest_id, media_type=p.media_type, tmdb_id=p.tmdb_id,
        season=p.season, episode=p.episode).first()
    if row:
        row.position_seconds = p.position_seconds
        row.duration_seconds = p.duration_seconds
        row.percentage = pct
    else:
        db.add(models.WatchProgress(
            guest_id=p.guest_id, media_type=p.media_type, tmdb_id=p.tmdb_id,
            season=p.season, episode=p.episode, position_seconds=p.position_seconds,
            duration_seconds=p.duration_seconds, percentage=pct))
    try:
        db.commit()
    except Exception:
        db.rollback()
    return {"ok": True, "percentage": round(pct, 1)}


@app.get("/progress/{guest_id}")
def get_all_progress(guest_id: str, db: Session = Depends(get_db)):
    rows = (db.query(models.WatchProgress)
            .filter_by(guest_id=guest_id)
            .order_by(models.WatchProgress.updated_at.desc()).all())
    return [jsonable_encoder(r) for r in rows]


@app.get("/progress/{guest_id}/{tmdb_id}")
def get_item_progress(guest_id: str, tmdb_id: int, db: Session = Depends(get_db)):
    rows = db.query(models.WatchProgress).filter_by(guest_id=guest_id, tmdb_id=tmdb_id).all()
    return [jsonable_encoder(r) for r in rows]


@app.post("/users/avatar")
async def upload_avatar(file: UploadFile = File(...)):
    os.makedirs("src/static/avatars", exist_ok=True)
    file_location = f"src/static/avatars/{file.filename}"
    with open(file_location, "wb") as buffer:
        shutil.copyfileobj(file.file, buffer)
    return {"info": f"Avatar updated: {file.filename}"}

def _tmdb_discover(media, genre, year, sort, skip, limit):
    """Accurate genre/year browsing via TMDB discover — the DB's release dates are
    sparse, so filtering there misses most titles. Returns frontend-shaped dicts,
    or None if TMDB is unavailable."""
    if not TMDB_API_KEY:
        return None
    if media == 'movie':
        sort_map = {'title': 'title.asc', 'year': 'primary_release_date.desc',
                    'rating': 'vote_average.desc', 'popularity': 'popularity.desc'}
        year_param = 'primary_release_year'
    else:
        sort_map = {'title': 'name.asc', 'year': 'first_air_date.desc',
                    'rating': 'vote_average.desc', 'popularity': 'popularity.desc'}
        year_param = 'first_air_date_year'
    tmdb_sort = sort_map.get(sort, 'popularity.desc')
    out = []
    max_pages = min(((skip + limit) // 20) + 2, 12)
    try:
        for pg in range(1, max_pages + 1):
            params = {'api_key': TMDB_API_KEY, 'sort_by': tmdb_sort, 'page': pg,
                      'language': 'en-US', 'vote_count.gte': 10}
            if genre:
                params['with_genres'] = genre
            if year:
                params[year_param] = year
            r = requests.get(f"{TMDB_BASE_URL}/discover/{media}", params=params, timeout=8)
            if r.status_code != 200:
                break
            results = r.json().get('results', [])
            if not results:
                break
            for it in results:
                if not it.get('poster_path'):
                    continue
                if media == 'movie':
                    out.append({'tmdb_id': it.get('id'), 'title': it.get('title', ''),
                                'poster_path': it.get('poster_path'), 'overview': it.get('overview', ''),
                                'release_date': it.get('release_date', ''),
                                'popularity_score': it.get('popularity', 0), 'media_type': 'movie'})
                else:
                    out.append({'tmdb_id': it.get('id'), 'name': it.get('name', ''), 'title': it.get('name', ''),
                                'poster_path': it.get('poster_path'), 'overview': it.get('overview', ''),
                                'first_air_date': it.get('first_air_date', ''),
                                'popularity_score': it.get('popularity', 0), 'media_type': 'tv'})
            if len(out) >= skip + limit:
                break
    except Exception as e:
        print(f"TMDB discover error: {e}")
    return out[skip:skip + limit]


@app.get("/movies")
def get_movies(skip: int = 0, limit: int = 50, genre: int = None, sort: str = "popularity",
               year: int = None, db: Session = Depends(get_db)):
    """List movies with optional genre, year, and sort filters."""
    if year:
        disc = _tmdb_discover('movie', genre, year, sort, skip, limit)
        if disc is not None:
            return disc
    q = db.query(models.Movie)

    # Sort
    if sort == "title":
        q = q.order_by(models.Movie.title.asc())
    elif sort == "year":
        q = q.order_by(models.Movie.release_date.desc())
    elif sort == "rating":
        q = q.order_by(models.Movie.popularity_score.desc())  # best proxy
    else:  # popularity (default)
        q = q.order_by(models.Movie.popularity_score.desc())

    candidates = q.limit(3000).all()

    # Filter by genre + year in Python (DB genres may be None/unsupported JSON)
    filtered = []
    for m in candidates:
        if genre:
            ids = genre_id_set(m.genres)
            if genre not in ids:
                continue
        if year and m.release_date:
            try:
                if not m.release_date.startswith(str(year)):
                    continue
            except Exception:
                continue
        filtered.append(m)

    # If genre filter returned nothing, try TMDB discover
    if genre and not filtered and TMDB_API_KEY:
        try:
            page_num = (skip // limit) + 1
            tmdb_sort = "popularity.desc"
            if sort == "title": tmdb_sort = "title.asc"
            elif sort == "year": tmdb_sort = "primary_release_date.desc"
            elif sort == "rating": tmdb_sort = "vote_average.desc"
            url = f"{TMDB_BASE_URL}/discover/movie?api_key={TMDB_API_KEY}&with_genres={genre}&sort_by={tmdb_sort}&page={page_num}&language=en-US"
            if year:
                url += f"&primary_release_year={year}"
            resp = requests.get(url, timeout=8)
            if resp.status_code == 200:
                for item in resp.json().get("results", []):
                    filtered.append({
                        "tmdb_id": item.get("id"), "title": item.get("title", ""),
                        "poster_path": item.get("poster_path"),
                        "overview": item.get("overview", ""),
                        "release_date": item.get("release_date", ""),
                        "popularity_score": item.get("popularity", 0),
                        "media_type": "movie"
                    })
        except Exception as e:
            print(f"TMDB discover fallback error: {e}")

    return filtered[skip:skip + limit]


@app.get("/movies/new_releases")
@_ttl_cache(1800)
def api_movies_new_releases(days: int = 60, limit: int = 50, db: Session = Depends(get_db)):
    """Return movies released within the last `days`. No hard cap on returned count except `limit`."""
    from datetime import datetime as _dt
    cutoff = (_dt.utcnow() - timedelta(days=days)).date()
    # Fetch recent movies by release_date descending (strings expected 'YYYY-MM-DD')
    candidates = db.query(models.Movie).filter(models.Movie.release_date.isnot(None)).order_by(models.Movie.release_date.desc()).limit(2000).all()
    out = []
    for m in candidates:
        try:
            rd = m.release_date
            if not rd:
                continue
            d = _dt.fromisoformat(rd).date()
            if d <= _dt.utcnow().date() and d >= cutoff:
                out.append(m)
        except Exception:
            continue
        if len(out) >= limit:
            break
    return out


@app.get("/movies/top_rated_alltime")
@_ttl_cache(3600)
def api_movies_top_rated(limit: int = 50, skip: int = 0, min_votes: int = 5, db: Session = Depends(get_db)):
    """Return all-time top rated movies. Prefer DB Interaction averages; fallback to MovieLens raw ratings files if needed."""
    # 1) Try DB interactions
    q = db.query(
        models.Movie.id,
        models.Movie.title,
        models.Movie.tmdb_id,
        func.avg(models.Interaction.rating_value).label('avg_rating'),
        func.count(models.Interaction.id).label('vote_count')
    ).join(models.Interaction, models.Interaction.movie_id == models.Movie.id).group_by(models.Movie.id).having(func.count(models.Interaction.id) >= min_votes).order_by(func.avg(models.Interaction.rating_value).desc()).offset(skip).limit(limit).all()

    # If DB has a healthy number of rated movies, prefer that (site-specific ratings)
    MIN_ACCEPTABLE_DB_RESULTS = 10
    if q and len(q) >= MIN_ACCEPTABLE_DB_RESULTS:
        # Return Movie objects joined with stats
        out = []
        for row in q:
            m = db.query(models.Movie).filter(models.Movie.id == row.id).first()
            data = {
                'title': row.title,
                'tmdb_id': row.tmdb_id,
                'avg_rating': float(row.avg_rating),
                'vote_count': int(row.vote_count),
                'poster_path': m.poster_path if m else None,
                'release_date': m.release_date if m else None,
                'popularity_score': m.popularity_score if m else None,
                'overview': m.overview if m else None
            }
            out.append(data)
        return out

    # If DB ratings are sparse (few movies), fall back to MovieLens historical ratings
    # so we can surface all-time classics rather than site-specific popular items.

    # 1.5) Check for a precomputed MovieLens cache to avoid streaming large CSVs
    try:
        cache_path = Path('data/processed/top_rated_movies.json')
        if cache_path.exists():
            try:
                payload = json.loads(cache_path.read_text(encoding='utf-8'))
                items = payload.get('items', [])[skip:skip+limit]
                cached_out = []
                for it in items:
                    tmdb = it.get('tmdb_id')
                    avg = it.get('avg_rating')
                    cnt = it.get('vote_count')
                    title = it.get('title')
                    m = None
                    if tmdb:
                        # tmdb ids in cache may be strings; try to coerce
                        try:
                            tid = int(tmdb)
                        except Exception:
                            tid = tmdb
                        m = db.query(models.Movie).filter(models.Movie.tmdb_id == tid).first()

                    rec = {
                        'title': title if title else (m.title if m else None),
                        'tmdb_id': int(tmdb) if tmdb is not None else None,
                        'avg_rating': float(avg) if avg is not None else None,
                        'vote_count': int(cnt) if cnt is not None else None,
                        'poster_path': m.poster_path if m else None,
                        'release_date': m.release_date if m else None,
                        'popularity_score': m.popularity_score if m else None,
                        'overview': m.overview if m else None
                    }
                    cached_out.append(rec)
                if cached_out:
                    return cached_out
            except Exception as e:
                print(f"cache read error: {e}")
    except Exception:
        pass

    # 2) Fallback to MovieLens ratings files (streaming CSV) if present
    import csv
    import glob
    links_paths = glob.glob('data/raw/**/links.csv', recursive=True)
    ratings_paths = glob.glob('data/raw/**/ratings.csv', recursive=True)
    if not links_paths or not ratings_paths:
        # No fallback available, use popularity as last resort
        movies = db.query(models.Movie).order_by(models.Movie.popularity_score.desc()).offset(skip).limit(limit).all()
        return [{ 'title': m.title, 'tmdb_id': m.tmdb_id, 'popularity': m.popularity_score, 'movie': m } for m in movies]

    links_path = links_paths[0]
    ratings_path = ratings_paths[0]

    # Build mapping ml_movieId -> tmdbId
    ml_to_tmdb = {}
    try:
        with open(links_path, newline='', encoding='utf-8') as f:
            r = csv.DictReader(f)
            for row in r:
                try:
                    mlid = int(row.get('movieId') or row.get('movieId'))
                    tmdb = row.get('tmdbId') or row.get('tmdbId')
                    if mlid and tmdb:
                        ml_to_tmdb[mlid] = int(tmdb)
                except Exception:
                    continue
    except Exception as e:
        print(f"links file read error: {e}")

    # Aggregate ratings by ml movie id
    sums = {}
    counts = {}
    try:
        with open(ratings_path, newline='', encoding='utf-8') as f:
            r = csv.DictReader(f)
            for row in r:
                try:
                    mid = int(row.get('movieId'))
                    rating = float(row.get('rating'))
                except Exception:
                    continue
                counts[mid] = counts.get(mid, 0) + 1
                sums[mid] = sums.get(mid, 0.0) + rating
    except Exception as e:
        print(f"ratings file read error: {e}")

    # Compute averages and map to tmdb ids
    avg_list = []
    for mid, cnt in counts.items():
        if cnt < min_votes:
            continue
        tmdb = ml_to_tmdb.get(mid)
        if not tmdb:
            continue
        avg = sums[mid] / cnt
        avg_list.append((tmdb, avg, cnt))

    # Sort by avg desc
    avg_list.sort(key=lambda x: x[1], reverse=True)


    out = []
    for tmdb, avg, cnt in avg_list[skip:skip+limit]:
        m = db.query(models.Movie).filter(models.Movie.tmdb_id == tmdb).first()
        if m:
            out.append({'title': m.title, 'tmdb_id': tmdb, 'avg_rating': float(avg), 'vote_count': int(cnt), 'poster_path': m.poster_path, 'release_date': m.release_date, 'popularity_score': m.popularity_score, 'overview': m.overview})

    if out:
        return out

    # Final fallback: popularity
    movies = db.query(models.Movie).order_by(models.Movie.popularity_score.desc()).offset(skip).limit(limit).all()
    return [{ 'title': m.title, 'tmdb_id': m.tmdb_id, 'popularity': m.popularity_score, 'poster_path': m.poster_path, 'release_date': m.release_date, 'overview': m.overview } for m in movies]



@app.get("/shows")
def get_shows(skip: int = 0, limit: int = 50, genre: int = None, sort: str = "popularity",
              year: int = None, db: Session = Depends(get_db)):
    """List TV shows with optional genre, year, and sort filters."""
    if year:
        disc = _tmdb_discover('tv', genre, year, sort, skip, limit)
        if disc is not None:
            return disc
    q = db.query(models.TVShow)

    if sort == "title":
        q = q.order_by(models.TVShow.title.asc())
    elif sort == "year":
        # TVShow may not have first_air_date column; fall back to popularity
        q = q.order_by(models.TVShow.popularity_score.desc())
    elif sort == "rating":
        q = q.order_by(models.TVShow.popularity_score.desc())
    else:
        q = q.order_by(models.TVShow.popularity_score.desc())

    candidates = q.limit(3000).all()

    filtered = []
    for s in candidates:
        if genre:
            ids = genre_id_set(s.genres)
            if genre not in ids:
                continue
        filtered.append(s)

    # TMDB discover fallback for genre
    if genre and not filtered and TMDB_API_KEY:
        try:
            page_num = (skip // limit) + 1
            url = f"{TMDB_BASE_URL}/discover/tv?api_key={TMDB_API_KEY}&with_genres={genre}&sort_by=popularity.desc&page={page_num}&language=en-US"
            resp = requests.get(url, timeout=8)
            if resp.status_code == 200:
                for item in resp.json().get("results", []):
                    filtered.append({
                        "tmdb_id": item.get("id"), "name": item.get("name", ""),
                        "title": item.get("name", ""),
                        "poster_path": item.get("poster_path"),
                        "overview": item.get("overview", ""),
                        "first_air_date": item.get("first_air_date", ""),
                        "popularity_score": item.get("popularity", 0),
                        "media_type": "tv"
                    })
        except Exception as e:
            print(f"TMDB discover tv fallback error: {e}")

    return filtered[skip:skip + limit]

@app.get("/shows/{show_id}/seasons")
def get_seasons(show_id: int, db: Session = Depends(get_db)):
    """Return seasons with episodes.

    Accepts either internal DB show id or a TMDB id. If the show exists in the DB
    but seasons are not yet ingested, try to fetch them from TMDB and persist.
    If the show is not present in the DB, fetch seasons/episodes directly from
    TMDB and return them (no DB writes).
    """
    # The frontend passes TMDB ids, so look up by tmdb_id FIRST — internal DB ids
    # can collide with TMDB ids and return the wrong show.
    show = db.query(models.TVShow).options(
        joinedload(models.TVShow.seasons).joinedload(models.Season.episodes)
    ).filter(models.TVShow.tmdb_id == show_id).first()

    # Fallback: internal DB id
    if not show:
        show = db.query(models.TVShow).options(
            joinedload(models.TVShow.seasons).joinedload(models.Season.episodes)
        ).filter(models.TVShow.id == show_id).first()

    # If present in DB and has seasons, return them (sorted)
    if show and show.seasons:
        sorted_seasons = sorted(show.seasons, key=lambda s: s.season_number)
        for season in sorted_seasons:
            season.episodes.sort(key=lambda e: e.episode_number)
        return sorted_seasons

    # If present in DB but no seasons ingested, fetch from TMDB and persist
    if show and TMDB_API_KEY:
        try:
            url = f"{TMDB_BASE_URL}/tv/{show.tmdb_id}?api_key={TMDB_API_KEY}&language=en-US"
            resp = requests.get(url, timeout=5)
            if resp.status_code == 200:
                data = resp.json()
            else:
                data = {}
        except Exception:
            data = {}

        for season_meta in data.get("seasons", []):
            s_num = season_meta.get('season_number')
            if s_num is None:
                continue
            season = models.Season(
                show_id=show.id,
                season_number=s_num,
                name=season_meta.get('name'),
                air_date=season_meta.get('air_date')
            )
            db.add(season)
            try:
                db.commit()
                db.refresh(season)
            except Exception:
                db.rollback()
                continue

            # Fetch episodes for this season
            try:
                s_url = f"{TMDB_BASE_URL}/tv/{show.tmdb_id}/season/{s_num}?api_key={TMDB_API_KEY}&language=en-US"
                s_resp = requests.get(s_url, timeout=5)
                if s_resp.status_code == 200:
                    s_data = s_resp.json()
                else:
                    s_data = {}
            except Exception:
                s_data = {}

            for ep in s_data.get('episodes', []):
                try:
                    episode = models.Episode(
                        season_id=season.id,
                        episode_number=ep.get('episode_number'),
                        title=ep.get('name'),
                        overview=ep.get('overview'),
                        air_date=ep.get('air_date'),
                        still_path=ep.get('still_path'),
                        runtime_minutes=ep.get('runtime')
                    )
                    db.add(episode)
                except Exception:
                    continue
            try:
                db.commit()
            except Exception:
                db.rollback()

        try:
            db.refresh(show)
        except Exception:
            pass

        if show.seasons:
            return sorted(show.seasons, key=lambda s: s.season_number)

    # If show not in DB, fetch directly from TMDB and return structured seasons (no DB writes)
    if TMDB_API_KEY:
        try:
            tmdb_url = f"{TMDB_BASE_URL}/tv/{show_id}?api_key={TMDB_API_KEY}&language=en-US"
            tmdb_resp = requests.get(tmdb_url, timeout=5)
            if tmdb_resp.status_code != 200:
                return []
            tmdb_data = tmdb_resp.json()
            seasons_out = []
            for season_meta in tmdb_data.get('seasons', []):
                s_num = season_meta.get('season_number')
                if s_num is None:
                    continue
                season_entry = {
                    'season_number': s_num,
                    'name': season_meta.get('name'),
                    'air_date': season_meta.get('air_date'),
                    'episodes': []
                }
                try:
                    s_url = f"{TMDB_BASE_URL}/tv/{show_id}/season/{s_num}?api_key={TMDB_API_KEY}&language=en-US"
                    s_resp = requests.get(s_url, timeout=5)
                    if s_resp.status_code == 200:
                        s_data = s_resp.json()
                    else:
                        s_data = {}
                except Exception:
                    s_data = {}

                for ep in s_data.get('episodes', []):
                    season_entry['episodes'].append({
                        'episode_number': ep.get('episode_number'),
                        'title': ep.get('name'),
                        'overview': ep.get('overview'),
                        'air_date': ep.get('air_date'),
                        'runtime_minutes': ep.get('runtime'),
                        'still_path': ep.get('still_path')
                    })

                seasons_out.append(season_entry)

            return seasons_out
        except Exception:
            return []

    # No DB record path fell through; return empty
    return []


@app.get("/shows/new_releases")
@_ttl_cache(1800)
def api_shows_new_releases(days: int = 60, limit: int = 50, db: Session = Depends(get_db)):
    """Return shows with episodes aired within the last `days`."""
    from datetime import datetime as _dt
    try:
        cutoff = (_dt.utcnow() - timedelta(days=days)).date().isoformat()
        rows = db.query(models.Season.show_id).join(models.Episode, models.Episode.season_id == models.Season.id).filter(models.Episode.air_date >= cutoff).distinct().all()
        show_ids = [r[0] for r in rows]
        if not show_ids:
            return []
        shows = db.query(models.TVShow).filter(models.TVShow.id.in_(show_ids)).all()
        return shows[:limit]
    except Exception as e:
        print(f"api_shows_new_releases error: {e}")
        return []


@app.get("/shows/top_rated_alltime")
@_ttl_cache(3600)
def api_shows_top_rated(limit: int = 50, skip: int = 0, min_votes: int = 5, db: Session = Depends(get_db)):
    """Top rated shows by user interactions (fallback to popularity)."""
    q = db.query(
        models.TVShow.id,
        models.TVShow.title,
        models.TVShow.tmdb_id,
        func.avg(models.Interaction.rating_value).label('avg_rating'),
        func.count(models.Interaction.id).label('vote_count')
    ).join(models.Interaction, models.Interaction.tv_show_id == models.TVShow.id).group_by(models.TVShow.id).having(func.count(models.Interaction.id) >= min_votes).order_by(func.avg(models.Interaction.rating_value).desc()).offset(skip).limit(limit).all()

    if q and len(q) > 0:
        out = []
        for row in q:
            s = db.query(models.TVShow).filter(models.TVShow.id == row.id).first()
            out.append({'title': row.title, 'tmdb_id': row.tmdb_id, 'avg_rating': float(row.avg_rating), 'vote_count': int(row.vote_count), 'poster_path': s.poster_path if s else None, 'popularity_score': s.popularity_score if s else None})
        return out

    # Fallback: popularity
    shows = db.query(models.TVShow).order_by(models.TVShow.popularity_score.desc()).offset(skip).limit(limit).all()
    return [{'title': s.title, 'tmdb_id': s.tmdb_id, 'popularity': s.popularity_score, 'poster_path': s.poster_path} for s in shows]


@app.get("/trending")
@_ttl_cache(900)
def api_trending(days: int = 7, limit: int = 20, db: Session = Depends(get_db)):
    """Trending movies/shows based on recent interactions; fallback to popularity."""
    from datetime import datetime as _dt, timedelta as _td
    cutoff = _dt.utcnow() - _td(days=days)

    # Movies
    movie_rows = db.query(
        models.Interaction.movie_id,
        func.count(models.Interaction.id).label("cnt")
    ).filter(
        models.Interaction.movie_id.isnot(None),
        models.Interaction.timestamp >= cutoff
    ).group_by(models.Interaction.movie_id).order_by(func.count(models.Interaction.id).desc()).limit(limit).all()
    movie_ids = [r[0] for r in movie_rows if r[0] is not None]
    trending_movies = db.query(models.Movie).filter(models.Movie.id.in_(movie_ids)).all() if movie_ids else []
    # Preserve order
    by_id = {m.id: m for m in trending_movies}
    trending_movies_ordered = [by_id[mid] for mid in movie_ids if mid in by_id]
    if len(trending_movies_ordered) < limit:
        extra = db.query(models.Movie).order_by(models.Movie.popularity_score.desc()).limit(limit - len(trending_movies_ordered)).all()
        trending_movies_ordered.extend(extra)

    # Shows
    show_rows = db.query(
        models.Interaction.tv_show_id,
        func.count(models.Interaction.id).label("cnt")
    ).filter(
        models.Interaction.tv_show_id.isnot(None),
        models.Interaction.timestamp >= cutoff
    ).group_by(models.Interaction.tv_show_id).order_by(func.count(models.Interaction.id).desc()).limit(limit).all()
    show_ids = [r[0] for r in show_rows if r[0] is not None]
    trending_shows = db.query(models.TVShow).filter(models.TVShow.id.in_(show_ids)).all() if show_ids else []
    by_id_s = {s.id: s for s in trending_shows}
    trending_shows_ordered = [by_id_s[sid] for sid in show_ids if sid in by_id_s]
    if len(trending_shows_ordered) < limit:
        extra_s = db.query(models.TVShow).order_by(models.TVShow.popularity_score.desc()).limit(limit - len(trending_shows_ordered)).all()
        trending_shows_ordered.extend(extra_s)

    return {
        "movies": trending_movies_ordered[:limit],
        "shows": trending_shows_ordered[:limit]
    }

@app.get("/recommend/personal/{user_id}")
def get_personal_recs(user_id: int, db: Session = Depends(get_db)):
    """RecSys Fallback: returns popular movies."""
    return db.query(models.Movie).order_by(models.Movie.popularity_score.desc()).limit(12).all()

@app.get("/collections/ai")
@_ttl_cache(3600)
def get_ai_clusters(db: Session = Depends(get_db)):
    """Curated collections replacing AI clusters."""
    # Trending (reuse /trending logic but movies only)
    trending_movies = db.query(models.Movie).order_by(models.Movie.popularity_score.desc()).limit(30).all()

    # Critics' Picks: top rated by interactions fallback popularity
    top_rated = db.query(
        models.Movie.id,
        func.avg(models.Interaction.rating_value).label('avg_rating'),
        func.count(models.Interaction.id).label('vote_count')
    ).join(models.Interaction, models.Interaction.movie_id == models.Movie.id)
    top_rated = top_rated.group_by(models.Movie.id).having(func.count(models.Interaction.id) >= 3).order_by(func.avg(models.Interaction.rating_value).desc()).limit(50).all()
    rated_ids = [r.id for r in top_rated]
    rated_movies = db.query(models.Movie).filter(models.Movie.id.in_(rated_ids)).all() if rated_ids else []
    rated_by_id = {m.id: m for m in rated_movies}
    critics = [rated_by_id[mid] for mid in rated_ids if mid in rated_by_id]
    if len(critics) < 30:
        extra = db.query(models.Movie).order_by(models.Movie.popularity_score.desc()).limit(30 - len(critics)).all()
        critics.extend(extra)

    # Hidden gems: mid-popularity band
    hidden = db.query(models.Movie).filter(models.Movie.popularity_score.isnot(None)).order_by(models.Movie.popularity_score.asc()).limit(40).all()

    return {
        "cluster_1": {"name": "Trending Now", "items": trending_movies},
        "cluster_2": {"name": "Critics' Picks", "items": critics[:40]},
        "cluster_3": {"name": "Hidden Gems", "items": hidden}
    }

class RevenueInput(BaseModel):
    budget: float
    runtime: float
    release_month: int
    release_year: int | None = None
    genres: List[str] = []


_CPI_INDEX = {
    # Approximate CPI-U annual averages (used to compute multiplier). Add/adjust values as needed.
    2000: 172.2, 2001: 177.1, 2002: 179.9, 2003: 184.0, 2004: 188.9,
    2005: 195.3, 2006: 201.6, 2007: 207.3, 2008: 215.3, 2009: 214.5,
    2010: 218.1, 2011: 224.9, 2012: 229.6, 2013: 233.0, 2014: 236.7,
    2015: 237.0, 2016: 240.0, 2017: 245.1, 2018: 251.1, 2019: 255.7,
    2020: 258.8, 2021: 271.0, 2022: 292.7, 2023: 305.1, 2024: 313.0, 2025: 315.0
}


@app.post("/predict/revenue")
def predict_revenue_manual(input_data: RevenueInput, inflation_multiplier: float = 1.0, use_cpi: bool = False):
    """
    Predict revenue based on manual JSON input (Stubbed for streaming-only build).
    """
    return {"prediction": "$100,000,000", "raw_value": 100000000.0, "inflation_multiplier": 1.0, "status": "ML disabled"}

@app.get("/movies/random")
def get_random_movies(limit: int = 20, db: Session = Depends(get_db)):
    return db.query(models.Movie).order_by(func.random()).limit(limit).all()

@app.get("/movies/genre/{genre_id}")
@_ttl_cache(3600)
def get_movies_by_genre(genre_id: int, limit: int = 20, db: Session = Depends(get_db)):
    # Fetch popular movies and filter by genre in Python
    candidates = db.query(models.Movie).order_by(models.Movie.popularity_score.desc()).limit(500).all()
    filtered = []
    for movie in candidates:
        norm = normalize_genres(movie.genres)
        if any(g.get("id") == genre_id for g in norm):
            filtered.append(movie)
        if len(filtered) >= limit:
            break

    # Fallback: use TMDB discover API if DB returned nothing
    if not filtered and TMDB_API_KEY:
        try:
            url = f"{TMDB_BASE_URL}/discover/movie?api_key={TMDB_API_KEY}&with_genres={genre_id}&sort_by=popularity.desc&page=1&language=en-US"
            resp = requests.get(url, timeout=8)
            if resp.status_code == 200:
                for item in resp.json().get("results", [])[:limit]:
                    filtered.append({
                        "tmdb_id": item.get("id"),
                        "title": item.get("title", ""),
                        "poster_path": item.get("poster_path"),
                        "overview": item.get("overview", ""),
                        "release_date": item.get("release_date", ""),
                        "popularity_score": item.get("popularity", 0),
                        "media_type": "movie"
                    })
        except Exception as e:
            print(f"TMDB discover movie fallback error: {e}")

    return filtered

@app.get("/movies/desi")
def get_desi_movies(limit: int = 20):
    """Fetches popular Indian movies (Hindi, Tamil, Telugu, Malayalam) from TMDB."""
    if not TMDB_API_KEY:
        return []
        
    url = f"https://api.themoviedb.org/3/discover/movie?api_key={TMDB_API_KEY}&with_original_language=hi|ta|te|ml&sort_by=popularity.desc&page=1"
    try:
        response = requests.get(url, timeout=5)
        if response.status_code == 200:
            results = response.json().get('results', [])
            # Map TMDB result keys to our frontend expectations if needed
            # Frontend expects: id, title, poster_path, overview, etc.
            # TMDB returns 'id', 'title', 'poster_path', 'overview', 'genre_ids', 'vote_average'
            # This matches well enough.
            return results[:limit]
    except Exception as e:
        print(f"Error fetching Desi movies: {e}")
    return []

class InteractionInput(BaseModel):
    guest_id: str
    item_id: int
    media_type: str  # 'movie' or 'tv'
    action: str      # 'like', 'watch'


def fetch_movie_details(tmdb_id):
    url = f"{TMDB_BASE_URL}/movie/{tmdb_id}?api_key={TMDB_API_KEY}&language=en-US"
    response = requests.get(url, timeout=10)
    if response.status_code != 200:
        return None
    data = response.json()
    return {
        'id': None,  # Let SQLAlchemy autogenerate if needed
        'title': data.get('title'),
        'tmdb_id': data.get('id'),
        'overview': data.get('overview'),
        'release_date': data.get('release_date'),
        'genres': [g['name'] for g in data.get('genres', [])],
        'poster_path': data.get('poster_path'),
        'popularity_score': data.get('popularity'),
        'stream_url': None
    }

# --- Accurate CAM/TS detection via TMDB digital-release dates ---
# A recent movie is "good-quality available" once it has a Digital (type 4) or
# Physical (type 5) release whose date has passed; until then a circulating rip
# is almost certainly a cam/telesync. Checked per-movie, cached for a day.
_AVAIL_CACHE: dict = {}      # tmdb_id -> (epoch, has_digital: bool)
_AVAIL_TTL = 86400

async def _movie_has_digital_release(mid: int):
    now = _t.time()
    hit = _AVAIL_CACHE.get(mid)
    if hit and (now - hit[0]) < _AVAIL_TTL:
        return hit[1]
    try:
        client = _get_proxy_client()
        r = await client.get(
            f"{TMDB_BASE_URL}/movie/{mid}/release_dates",
            params={"api_key": TMDB_API_KEY}, timeout=8.0,
        )
        if r.status_code != 200:
            return None
        has_digital = False
        for country in r.json().get("results", []):
            for rel in country.get("release_dates", []):
                if rel.get("type") in (4, 5):  # 4=Digital, 5=Physical
                    ds = (rel.get("release_date") or "").replace("Z", "+00:00")
                    try:
                        if datetime.fromisoformat(ds).timestamp() <= now:
                            has_digital = True
                            break
                    except Exception:
                        pass
            if has_digital:
                break
        _AVAIL_CACHE[mid] = (now, has_digital)
        return has_digital
    except Exception:
        return None

@app.get("/movies/availability")
async def movies_availability(ids: str):
    """Given comma-separated TMDB movie ids, return which are likely CAM/TS
    (released theatrically but with no digital/physical release yet). Ids whose
    status can't be determined are NOT flagged."""
    id_list = []
    for tok in (ids or "").split(","):
        tok = tok.strip()
        if tok.isdigit():
            id_list.append(int(tok))
    id_list = id_list[:80]
    if not id_list:
        return {"cam": []}
    import asyncio as _asyncio
    results = await _asyncio.gather(*[_movie_has_digital_release(m) for m in id_list])
    cam = [m for m, has in zip(id_list, results) if has is False]
    return {"cam": cam}


def fetch_tv_details(tmdb_id):
    url = f"{TMDB_BASE_URL}/tv/{tmdb_id}?api_key={TMDB_API_KEY}&language=en-US"
    response = requests.get(url, timeout=10)
    if response.status_code != 200:
        return None
    data = response.json()
    return {
        'id': None,
        'title': data.get('name'),
        'tmdb_id': data.get('id'),
        'overview': data.get('overview'),
        'genres': [g['name'] for g in data.get('genres', [])],
        'poster_path': data.get('poster_path'),
        'popularity_score': data.get('popularity')
    }


@app.get("/tv/{tmdb_id}/recommendations")
@_ttl_cache(3600)
def get_tv_recommendations(tmdb_id: int, limit: int = 14):
    """TV 'More like this' — TMDB recommendations (then similar) for a show.
    /related is movie-only, so the show page uses this for real TV results."""
    if not TMDB_API_KEY:
        return []
    out, seen = [], set()
    try:
        for path in ('recommendations', 'similar'):
            r = requests.get(f"{TMDB_BASE_URL}/tv/{tmdb_id}/{path}?api_key={TMDB_API_KEY}&language=en-US&page=1", timeout=6)
            if r.status_code == 200:
                for s in r.json().get('results', []):
                    sid = s.get('id')
                    if sid in seen or not s.get('poster_path'):
                        continue
                    seen.add(sid)
                    out.append({'tmdb_id': sid, 'id': sid, 'media_type': 'tv',
                                'name': s.get('name'), 'title': s.get('name'),
                                'poster_path': s.get('poster_path'),
                                'first_air_date': s.get('first_air_date'),
                                'vote_average': s.get('vote_average')})
            if len(out) >= limit:
                break
    except Exception:
        pass
    return out[:limit]


@app.get("/media/{tmdb_id}")
def get_media_details(tmdb_id: int, media_type: str = None, db: Session = Depends(get_db)):
    """Return lightweight media details (overview, poster, release/first_air_date).
    Tries the DB first, falls back to TMDB when an API key is configured.
    """
    # TMDB ids are NOT unique across movie/tv — honor an explicit media_type
    # (the show page passes media_type=tv).
    if media_type == 'tv':
        # Prefer TMDB for the full field set (first_air_date + vote_average) the
        # show-page badges need; fall back to the DB row when offline/no key.
        if TMDB_API_KEY:
            try:
                t = requests.get(f"{TMDB_BASE_URL}/tv/{tmdb_id}?api_key={TMDB_API_KEY}&language=en-US", timeout=5)
                if t.status_code == 200:
                    td = t.json()
                    return {'tmdb_id': td.get('id'), 'media_type': 'tv', 'title': td.get('name'),
                            'overview': td.get('overview'), 'poster_path': td.get('poster_path'),
                            'first_air_date': td.get('first_air_date'), 'last_air_date': td.get('last_air_date'),
                            'vote_average': td.get('vote_average')}
            except Exception:
                pass
        show = db.query(models.TVShow).filter(models.TVShow.tmdb_id == tmdb_id).first()
        if show:
            return {'tmdb_id': show.tmdb_id, 'media_type': 'tv', 'title': show.title,
                    'overview': show.overview, 'poster_path': show.poster_path,
                    'first_air_date': getattr(show, 'first_air_date', None),
                    'last_air_date': getattr(show, 'last_air_date', None)}
        return {}

    item, type_ = get_media_item(db, tmdb_id)
    if item:
        if type_ == 'movie':
            return {
                'tmdb_id': item.tmdb_id,
                'media_type': 'movie',
                'title': item.title,
                'overview': item.overview,
                'poster_path': item.poster_path,
                'release_date': item.release_date
            }
        else:
            # TV show
            return {
                'tmdb_id': item.tmdb_id,
                'media_type': 'tv',
                'title': item.title,
                'overview': item.overview,
                'poster_path': item.poster_path,
                'first_air_date': getattr(item, 'first_air_date', None)
            }

    # Not in DB: try TMDB (movie first, then tv)
    if not TMDB_API_KEY:
        return {}

    try:
        m_url = f"{TMDB_BASE_URL}/movie/{tmdb_id}?api_key={TMDB_API_KEY}&language=en-US"
        m_resp = requests.get(m_url, timeout=5)
        if m_resp.status_code == 200:
            md = m_resp.json()
            return {
                'tmdb_id': md.get('id'),
                'media_type': 'movie',
                'title': md.get('title'),
                'overview': md.get('overview'),
                'poster_path': md.get('poster_path'),
                'release_date': md.get('release_date')
            }
    except Exception:
        pass

    try:
        t_url = f"{TMDB_BASE_URL}/tv/{tmdb_id}?api_key={TMDB_API_KEY}&language=en-US"
        t_resp = requests.get(t_url, timeout=5)
        if t_resp.status_code == 200:
            td = t_resp.json()
            return {
                'tmdb_id': td.get('id'),
                'media_type': 'tv',
                'title': td.get('name'),
                'overview': td.get('overview'),
                'poster_path': td.get('poster_path'),
                'first_air_date': td.get('first_air_date')
            }
    except Exception:
        pass

    return {}


@app.get("/media/{tmdb_id}/trailer")
@_ttl_cache(3600)
def get_trailer(tmdb_id: int, media_type: str = "movie"):
    """Return YouTube trailer key for a movie or TV show via TMDB /videos endpoint."""
    if not TMDB_API_KEY:
        return {"key": None}

    base = "tv" if media_type == "tv" else "movie"
    try:
        url = f"{TMDB_BASE_URL}/{base}/{tmdb_id}/videos?api_key={TMDB_API_KEY}&language=en-US"
        resp = requests.get(url, timeout=5)
        if resp.status_code != 200:
            return {"key": None}
        results = resp.json().get("results", [])
        # Prefer official trailers, then teasers, then any video on YouTube
        yt = [v for v in results if v.get("site") == "YouTube"]
        official = [v for v in yt if v.get("type") == "Trailer" and v.get("official")]
        trailers = [v for v in yt if v.get("type") == "Trailer"]
        teasers = [v for v in yt if v.get("type") == "Teaser"]
        pick = (official or trailers or teasers or yt)
        if pick:
            return {"key": pick[0]["key"], "name": pick[0].get("name", "Trailer")}
    except Exception:
        pass

    # If movie not found, try TV (sometimes tmdb_id could be either)
    if base == "movie":
        try:
            url2 = f"{TMDB_BASE_URL}/tv/{tmdb_id}/videos?api_key={TMDB_API_KEY}&language=en-US"
            resp2 = requests.get(url2, timeout=5)
            if resp2.status_code == 200:
                results2 = resp2.json().get("results", [])
                yt2 = [v for v in results2 if v.get("site") == "YouTube"]
                pick2 = [v for v in yt2 if v.get("type") == "Trailer"] or yt2
                if pick2:
                    return {"key": pick2[0]["key"], "name": pick2[0].get("name", "Trailer")}
        except Exception:
            pass

    return {"key": None}


# TV genre map (TMDB TV genres that differ from movie genres)
TMDB_TV_GENRE_MAP = {
    10759: "Action & Adventure", 16: "Animation", 35: "Comedy", 80: "Crime",
    99: "Documentary", 18: "Drama", 10751: "Family", 10762: "Kids",
    9648: "Mystery", 10763: "News", 10764: "Reality", 878: "Sci-Fi & Fantasy",
    10765: "Sci-Fi & Fantasy", 10766: "Soap", 10767: "Talk", 10768: "War & Politics",
    37: "Western"
}

@app.get("/genres/overview")
def get_genre_overview(db: Session = Depends(get_db)):
    """Return genre list for the Genre Explore page.
    First tries to count from DB. If DB has no genre data, returns
    the static TMDB genre map so the explore page always works."""
    all_movies = db.query(models.Movie).order_by(models.Movie.popularity_score.desc()).limit(2000).all()
    all_shows = db.query(models.TVShow).order_by(models.TVShow.popularity_score.desc()).limit(500).all()
    counts = {}  # genre_id -> {id, name, movies, shows}
    for m in all_movies:
        for g in normalize_genres(m.genres):
            gid = g.get("id")
            if gid is None:
                continue
            if gid not in counts:
                counts[gid] = {"id": gid, "name": g["name"], "movies": 0, "shows": 0}
            counts[gid]["movies"] += 1
    for s in all_shows:
        for g in normalize_genres(s.genres):
            gid = g.get("id")
            if gid is None:
                continue
            if gid not in counts:
                counts[gid] = {"id": gid, "name": g["name"], "movies": 0, "shows": 0}
            counts[gid]["shows"] += 1

    # If DB has genre data, return it sorted
    if counts:
        result = sorted(counts.values(), key=lambda x: x["movies"] + x["shows"], reverse=True)
        return result

    # Fallback: return static genre map (DB genres are empty)
    static_genres = []
    for gid, name in TMDB_GENRE_MAP.items():
        static_genres.append({"id": gid, "name": name, "movies": 0, "shows": 0})
    # Add TV-specific genres not already covered
    seen_ids = {g["id"] for g in static_genres}
    for gid, name in TMDB_TV_GENRE_MAP.items():
        if gid not in seen_ids:
            static_genres.append({"id": gid, "name": name, "movies": 0, "shows": 0})
    return static_genres


@app.get("/shows/genre/{genre_id}")
def get_shows_by_genre(genre_id: int, limit: int = 20, db: Session = Depends(get_db)):
    """Return TV shows matching a genre ID."""
    candidates = db.query(models.TVShow).order_by(models.TVShow.popularity_score.desc()).limit(500).all()
    filtered = []
    for show in candidates:
        norm = normalize_genres(show.genres)
        if any(g.get("id") == genre_id for g in norm):
            filtered.append(show)
        if len(filtered) >= limit:
            break

    # Fallback: use TMDB discover API if DB returned nothing
    if not filtered and TMDB_API_KEY:
        try:
            url = f"{TMDB_BASE_URL}/discover/tv?api_key={TMDB_API_KEY}&with_genres={genre_id}&sort_by=popularity.desc&page=1&language=en-US"
            resp = requests.get(url, timeout=8)
            if resp.status_code == 200:
                for item in resp.json().get("results", [])[:limit]:
                    filtered.append({
                        "tmdb_id": item.get("id"),
                        "name": item.get("name", ""),
                        "title": item.get("name", ""),
                        "poster_path": item.get("poster_path"),
                        "overview": item.get("overview", ""),
                        "first_air_date": item.get("first_air_date", ""),
                        "popularity_score": item.get("popularity", 0),
                        "media_type": "tv"
                    })
        except Exception as e:
            print(f"TMDB discover tv fallback error: {e}")

    return filtered


@app.post("/interact")
def record_interaction(input_data: InteractionInput, db: Session = Depends(get_db)):
    """
    Records a user interaction (Like/Watch) for a guest user.
    Creates a shadow user account if one doesn't exist.
    """
    # 1. Find or Create User
    user = db.query(models.User).filter(models.User.username == input_data.guest_id).first()
    if not user:
        user = models.User(username=input_data.guest_id, email=f"{input_data.guest_id}@guest.nautilus.local")
        db.add(user)
        db.commit()
        db.refresh(user)
    
    # 2. Record Interaction

    # Ensure movie or TV show exists in DB, insert if missing, always use DB id for interaction
    if input_data.media_type == 'movie':
        # Try to find by tmdb_id first (since item_id may be tmdb_id from frontend)
        movie = db.query(models.Movie).filter(models.Movie.tmdb_id == input_data.item_id).first()
        if not movie:
            # Fetch from TMDB and insert
            movie_data = fetch_movie_details(input_data.item_id)
            if not movie_data:
                from fastapi import HTTPException
                raise HTTPException(status_code=400, detail="Movie not found in external source.")
            movie = models.Movie(
                title=movie_data['title'],
                tmdb_id=movie_data.get('tmdb_id'),
                overview=movie_data.get('overview'),
                release_date=movie_data.get('release_date'),
                genres=movie_data.get('genres'),
                poster_path=movie_data.get('poster_path'),
                popularity_score=movie_data.get('popularity_score'),
                stream_url=movie_data.get('stream_url'),
                is_downloaded=False,
                file_path=None
            )
            db.add(movie)
            db.commit()
            db.refresh(movie)
        # Always use the DB id for the interaction
        item_db_id = movie.id
    elif input_data.media_type == 'tv':
        tv_show = db.query(models.TVShow).filter(models.TVShow.tmdb_id == input_data.item_id).first()
        if not tv_show:
            tv_data = fetch_tv_details(input_data.item_id)
            if not tv_data:
                from fastapi import HTTPException
                raise HTTPException(status_code=400, detail="TV Show not found in external source.")
            tv_show = models.TVShow(
                title=tv_data['title'],
                tmdb_id=tv_data.get('tmdb_id'),
                overview=tv_data.get('overview'),
                genres=tv_data.get('genres'),
                poster_path=tv_data.get('poster_path'),
                popularity_score=tv_data.get('popularity_score')
            )
            db.add(tv_show)
            db.commit()
            db.refresh(tv_show)
        item_db_id = tv_show.id
    else:
        item_db_id = input_data.item_id

    # Handle 'dislike' (Un-Like) or 'remove_watchlist'
    if input_data.action in ('dislike', 'remove_watchlist'):
        target_type = 'like' if input_data.action == 'dislike' else 'watchlist'
        existing_int = db.query(models.Interaction).filter(
            models.Interaction.user_id == user.id,
            models.Interaction.movie_id == (item_db_id if input_data.media_type == 'movie' else None),
            models.Interaction.tv_show_id == (item_db_id if input_data.media_type == 'tv' else None),
            models.Interaction.interaction_type == target_type
        ).first()
        if existing_int:
            db.delete(existing_int)
            db.commit()
            return {"status": "removed", "user_id": user.id}
        return {"status": "nothing_to_remove", "user_id": user.id}

    # Check if already exists
    existing = db.query(models.Interaction).filter(
        models.Interaction.user_id == user.id,
        models.Interaction.movie_id == (item_db_id if input_data.media_type == 'movie' else None),
        models.Interaction.tv_show_id == (item_db_id if input_data.media_type == 'tv' else None),
        models.Interaction.interaction_type == input_data.action
    ).first()
    if not existing:
        interaction = models.Interaction(
            user_id=user.id,
            movie_id=item_db_id if input_data.media_type == 'movie' else None,
            tv_show_id=item_db_id if input_data.media_type == 'tv' else None,
            interaction_type=input_data.action,
            rating_value=1.0 # Implicit positive feedback
        )
        db.add(interaction)
        db.commit()
        return {"status": "recorded", "user_id": user.id}
    return {"status": "exists", "user_id": user.id}

def _serialize_rec(item, media_type):
    """Serialize a Movie or TVShow for the recommendation response."""
    d = {
        'id': item.id,
        'tmdb_id': item.tmdb_id,
        'poster_path': item.poster_path,
        'overview': item.overview,
        'genres': item.genres,
        'popularity_score': item.popularity_score,
        'media_type': media_type,
    }
    if media_type == 'tv':
        d['name'] = item.title          # Frontend expects 'name' for TV shows
    else:
        d['title'] = item.title
        d['release_date'] = getattr(item, 'release_date', None)
    return d


# --- TMDB-recommendation aggregation: the main "For You" signal ---
_REC_ITEM_CACHE: dict = {}   # (media_type, tmdb_id) -> (epoch, results)

def _fetch_tmdb_recs(media_type: str, tid: int):
    now = _t.time()
    hit = _REC_ITEM_CACHE.get((media_type, tid))
    if hit and (now - hit[0]) < 21600:   # 6h — a title's recs barely change
        return hit[1]
    res = []
    try:
        r = requests.get(
            f"{TMDB_BASE_URL}/{media_type}/{tid}/recommendations",
            params={"api_key": TMDB_API_KEY, "language": "en-US", "page": 1}, timeout=6)
        if r.status_code == 200:
            res = r.json().get("results", [])
    except Exception:
        res = []
    _REC_ITEM_CACHE[(media_type, tid)] = (now, res)
    return res

def _aggregate_tmdb_recs(movie_tmdb, tv_tmdb, seen, limit=18):
    """Pull TMDB recommendations for each liked/watched title and rank by how
    often a candidate is recommended (cross-title overlap = strong signal),
    decayed by rank and nudged by rating. Returns frontend-shaped dicts."""
    import concurrent.futures
    tasks = [("movie", t) for t in movie_tmdb[:10]] + [("tv", t) for t in tv_tmdb[:10]]
    if not tasks:
        return []
    tally = {}
    with concurrent.futures.ThreadPoolExecutor(max_workers=min(12, len(tasks))) as ex:
        futs = {ex.submit(_fetch_tmdb_recs, mt, t): mt for (mt, t) in tasks}
        for fut in concurrent.futures.as_completed(futs):
            mt = futs[fut]
            try:
                recs = fut.result()
            except Exception:
                recs = []
            for rank, it in enumerate(recs[:12]):
                tid = it.get("id")
                if not tid or not it.get("poster_path") or (mt, tid) in seen:
                    continue
                inc = (1.0 - rank * 0.04) + (it.get("vote_average") or 0) * 0.02
                e = tally.get((mt, tid))
                if e:
                    e["score"] += inc
                else:
                    tally[(mt, tid)] = {"score": inc, "data": it, "mt": mt}
    ranked = sorted(tally.values(), key=lambda x: x["score"], reverse=True)[:limit]
    out = []
    for e in ranked:
        it, mt = e["data"], e["mt"]
        rec = {"tmdb_id": it.get("id"), "id": it.get("id"), "media_type": mt,
               "poster_path": it.get("poster_path"), "overview": it.get("overview"),
               "popularity_score": it.get("popularity")}
        if mt == "tv":
            rec["name"] = it.get("name"); rec["first_air_date"] = it.get("first_air_date")
        else:
            rec["title"] = it.get("title"); rec["release_date"] = it.get("release_date")
        out.append(rec)
    return out


@app.get("/recommend/guest/{guest_id}")
def get_guest_recommendations(guest_id: str, request: Request, db: Session = Depends(get_db)):
    """
    Hybrid Recommender for Guest Users.
    1. Content-Based: Finds movies AND shows similar to what the user 'liked' OR 'watched'.
    2. Returns empty list when user has no interactions (hides row on frontend).
    """
    user = db.query(models.User).filter(models.User.username == guest_id).first()

    def _genre_keys(genres):
        """Normalize any genres shape (list of dicts / scalars, or a dict) to a
        set of hashable keys (genre names where available). Guards against the
        TMDB list-of-dicts format that otherwise crashes set.update()."""
        keys = set()
        if isinstance(genres, dict):
            for k, v in genres.items():
                keys.add(v if isinstance(v, str) else k)
        elif isinstance(genres, list):
            for g in genres:
                if isinstance(g, dict):
                    kk = g.get('name') or g.get('id')
                    if kk is not None:
                        keys.add(kk)
                elif isinstance(g, (str, int)):
                    keys.add(g)
        return keys

    target_genres = set()
    liked_movie_ids = []
    liked_tv_ids = []
    liked_movie_tmdb = []
    liked_tv_tmdb = []

    if user:
        # 1. Get Movie Interactions
        movie_interactions = db.query(models.Interaction).filter(
            models.Interaction.user_id == user.id,
            models.Interaction.interaction_type.in_(['like', 'watch']),
            models.Interaction.movie_id.isnot(None)
        ).all()
        liked_movie_ids = [i.movie_id for i in movie_interactions]
        if liked_movie_ids:
            movies = db.query(models.Movie).filter(models.Movie.id.in_(liked_movie_ids)).all()
            for m in movies:
                target_genres.update(_genre_keys(m.genres))
                if m.tmdb_id:
                    liked_movie_tmdb.append(m.tmdb_id)

        # 2. Get TV Show Interactions (for genre signals)
        tv_interactions = db.query(models.Interaction).filter(
            models.Interaction.user_id == user.id,
            models.Interaction.interaction_type.in_(['like', 'watch']),
            models.Interaction.tv_show_id.isnot(None)
        ).all()
        tv_ids = [i.tv_show_id for i in tv_interactions]
        liked_tv_ids = tv_ids
        if tv_ids:
            shows = db.query(models.TVShow).filter(models.TVShow.id.in_(tv_ids)).all()
            for s in shows:
                target_genres.update(_genre_keys(s.genres))
                if s.tmdb_id:
                    liked_tv_tmdb.append(s.tmdb_id)

    # Apply client-provided preferences (if any) via header X-User-Prefs: JSON string
    try:
        prefs_raw = request.headers.get('x-user-prefs')
        if prefs_raw:
            import json as _json
            prefs = _json.loads(prefs_raw)
            # Accept a simple structure: { "genres": ["Drama","Action"], "min_popularity": 5 }
            if isinstance(prefs, dict):
                genres_pref = prefs.get('genres') or prefs.get('preferred_genres')
                if genres_pref and isinstance(genres_pref, list):
                    for g in genres_pref:
                        try:
                            target_genres.add(g)
                        except Exception:
                            pass
                # Optional min_popularity can filter candidates later (handled below)
                min_pop_pref = prefs.get('min_popularity') if isinstance(prefs.get('min_popularity'), (int, float)) else None
            else:
                min_pop_pref = None
        else:
            min_pop_pref = None
    except Exception:
        min_pop_pref = None

    # Primary signal: aggregate TMDB's per-title recommendations across everything
    # the user liked/watched ("users who liked X also liked Y" — far better than
    # genre overlap). Falls through to the genre model below if it's thin.
    if TMDB_API_KEY and (liked_movie_tmdb or liked_tv_tmdb):
        seen = set([('movie', t) for t in liked_movie_tmdb] + [('tv', t) for t in liked_tv_tmdb])
        tmdb_recs = _aggregate_tmdb_recs(liked_movie_tmdb, liked_tv_tmdb, seen)
        if len(tmdb_recs) >= 6:
            return tmdb_recs

    if not target_genres:
        # No interactions at all — return empty so frontend hides the row
        return []

    # Find movie candidates that share at least one genre, excluding already liked
    candidates_q = db.query(models.Movie).filter(models.Movie.id.notin_(liked_movie_ids), models.Movie.popularity_score.isnot(None)).order_by(models.Movie.popularity_score.desc())
    if min_pop_pref is not None:
        try:
            candidates_q = candidates_q.filter(models.Movie.popularity_score >= float(min_pop_pref))
        except Exception:
            pass
    movie_candidates = candidates_q.limit(500).all()

    # Also pull TV show candidates
    show_candidates_q = db.query(models.TVShow).filter(models.TVShow.popularity_score.isnot(None)).order_by(models.TVShow.popularity_score.desc())
    if liked_tv_ids:
        show_candidates_q = show_candidates_q.filter(models.TVShow.id.notin_(liked_tv_ids))
    show_candidates = show_candidates_q.limit(300).all()

    # --- SCORING: Jaccard similarity + popularity boost ---
    max_movie_pop = db.query(func.max(models.Movie.popularity_score)).scalar() or 1
    max_show_pop = db.query(func.max(models.TVShow.popularity_score)).scalar() or 1

    def _score_candidate(cand, media_kind):
        cand_set = _genre_keys(cand.genres)
        inter = cand_set & target_genres
        union = cand_set | target_genres
        jaccard = (len(inter) / len(union)) if union else 0
        if jaccard == 0:
            return None  # No genre overlap at all
        max_pop = max_movie_pop if media_kind == 'movie' else max_show_pop
        pop_norm = min((cand.popularity_score or 0) / max_pop, 1.0)
        # 60% genre relevance + 40% popularity (quality signal)
        hybrid = 0.6 * jaccard + 0.4 * pop_norm
        return hybrid

    scored_movies = []
    for cand in movie_candidates:
        s = _score_candidate(cand, 'movie')
        if s is not None:
            scored_movies.append((cand, s, 'movie'))
    scored_movies.sort(key=lambda x: x[1], reverse=True)

    scored_shows = []
    for cand in show_candidates:
        s = _score_candidate(cand, 'tv')
        if s is not None:
            scored_shows.append((cand, s, 'tv'))
    scored_shows.sort(key=lambda x: x[1], reverse=True)

    # Interleave movies and shows for diversity (2 movies : 1 show ratio)
    final = []
    mi, si = 0, 0
    while len(final) < 18 and (mi < len(scored_movies) or si < len(scored_shows)):
        # Pick 2 movies then 1 show
        for _ in range(2):
            if mi < len(scored_movies):
                final.append(scored_movies[mi]); mi += 1
        if si < len(scored_shows):
            final.append(scored_shows[si]); si += 1
    
    # Return top 12 content-based candidates (mixed movies + shows, interleaved)
    return [_serialize_rec(x[0], x[2]) for x in final[:12]]

# --- USER INTERACTIONS (Guest/Watchlist) ---

@app.post("/interactions/reset/{guest_id}")
def reset_guest_interactions(guest_id: str, db: Session = Depends(get_db)):
    """Delete all interactions for a guest user (reset preferences)."""
    user = db.query(models.User).filter(models.User.username == guest_id).first()
    if not user:
        return {"status": "no_user"}
    db.query(models.Interaction).filter(models.Interaction.user_id == user.id).delete()
    db.commit()
    return {"status": "reset", "user_id": user.id}


@app.get("/interactions/status")
def get_interaction_status(guest_id: str, tmdb_id: int, media_type: str, action: str = 'watchlist', db: Session = Depends(get_db)):
    user = db.query(models.User).filter(models.User.username == guest_id).first()
    if not user:
        return {"active": False}
    
    if media_type == 'tv':
        item = db.query(models.TVShow).filter(models.TVShow.tmdb_id == tmdb_id).first()
        media_id = item.id if item else None
        col = models.Interaction.tv_show_id
    else:
        item = db.query(models.Movie).filter(models.Movie.tmdb_id == tmdb_id).first()
        media_id = item.id if item else None
        col = models.Interaction.movie_id
        
    if not media_id:
        return {"active": False}
        
    exists = db.query(models.Interaction).filter(
        models.Interaction.user_id == user.id,
        models.Interaction.interaction_type == action,
        col == media_id
    ).first()
    return {"active": bool(exists)}

@app.get("/collections/watchlist/{guest_id}")
def get_watchlist(guest_id: str, db: Session = Depends(get_db)):
    user = db.query(models.User).filter(models.User.username == guest_id).first()
    if not user:
        return []
        
    movies = db.query(models.Movie).join(models.Interaction).filter(
        models.Interaction.user_id == user.id,
        models.Interaction.interaction_type == 'watchlist',
        models.Interaction.movie_id.isnot(None)
    ).all()
    
    shows = db.query(models.TVShow).join(models.Interaction).filter(
        models.Interaction.user_id == user.id,
        models.Interaction.interaction_type == 'watchlist',
        models.Interaction.tv_show_id.isnot(None)
    ).all()
    
    results = []
    for m in movies:
        results.append(jsonable_encoder(m) | {"media_type": "movie"})
    for s in shows:
        results.append(jsonable_encoder(s) | {"media_type": "tv"})
        
    return results