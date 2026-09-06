"""The error envelope, CORS and URL normalisation — Contract 8.

Instance 2 renders `body.error` directly to the user, so the shape matters as
much as the status code: every non-2xx response, from every endpoint, carries
exactly one key, and there is no `detail` anywhere.
"""

import pytest

from app.database import normalise_database_url
from app.realtime import origin_is_allowed
from tests.conftest import TEST_ORIGIN


async def test_422_404_and_401_all_use_the_envelope(client, alice, board):
    responses = [
        await client.post("/api/boards", json={"title": ""}, headers=alice.headers()),  # 422
        await client.get("/api/boards/999999", headers=alice.headers()),  # 404
        await client.get("/api/boards"),  # 401
    ]
    assert [r.status_code for r in responses] == [422, 404, 401]
    for response in responses:
        body = response.json()
        assert set(body) == {"error"}, body
        assert "detail" not in body
        assert isinstance(body["error"], str) and body["error"].endswith(".")


async def test_409_uses_the_envelope(alice, bob, shared_board):
    response = await alice.post(
        "/api/boards/{}/members".format(shared_board["id"]), {"email": bob.email}
    )
    assert response.status_code == 409
    assert set(response.json()) == {"error"}


async def test_fastapi_validation_errors_are_rewritten(client, alice, board):
    """FastAPI's own 422 envelope is overridden, including for query params."""
    response = await client.get(
        "/api/boards/{}/activity?limit=notanumber".format(board["id"]),
        headers=alice.headers(),
    )
    assert response.status_code == 422
    body = response.json()
    assert set(body) == {"error"}
    assert "detail" not in body


async def test_malformed_json_body_is_rewritten(client, alice):
    response = await client.post(
        "/api/boards",
        content=b"{not json",
        headers={**alice.headers(), "Content-Type": "application/json"},
    )
    assert response.status_code == 422
    assert set(response.json()) == {"error"}


async def test_unknown_route_uses_the_envelope(client):
    response = await client.get("/api/does-not-exist")
    assert response.status_code == 404
    assert set(response.json()) == {"error"}


async def test_method_not_allowed_uses_the_envelope(client, alice, board):
    response = await client.put("/api/boards/{}".format(board["id"]), headers=alice.headers())
    assert response.status_code == 405
    assert set(response.json()) == {"error"}


async def test_unhandled_errors_become_a_generic_500(alice, board, monkeypatch, app):
    """A 500 never leaks internals (Contract 8)."""
    from httpx import ASGITransport, AsyncClient

    from app.routers import boards as boards_router

    async def explode(*args, **kwargs):
        raise RuntimeError("secret internal detail: connection string leaked")

    # Patch the name the router actually resolves, not the definition site.
    monkeypatch.setattr(boards_router, "board_snapshot", explode)

    transport = ASGITransport(app=app, raise_app_exceptions=False)
    async with AsyncClient(transport=transport, base_url="http://testserver") as quiet:
        response = await quiet.get(
            "/api/boards/{}".format(board["id"]), headers=alice.headers()
        )

    assert response.status_code == 500
    assert response.json() == {"error": "Something went wrong on our end."}
    assert "secret internal detail" not in response.text


async def test_cors_headers_on_a_credentialed_request(client, alice):
    """allow_origins is an explicit list — a wildcard is illegal with credentials."""
    response = await client.get(
        "/api/auth/me", headers={**alice.headers(), "Origin": TEST_ORIGIN}
    )
    assert response.headers["access-control-allow-origin"] == TEST_ORIGIN
    assert response.headers["access-control-allow-credentials"] == "true"


async def test_cors_preflight_allows_the_client_op_id_header(client):
    response = await client.options(
        "/api/boards",
        headers={
            "Origin": TEST_ORIGIN,
            "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "authorization,content-type,x-client-op-id",
        },
    )
    assert response.status_code == 200
    allowed = response.headers["access-control-allow-headers"].lower()
    for header in ("authorization", "content-type", "x-client-op-id"):
        assert header in allowed


async def test_cors_rejects_an_unknown_origin(client, alice):
    response = await client.get(
        "/api/auth/me", headers={**alice.headers(), "Origin": "https://evil.example"}
    )
    # The request still executes, but the browser is not given permission.
    assert "access-control-allow-origin" not in response.headers


# ---------------------------------------------------------------------------
# WebSocket origin checking (separate from CORS)
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "origin,expected",
    [
        ("https://app.example", True),
        ("https://app.example/", True),
        ("https://evil.example", False),
        ("", True),
        (None, True),
    ],
)
def test_origin_allow_list(origin, expected):
    assert origin_is_allowed(origin, ["https://app.example"], allow_missing=True) is expected


def test_missing_origin_can_be_refused():
    assert origin_is_allowed(None, ["https://app.example"], allow_missing=False) is False


# ---------------------------------------------------------------------------
# Hosted database URL normalisation (a redeploy each, on previous projects)
# ---------------------------------------------------------------------------


def test_sqlite_urls_pass_through():
    url, connect_args = normalise_database_url("sqlite+aiosqlite:///./taskflow.db")
    assert url == "sqlite+aiosqlite:///./taskflow.db"
    assert connect_args == {}


def test_bare_sqlite_url_gets_the_async_driver():
    url, _ = normalise_database_url("sqlite:///./taskflow.db")
    assert url.startswith("sqlite+aiosqlite://")


def test_legacy_postgres_scheme_is_forced_to_asyncpg():
    url, connect_args = normalise_database_url("postgres://u:p@db.neon.tech/taskflow")
    assert url.startswith("postgresql+asyncpg://")
    assert connect_args == {"ssl": True}


def test_libpq_only_query_args_are_stripped():
    """asyncpg rejects sslmode and channel_binding outright."""
    url, connect_args = normalise_database_url(
        "postgresql://u:p@ep-x.neon.tech/db?sslmode=require&channel_binding=require"
    )
    assert "sslmode" not in url
    assert "channel_binding" not in url
    assert url.startswith("postgresql+asyncpg://")
    assert connect_args == {"ssl": True}


def test_local_postgres_does_not_force_ssl():
    url, connect_args = normalise_database_url("postgresql://u:p@localhost:5432/taskflow")
    assert url.startswith("postgresql+asyncpg://")
    assert connect_args == {}


def test_compose_service_host_does_not_force_ssl():
    _url, connect_args = normalise_database_url("postgresql://u:p@db:5432/taskflow")
    assert connect_args == {}


def test_unrelated_query_args_survive():
    url, _ = normalise_database_url(
        "postgresql://u:p@localhost/db?application_name=taskflow"
    )
    assert "application_name=taskflow" in url
