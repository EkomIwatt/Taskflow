"""Async engine, session factory and hosted-URL normalisation.

The normalisation below is a carry-over from LedgerLite and Snipp, where each of
these rules cost a redeploy to discover. Hosted Postgres providers (Neon, Render)
hand out libpq-style URLs; asyncpg rejects several of their query arguments
outright and does not understand the bare ``postgres://`` scheme.
"""

from typing import AsyncGenerator, Dict, Tuple
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.orm import DeclarativeBase

from app.config import get_settings

#: Query arguments libpq accepts but asyncpg does not. `sslmode` and
#: `channel_binding` in particular are what Neon puts in its copy-paste URL.
_LIBPQ_ONLY_ARGS = {"sslmode", "channel_binding", "target_session_attrs", "options", "gssencmode"}


class Base(DeclarativeBase):
    pass


def normalise_database_url(url: str) -> Tuple[str, Dict[str, object]]:
    """Return an asyncpg-safe URL plus any connect args it implies.

    SQLite and already-async URLs pass through untouched apart from the driver
    prefix. For Postgres the scheme is forced to ``postgresql+asyncpg``, the
    libpq-only query arguments are stripped, and ``sslmode=require`` (or any
    other non-disabled mode) is translated into asyncpg's ``ssl`` connect arg.
    """
    connect_args: Dict[str, object] = {}

    if url.startswith("sqlite"):
        if url.startswith("sqlite://") and "+aiosqlite" not in url:
            url = url.replace("sqlite://", "sqlite+aiosqlite://", 1)
        return url, connect_args

    split = urlsplit(url)
    scheme = split.scheme

    # `postgres://` is the legacy alias many providers still emit.
    if scheme in ("postgres", "postgresql") or scheme.startswith("postgresql+"):
        scheme = "postgresql+asyncpg"
    elif scheme.startswith("postgres+"):
        scheme = "postgresql+asyncpg"

    query_pairs = parse_qsl(split.query, keep_blank_values=True)
    kept = []
    ssl_required = False
    for key, value in query_pairs:
        if key.lower() in _LIBPQ_ONLY_ARGS:
            if key.lower() == "sslmode" and value.lower() not in ("disable", "allow"):
                ssl_required = True
            continue
        kept.append((key, value))

    # Hosted Postgres is TLS-only. Local and container Postgres is not, and
    # forcing SSL there fails the connection outright.
    host = (split.hostname or "").lower()
    if host not in ("", "localhost", "127.0.0.1", "::1", "db", "postgres"):
        ssl_required = True
    if ssl_required:
        connect_args["ssl"] = True

    normalised = urlunsplit((scheme, split.netloc, split.path, urlencode(kept), split.fragment))
    return normalised, connect_args


def _build_engine():
    settings = get_settings()
    url, connect_args = normalise_database_url(settings.database_url)
    kwargs = {"echo": settings.sql_echo, "future": True, "connect_args": connect_args}
    if not url.startswith("sqlite"):
        # Render's free tier and Neon both cap connections tightly, and the hub
        # keeps the process alive for a long time, so recycle before the
        # provider silently drops an idle connection under us.
        kwargs.update(pool_size=5, max_overflow=5, pool_pre_ping=True, pool_recycle=280)
    return create_async_engine(url, **kwargs)


engine = _build_engine()

SessionLocal = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)


def get_session_factory() -> async_sessionmaker:
    """The current session factory, read at call time.

    Code that needs a session *outside* a request — the WebSocket endpoint, which
    has no `Depends` to hang off — goes through here rather than importing
    SessionLocal directly, so the test suite can point the whole application at
    one in-memory database by rebinding a single name.
    """
    return SessionLocal


async def get_db() -> AsyncGenerator[AsyncSession, None]:
    """FastAPI dependency yielding a session, rolled back on any exception."""
    async with SessionLocal() as session:
        try:
            yield session
        except Exception:
            await session.rollback()
            raise
