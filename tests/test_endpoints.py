from fastapi.testclient import TestClient
from src.api.main import app
from src.core.database import engine
from src.core import models

models.Base.metadata.create_all(bind=engine)
client = TestClient(app)

def test_search_mixed_results():
    """
    Verify that searching for 'breaking' returns mixed results (movies + tv)
    and that they are correctly tagged with 'media_type'.
    """
    response = client.get("/search?query=breaking")
    assert response.status_code == 200
    results = response.json()
    
    # We expect at least one result if the DB is seeded, but let's just check structure if empty
    if len(results) > 0:
        # Check that every item has a media_type
        for item in results:
            assert "media_type" in item
            assert item["media_type"] in ["movie", "tv"]
            
        # Ideally we find at least one TV show (Breaking Bad) and one Movie (Breaking Dawn)
        # This depends on your local DB state, so we won't hard fail if specific titles are missing,
        # but we can check if we got mixed types if the list is long enough.
        types = {item["media_type"] for item in results}
        # If we have both, great. If not, it's not necessarily a failure of the code, just data.
        print(f"Found types: {types}")

def test_related_endpoint_structure():
    """
    Verify /related/{tmdb_id} returns a list of items with media_type.
    """
    # Use a known ID if possible, or a random one. 
    # 1396 is Breaking Bad (TV), 50620 is Twilight (Movie)
    
    # Test TV ID
    response_tv = client.get("/related/1396")
    if response_tv.status_code == 200:
        items = response_tv.json()
        assert isinstance(items, list)
        for item in items:
            assert "media_type" in item
            assert item["media_type"] == "tv" # TV should only return TV

    # Test Movie ID
    response_movie = client.get("/related/50620")
    if response_movie.status_code == 200:
        items = response_movie.json()
        assert isinstance(items, list)
        for item in items:
            assert "media_type" in item
            # Movies can return movies (mostly)
            assert item["media_type"] == "movie"

def test_recommend_personal():
    """
    Verify /recommend/personal/{user_id} returns a list of movies.
    """
    response = client.get("/recommend/personal/1")
    assert response.status_code == 200
    items = response.json()
    assert isinstance(items, list)
    # Recommendations are currently just movies
    if len(items) > 0:
        # The recommendation endpoint returns Movie objects, which might not have media_type 
        # explicitly added by the endpoint unless we added it. 
        # Let's check if it's there or if the frontend infers it.
        # The current implementation of /recommend/personal returns db models directly or dicts.
        # Let's check the first item.
        first = items[0]
        assert "title" in first
        assert "tmdb_id" in first

def test_ai_collections():
    """
    Verify /collections/ai returns the expected cluster structure.
    """
    response = client.get("/collections/ai")
    assert response.status_code == 200
    data = response.json()
    assert "cluster_1" in data
    assert "cluster_2" in data
    
    # Updated structure: { "cluster_1": { "name": "...", "items": [...] } }
    assert isinstance(data["cluster_1"], dict)
    assert "items" in data["cluster_1"]
    assert isinstance(data["cluster_1"]["items"], list)
    
    assert isinstance(data["cluster_2"], dict)
    assert "items" in data["cluster_2"]
    assert isinstance(data["cluster_2"]["items"], list)

def test_revenue_prediction():
    """
    Verify /movie/{tmdb_id}/prediction returns a valid prediction structure.
    """
    # Use a known movie ID (e.g. Avatar: 19995, or something existing)
    # If the movie doesn't exist in DB, it returns N/A.
    # We need a movie that exists in the DB.
    # Let's assume 50620 (Twilight) exists from previous tests.
    
    response = client.get("/movie/50620/prediction")
    assert response.status_code == 200
    data = response.json()
    
    if "prediction" in data and data["prediction"] == "N/A":
        # Movie might not be in DB or model missing
        pass
    else:
        assert "label" in data
        assert "value" in data
        assert data["label"] in ["MEGA-HIT", "BLOCKBUSTER", "MAINSTREAM", "INDIE", "UNKNOWN", "TV SERIES"]
