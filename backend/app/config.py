"""Application settings, read from the environment.

Everything that differs between local development, the docker-compose stack and
Render lives here. Contract 8's CORS rules and Contract 6's heartbeat timings are
configuration, not constants scattered through the code.
"""

import os
from functools import lru_cache
from typing import List

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    # --- Database -----------------------------------------------------------
    # Normalised in database.py: the driver is forced to +asyncpg and libpq-only
    # query arguments are stripped, because hosted providers hand out libpq URLs.
    database_url: str = "sqlite+aiosqlite:///./taskflow.db"
    sql_echo: bool = False

    # --- Auth (Contract 1) --------------------------------------------------
    jwt_secret: str = "dev-secret-change-me"
    jwt_algorithm: str = "HS256"
    #: Contract 1 pins the advertised `expires_in` to 900 seconds.
    access_token_expire_seconds: int = 900
    #: Contract 1 pins the refresh cookie's Max-Age to 2592000 seconds (30 days).
    refresh_token_expire_seconds: int = 2592000
    cookie_secure: bool = False
    cookie_samesite: str = "lax"
    #: Contract 1 scopes the refresh cookie to the auth routes only.
    cookie_path: str = "/api/auth"
    cookie_domain: str = ""

    # --- CORS and WebSocket origin checking (Contract 8) --------------------
    #: Comma-separated. "*" is illegal with credentialed CORS and is rejected.
    allowed_origins: str = "http://localhost:5173,http://127.0.0.1:5173"
    #: Browsers always send Origin. Non-browser clients (websocat, the test
    #: suite, server-to-server probes) send none, and cannot be CSRF'd, so an
    #: absent Origin is allowed by default. Set false to require one.
    ws_allow_missing_origin: bool = True

    # --- Realtime (Contract 6) ----------------------------------------------
    #: Contract 6 §1: a ticket is single-use and expires in 30 seconds.
    ws_ticket_ttl_seconds: int = 30
    #: Contract 6 §6.1: the server sends `ping` every 25 seconds.
    ws_ping_interval_seconds: float = 25.0
    #: A slow or dead client must never block a broadcast to everyone else.
    ws_send_timeout_seconds: float = 5.0

    @property
    def origin_allow_list(self) -> List[str]:
        origins = [o.strip().rstrip("/") for o in self.allowed_origins.split(",")]
        return [o for o in origins if o and o != "*"]


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()


def reset_settings_cache() -> None:
    """Drop the cached settings — used by the test suite after patching env."""
    get_settings.cache_clear()


def is_testing() -> bool:
    return os.getenv("TASKFLOW_TESTING") == "1"
