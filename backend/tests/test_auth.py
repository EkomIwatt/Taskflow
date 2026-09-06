"""Authentication — Contract 1."""

import jwt
import pytest

from app.config import get_settings
from app.routers.auth import REFRESH_COOKIE_NAME
from app.security import create_refresh_token


def assert_user_shape(user: dict) -> None:
    """<User> is the most reused shape in the whole contract."""
    assert set(user) == {"id", "email", "display_name", "avatar_color", "created_at"}
    assert isinstance(user["id"], int)
    assert isinstance(user["display_name"], str) and user["display_name"]
    assert user["avatar_color"].startswith("#") and len(user["avatar_color"]) == 7
    assert user["created_at"].endswith("Z")


def assert_session_body(body: dict) -> None:
    assert set(body) == {"access_token", "token_type", "expires_in", "user"}
    assert body["token_type"] == "bearer"
    assert body["expires_in"] == 900
    assert_user_shape(body["user"])


async def test_signup_returns_session_and_sets_refresh_cookie(client):
    response = await client.post(
        "/api/auth/signup",
        json={"email": "new@example.com", "password": "correct-horse", "display_name": "New"},
    )
    assert response.status_code == 201
    assert_session_body(response.json())
    assert response.json()["user"]["display_name"] == "New"

    cookie = response.headers.get("set-cookie", "")
    assert REFRESH_COOKIE_NAME in cookie
    assert "HttpOnly" in cookie
    assert "Path=/api/auth" in cookie
    assert "Max-Age=2592000" in cookie


async def test_display_name_falls_back_to_email_local_part(client):
    response = await client.post(
        "/api/auth/signup",
        json={"email": "ekom@example.com", "password": "correct-horse", "display_name": None},
    )
    assert response.status_code == 201
    assert response.json()["user"]["display_name"] == "ekom"


async def test_avatar_colour_is_deterministic_from_the_id(client):
    first = await client.post(
        "/api/auth/signup", json={"email": "a@example.com", "password": "correct-horse"}
    )
    me = await client.get(
        "/api/auth/me", headers={"Authorization": "Bearer " + first.json()["access_token"]}
    )
    assert me.json()["avatar_color"] == first.json()["user"]["avatar_color"]


async def test_duplicate_email_is_409(client, alice):
    response = await client.post(
        "/api/auth/signup", json={"email": alice.email, "password": "correct-horse"}
    )
    assert response.status_code == 409
    assert response.json() == {"error": "An account with that email already exists."}


async def test_short_password_is_422(client):
    response = await client.post(
        "/api/auth/signup", json={"email": "short@example.com", "password": "abc"}
    )
    assert response.status_code == 422
    assert response.json() == {"error": "Password must be at least 8 characters."}


async def test_login_succeeds(client, alice):
    response = await client.post(
        "/api/auth/login", json={"email": alice.email, "password": "correct-horse-battery"}
    )
    assert response.status_code == 200
    assert_session_body(response.json())


@pytest.mark.parametrize(
    "email,password",
    [
        ("alice@example.com", "the-wrong-password"),
        ("nobody@example.com", "correct-horse-battery"),
    ],
    ids=["wrong-password", "unknown-email"],
)
async def test_no_user_enumeration(client, alice, email, password):
    """The same message and the same status for both failures (Contract 1)."""
    response = await client.post("/api/auth/login", json={"email": email, "password": password})
    assert response.status_code == 401
    assert response.json() == {"error": "Incorrect email or password."}


async def test_refresh_rotates_the_cookie(client, alice):
    login = await client.post(
        "/api/auth/login", json={"email": alice.email, "password": "correct-horse-battery"}
    )
    original = login.cookies[REFRESH_COOKIE_NAME]

    response = await client.post("/api/auth/refresh")
    assert response.status_code == 200
    body = response.json()
    assert set(body) == {"access_token", "token_type", "expires_in"}
    assert body["expires_in"] == 900
    assert REFRESH_COOKIE_NAME in response.headers.get("set-cookie", "")
    assert client.cookies[REFRESH_COOKIE_NAME] != original


async def test_refresh_without_a_cookie_is_401(client):
    response = await client.post("/api/auth/refresh")
    assert response.status_code == 401
    assert response.json() == {"error": "Session expired. Please sign in again."}


async def test_logout_invalidates_outstanding_refresh_tokens(client, alice):
    await client.post(
        "/api/auth/login", json={"email": alice.email, "password": "correct-horse-battery"}
    )
    stale = client.cookies[REFRESH_COOKIE_NAME]

    logout = await client.post("/api/auth/logout", headers=alice.headers())
    assert logout.status_code == 204

    client.cookies.set(REFRESH_COOKIE_NAME, stale, path="/api/auth")
    response = await client.post("/api/auth/refresh")
    assert response.status_code == 401
    assert response.json() == {"error": "Session expired. Please sign in again."}


async def test_me_requires_a_token(client):
    response = await client.get("/api/auth/me")
    assert response.status_code == 401
    assert response.json() == {"error": "Not authenticated."}


async def test_me_returns_the_user(alice):
    response = await alice.get("/api/auth/me")
    assert response.status_code == 200
    assert_user_shape(response.json())
    assert response.json()["email"] == alice.email


async def test_refresh_token_is_rejected_as_a_bearer_credential(client, alice):
    """The `typ` claim is verified on every path (Contract 1)."""
    refresh_token = create_refresh_token(alice.id, 0)
    response = await client.get(
        "/api/auth/me", headers={"Authorization": "Bearer " + refresh_token}
    )
    assert response.status_code == 401
    assert response.json() == {"error": "Not authenticated."}


async def test_access_token_carries_the_access_type(alice):
    settings = get_settings()
    claims = jwt.decode(alice.token, settings.jwt_secret, algorithms=[settings.jwt_algorithm])
    assert claims["typ"] == "access"
    assert claims["sub"] == str(alice.id)


async def test_garbage_token_is_401(client):
    response = await client.get("/api/auth/me", headers={"Authorization": "Bearer not-a-jwt"})
    assert response.status_code == 401
    assert response.json() == {"error": "Not authenticated."}
