import logging
from pathlib import Path
from typing import Any, Optional, Sequence
from urllib.parse import urlparse

from psycopg.rows import dict_row
from psycopg_pool import AsyncConnectionPool

from app.config import settings

SCHEMA_FILE = Path(__file__).with_name("schema.sql")

# Logs through uvicorn so these lines sit alongside its own INFO output.
logger = logging.getLogger("uvicorn.error")

# open=False so the pool is only started inside the app lifespan.
pool = AsyncConnectionPool(conninfo=settings.database_url, open=False, min_size=1)


def _target() -> str:
    """host:port/dbname of the configured URL, without the credentials."""
    url = urlparse(settings.database_url)
    return f"{url.hostname}:{url.port or 5432}{url.path}"


async def open_pool() -> None:
    await pool.open()
    await pool.wait()
    logger.info("Database connected successfully: %s", _target())


async def close_pool() -> None:
    await pool.close()
    logger.info("Database connection closed")


async def init_schema() -> None:
    """Create this service's tables if they are not there yet."""
    async with pool.connection() as conn:
        await conn.execute(SCHEMA_FILE.read_text())
    logger.info("Database schema ready (table: users)")


async def fetch_one(sql: str, params: Sequence[Any] = ()) -> Optional[dict]:
    async with pool.connection() as conn:
        async with conn.cursor(row_factory=dict_row) as cur:
            await cur.execute(sql, params)
            return await cur.fetchone()
