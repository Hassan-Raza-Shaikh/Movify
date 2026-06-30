import os
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from dotenv import load_dotenv

load_dotenv()
DATABASE_URL = os.getenv("DATABASE_URL")
# pool_pre_ping validates a pooled connection before use — Neon/serverless
# Postgres silently drops idle connections ("SSL connection has been closed
# unexpectedly"), and without this the next query 500s. pool_recycle proactively
# retires connections older than 5 min so we never hand out a dead one.
engine = create_engine(DATABASE_URL, pool_pre_ping=True, pool_recycle=300)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)

def get_db():
    db = SessionLocal()
    try: 
        yield db
    finally: 
        db.close()