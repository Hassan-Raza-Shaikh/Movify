import os
from sqlalchemy import create_engine, Column, Integer, String, Float, ForeignKey, Text, JSON, DateTime, Boolean, UniqueConstraint
from sqlalchemy.orm import declarative_base, relationship
from sqlalchemy.sql import func
from src.core.database import DATABASE_URL

# DATABASE CONNECTION
# DATABASE_URL imported from src.core.database to ensure consistency

Base = declarative_base()

# --- CONTENT TABLES ---
class Movie(Base):
    __tablename__ = 'movies'
    
    id = Column(Integer, primary_key=True)
    title = Column(String, nullable=False)
    tmdb_id = Column(Integer, unique=True, index=True)
    overview = Column(Text)
    release_date = Column(String)
    genres = Column(JSON)           # Feature: Classification
    poster_path = Column(String)
    popularity_score = Column(Float) # Feature: Regression
    embedding = Column(JSON)        # Feature: Clustering/Dim Reduction
    
    # File Management
    stream_url = Column(String)
    is_downloaded = Column(Boolean, default=False)
    file_path = Column(String)      # MinIO path

    ratings = relationship("Interaction", back_populates="movie")

class TVShow(Base):
    __tablename__ = 'tv_shows'
    
    id = Column(Integer, primary_key=True)
    title = Column(String, nullable=False)
    tmdb_id = Column(Integer, unique=True, index=True)
    overview = Column(Text)
    genres = Column(JSON)
    poster_path = Column(String)
    popularity_score = Column(Float)
    
    seasons = relationship("Season", back_populates="show", cascade="all, delete-orphan")
    ratings = relationship("Interaction", back_populates="tv_show")

class Season(Base):
    __tablename__ = 'seasons'
    __table_args__ = (
        UniqueConstraint('show_id', 'season_number', name='uix_show_season'),
    )
    id = Column(Integer, primary_key=True)
    show_id = Column(Integer, ForeignKey('tv_shows.id'))
    season_number = Column(Integer)
    name = Column(String)
    air_date = Column(String)

    show = relationship("TVShow", back_populates="seasons")
    episodes = relationship(
        "Episode",
        back_populates="season",
        cascade="all, delete-orphan",
        order_by="Episode.episode_number"
    )

class Episode(Base):
    __tablename__ = 'episodes'
    __table_args__ = (
        UniqueConstraint('season_id', 'episode_number', name='uix_season_episode'),
    )
    id = Column(Integer, primary_key=True)
    season_id = Column(Integer, ForeignKey('seasons.id'))
    episode_number = Column(Integer)
    title = Column(String)
    overview = Column(Text)
    runtime_minutes = Column(Integer)
    air_date = Column(String)
    still_path = Column(String)
    
    stream_url = Column(String)
    is_downloaded = Column(Boolean, default=False)
    file_path = Column(String)
    
    season = relationship("Season", back_populates="episodes")

# --- USER & ANALYTICS ---
class User(Base):
    __tablename__ = 'users'
    
    id = Column(Integer, primary_key=True)
    username = Column(String, unique=True, nullable=False)
    email = Column(String, unique=True)
    password_hash = Column(String)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    
    interactions = relationship("Interaction", back_populates="user")

class Interaction(Base):
    __tablename__ = 'interactions'
    id = Column(Integer, primary_key=True)
    user_id = Column(Integer, ForeignKey('users.id'), nullable=True) # Allow null for guest users
    
    # LINKS TO CONTENT
    movie_id = Column(Integer, ForeignKey('movies.id'), nullable=True)
    tv_show_id = Column(Integer, ForeignKey('tv_shows.id'), nullable=True)
    
    interaction_type = Column(String) 
    rating_value = Column(Float)
    timestamp = Column(DateTime(timezone=True), server_default=func.now())
    
    user = relationship("User", back_populates="interactions")
    movie = relationship("Movie", back_populates="ratings")
    tv_show = relationship("TVShow", back_populates="ratings")

# --- MLOPS & LOGGING ---
class SystemLog(Base):
    __tablename__ = 'system_logs'
    id = Column(Integer, primary_key=True)
    timestamp = Column(DateTime(timezone=True), server_default=func.now())
    metric_name = Column(String) 
    metric_value = Column(Float)

class MLModel(Base):
    __tablename__ = 'ml_models'
    id = Column(Integer, primary_key=True)
    name = Column(String)
    version = Column(String)
    model_type = Column(String)
    file_path = Column(String)
    metrics = Column(JSON)
    is_active = Column(Boolean, default=False)
    created_at = Column(DateTime(timezone=True), server_default=func.now())

class WatchProgress(Base):
    __tablename__ = 'watch_progress'
    __table_args__ = (
        UniqueConstraint('guest_id', 'media_type', 'tmdb_id', 'season', 'episode', name='uix_watch_progress'),
    )
    id = Column(Integer, primary_key=True)
    guest_id = Column(String, index=True)
    media_type = Column(String)            # 'movie' | 'tv'
    tmdb_id = Column(Integer, index=True)
    season = Column(Integer, default=0)    # 0 for movies
    episode = Column(Integer, default=0)
    position_seconds = Column(Float, default=0)
    duration_seconds = Column(Float, default=0)
    percentage = Column(Float, default=0)
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())


def init_db():
    engine = create_engine(DATABASE_URL)
    Base.metadata.create_all(engine)
    print("DB Schema Synchronized.")

if __name__ == "__main__":
    init_db()