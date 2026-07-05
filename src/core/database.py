import os
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from dotenv import load_dotenv

load_dotenv()
DATABASE_URL = os.getenv("DATABASE_URL", "sqlite:///./nautilus.db")

# Setup engine args based on DB type
engine_args = {}
if DATABASE_URL.startswith("sqlite"):
    engine_args["connect_args"] = {"check_same_thread": False}
else:
    # pool_pre_ping validates a pooled connection before use — Neon/serverless
    # Postgres silently drops idle connections unexpectedly
    engine_args["pool_pre_ping"] = True
    engine_args["pool_recycle"] = 300

engine = create_engine(DATABASE_URL, **engine_args)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)

def get_db():
    db = SessionLocal()
    try: 
        yield db
    finally: 
        db.close()