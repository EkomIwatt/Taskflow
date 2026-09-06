"""FastAPI application factory.

CORS here is credentialed, because the refresh token lives in an httpOnly
cookie. That makes ``allow_origins=["*"]`` illegal — browsers reject a wildcard
origin on a credentialed request — so the allow-list is always explicit, read
from the environment. WebSocket origin checking is a *separate* mechanism in
``routers/realtime.py``: this middleware never sees the /ws endpoint.
"""

import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.config import get_settings
from app.database import Base, engine
from app.errors import install_error_handlers
from app.routers import auth, boards, cards, comments, lists, realtime

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("taskflow")


@asynccontextmanager
async def lifespan(app: FastAPI):
    settings = get_settings()
    if settings.database_url.startswith("sqlite"):
        # Postgres schema is owned by db/init.sql; SQLite is for local runs and
        # the test suite, where creating the schema on boot is the whole setup.
        async with engine.begin() as connection:
            await connection.run_sync(Base.metadata.create_all)
    logger.info("TaskFlow API ready. WS origins allowed: %s", settings.origin_allow_list)
    yield
    await engine.dispose()


def create_app() -> FastAPI:
    settings = get_settings()

    app = FastAPI(
        title="TaskFlow API",
        version="1.0.0",
        description="Real-time collaborative kanban board.",
        lifespan=lifespan,
    )

    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.origin_allow_list,
        allow_credentials=True,
        allow_methods=["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
        allow_headers=["Authorization", "Content-Type", "X-Client-Op-Id"],
    )

    install_error_handlers(app)

    app.include_router(auth.router)
    app.include_router(boards.router)
    app.include_router(lists.router)
    app.include_router(cards.router)
    app.include_router(comments.router)
    app.include_router(realtime.router)

    @app.get("/api/health", tags=["health"])
    async def health() -> dict:
        return {"status": "ok"}

    return app


app = create_app()
