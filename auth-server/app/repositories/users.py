from typing import Optional

from app.db import fetch_one


async def find_by_email(email: str) -> Optional[dict]:
    return await fetch_one(
        "SELECT id, email, password FROM users WHERE email = %s", (email,)
    )


async def create(email: str, password_hash: str) -> dict:
    row = await fetch_one(
        """
        INSERT INTO users (email, password)
        VALUES (%s, %s)
        RETURNING id, email
        """,
        (email, password_hash),
    )
    assert row is not None  # RETURNING always yields a row on success
    return row
