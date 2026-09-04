import os

from dotenv import load_dotenv

load_dotenv()


class Settings:
    database_url: str = os.getenv(
        "DATABASE_URL", "postgresql://postgres:postgres@localhost:5432/postgres"
    )
    jwt_secret: str = os.getenv("JWT_SECRET", "super-secret-change-me")
    jwt_algorithm: str = "HS256"
    jwt_expires_minutes: int = int(os.getenv("JWT_EXPIRES_MINUTES", "1440"))


settings = Settings()
