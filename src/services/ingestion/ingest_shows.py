import os
import time
import requests
import argparse
from tqdm import tqdm
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry
from dotenv import load_dotenv
from src.core.models import TVShow, Season, Episode
from typing import Dict, List

load_dotenv()
API_KEY = os.getenv("TMDB_API_KEY")
DATABASE_URL = os.getenv("DATABASE_URL")

engine = create_engine(DATABASE_URL)
Session = sessionmaker(bind=engine)
session = Session()

BASE_URL = "https://api.themoviedb.org/3"

# --- GENRE HELPERS ---
_TV_GENRE_MAP: Dict[int, str] | None = None

def load_tv_genre_map() -> Dict[int, str]:
    """Fetch TMDB TV genre map once and cache."""
    global _TV_GENRE_MAP
    if _TV_GENRE_MAP is not None:
        return _TV_GENRE_MAP
    try:
        url = f"{BASE_URL}/genre/tv/list?api_key={API_KEY}&language=en-US"
        resp = requests.get(url, timeout=10)
        resp.raise_for_status()
        data = resp.json()
        _TV_GENRE_MAP = {g["id"]: g["name"] for g in data.get("genres", [])}
    except Exception:
        _TV_GENRE_MAP = {}
    return _TV_GENRE_MAP

def format_genres(genre_ids: List[int]) -> List[dict]:
    genre_map = load_tv_genre_map()
    out = []
    for gid in genre_ids or []:
        name = genre_map.get(gid)
        if name:
            out.append({"id": gid, "name": name})
    return out

# --- NETWORK CONFIG ---
# Setup robust session with retries
def get_session():
    session = requests.Session()
    retries = Retry(total=5, backoff_factor=1, status_forcelist=[500, 502, 503, 504])
    adapter = HTTPAdapter(max_retries=retries)
    session.mount('https://', adapter)
    session.mount('http://', adapter)
    return session

http = get_session()

def safe_request(url, params=None):
    """Robust request wrapper with error handling"""
    try:
        response = http.get(url, params=params, timeout=30)
        response.raise_for_status()
        return response.json()
    except requests.exceptions.RequestException as e:
        # print(f"Request failed: {url} | Error: {e}") # Reduce noise
        raise e

def fetch_shows(pages=None, fetch_all=False, start_page=1, deep=True):
    try:
        init_url = f"{BASE_URL}/tv/popular?api_key={API_KEY}&language=en-US&page=1"
        init_data = safe_request(init_url)
        total_available = init_data['total_pages']
    except Exception as e:
        print(f"Connection failed init: {e}")
        return
    
    # Cap at 500 pages (TMDB limit)
    limit = min(total_available, 500)
    if not fetch_all and pages:
        limit = min(pages, limit)

    print(f"Starting TV Show Ingestion: Page {start_page} to {limit}...")
    
    for page in tqdm(range(start_page, limit + 1), desc="Fetching Pages", initial=start_page, total=limit):
        url = f"{BASE_URL}/tv/popular?api_key={API_KEY}&language=en-US&page={page}"
        
        try:
            data = safe_request(url)
            
            for item in data.get('results', []):
                try:
                    # 1. Check/Create Show
                    show = session.query(TVShow).filter_by(tmdb_id=item['id']).first()
                    if not show:
                        genres = format_genres(item.get('genre_ids', []))
                        show = TVShow(
                            title=item['name'],
                            tmdb_id=item['id'],
                            overview=item['overview'],
                            genres=genres,
                            poster_path=item['poster_path'],
                            popularity_score=item['popularity']
                        )
                        session.add(show)
                        session.commit()

                        # 2. Deep Fetch Seasons — skip when deep=False (episodes load
                        #    on-demand via /shows/{id}/seasons, so the catalog fills ~100x faster).
                        if deep:
                            try:
                                _fetch_details(show)
                            except Exception as deep_err:
                                print(f"Partial failure for {show.title}: {deep_err}")
                except Exception as e:
                    print(f"Skipping show {item.get('name')}: {e}")
                    session.rollback()
            
            time.sleep(0.1)
            
        except Exception as e:
            print(f"Critical Error on page {page}: {e}")
            time.sleep(2)

def _fetch_details(show):
    # Fetch Show Details
    url = f"{BASE_URL}/tv/{show.tmdb_id}?api_key={API_KEY}&language=en-US"
    details = safe_request(url)
    
    if not details:
        return

    # Update genres if missing
    try:
        if not show.genres:
            g_ids = [g.get('id') for g in details.get('genres', []) if g.get('id') is not None]
            formatted = format_genres(g_ids)
            if formatted:
                show.genres = formatted
                session.add(show)
                session.commit()
    except Exception:
        session.rollback()

    for s_meta in details.get('seasons', []):
        s_num = s_meta['season_number']
        
        # Check if season exists
        existing_season = session.query(Season).filter_by(show_id=show.id, season_number=s_num).first()
        if existing_season:
            continue

        # Create Season
        season = Season(
            show_id=show.id,
            season_number=s_num,
            name=s_meta['name'],
            air_date=s_meta['air_date']
        )
        session.add(season)
        session.flush()
        
        # Fetch Episodes
        ep_url = f"{BASE_URL}/tv/{show.tmdb_id}/season/{s_num}?api_key={API_KEY}&language=en-US"
        try:
            ep_data = safe_request(ep_url)
            
            episode_objects = []
            for ep in ep_data.get('episodes', []):
                episode = Episode(
                    season_id=season.id,
                    episode_number=ep['episode_number'],
                    title=ep['name'],
                    overview=ep['overview'],
                    air_date=ep.get('air_date'),
                    still_path=ep.get('still_path')
                )
                episode_objects.append(episode)
            
            session.add_all(episode_objects)
            session.commit()
            
        except Exception as e:
            print(f"Failed to fetch season {s_num} for {show.title}: {e}")
            session.rollback()

    def backfill_missing_genres(batch_size: int = 200):
        """Fetch genres for shows missing them."""
        qs = session.query(TVShow).filter((TVShow.genres.is_(None)) | (TVShow.genres == [])).limit(batch_size).all()
        if not qs:
            print("No shows missing genres.")
            return
        updated = 0
        for show in qs:
            try:
                url = f"{BASE_URL}/tv/{show.tmdb_id}?api_key={API_KEY}&language=en-US"
                resp = requests.get(url, timeout=10)
                if resp.status_code != 200:
                    continue
                data = resp.json()
                g_ids = [g.get('id') for g in data.get('genres', []) if g.get('id') is not None]
                formatted = format_genres(g_ids)
                if formatted:
                    show.genres = formatted
                    session.add(show)
                    updated += 1
                    if updated % 50 == 0:
                        session.commit()
            except Exception:
                session.rollback()
                continue
        session.commit()
        print(f"Backfilled genres for {updated} shows.")

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Ingest TV Shows")
    parser.add_argument("--pages", type=int, default=2, help="Number of pages")
    parser.add_argument("--all", action="store_true", help="Fetch MAX pages")
    parser.add_argument("--start", type=int, default=1, help="Start Page")
    parser.add_argument("--backfill-genres", action="store_true", help="Backfill genres for existing shows")
    parser.add_argument("--no-deep", action="store_true", help="Catalog only — skip per-show season/episode fetch")

    args = parser.parse_args()
    try:
        if args.backfill_genres:
            backfill_missing_genres()
        else:
            fetch_shows(pages=args.pages, fetch_all=args.all, start_page=args.start, deep=not args.no_deep)
            print("TV Ingestion Complete.")
    except KeyboardInterrupt:
        print("\nStopped.")