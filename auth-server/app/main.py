from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.db import close_pool, init_schema, open_pool
from app.routes import auth


@asynccontextmanager
async def lifespan(_: FastAPI):
    await open_pool()
    await init_schema()
    yield
    await close_pool()


app = FastAPI(title="ShortenURL Auth Service", version="1.0.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(auth.router)


@app.get("/health", tags=["health"])
async def health():
    return {"status": "ok", "service": "auth-server"}
