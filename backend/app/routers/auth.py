"""Authentication — Contract 1.

Carried over from LedgerLite unchanged in shape: argon2 password hashing, an
HS256 access token in the response body, and a rotating httpOnly refresh cookie
scoped to ``/api/auth``. The access token never touches storage the browser's
JavaScript can read; session survival across a reload comes from the cookie.
"""

import re
from typing import Optional

from fastapi import APIRouter, Request, Response, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import get_settings
from app.deps import CurrentUser, DbSession, NOT_AUTHENTICATED
from app.errors import APIError
from app.models import User
from app.schemas import LoginIn, SignupIn
from app.security import (
    TOKEN_TYPE_REFRESH,
    TokenError,
    create_access_token,
    create_refresh_token,
    decode_token,
    hash_password,
    verify_password_constant_time,
)
from app.serializers import user_payload

router = APIRouter(prefix="/api/auth", tags=["auth"])

REFRESH_COOKIE_NAME = "refresh_token"

#: Contract 1 pins these two sentences exactly.
CREDENTIALS_MESSAGE = "Incorrect email or password."
SESSION_EXPIRED_MESSAGE = "Session expired. Please sign in again."

MIN_PASSWORD_LENGTH = 8
_EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


def _normalise_email(email: Optional[str]) -> str:
    if not email or not _EMAIL_RE.match(email.strip()):
        raise APIError(
            status.HTTP_422_UNPROCESSABLE_ENTITY, "Please enter a valid email address."
        )
    return email.strip().lower()


def _validate_password(password: Optional[str]) -> str:
    if not password or len(password) < MIN_PASSWORD_LENGTH:
        raise APIError(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            "Password must be at least {} characters.".format(MIN_PASSWORD_LENGTH),
        )
    return password


def _set_refresh_cookie(response: Response, token: str) -> None:
    settings = get_settings()
    response.set_cookie(
        key=REFRESH_COOKIE_NAME,
        value=token,
        max_age=settings.refresh_token_expire_seconds,
        httponly=True,
        secure=settings.cookie_secure,
        samesite=settings.cookie_samesite,
        path=settings.cookie_path,
        domain=settings.cookie_domain or None,
    )


def _clear_refresh_cookie(response: Response) -> None:
    settings = get_settings()
    response.delete_cookie(
        key=REFRESH_COOKIE_NAME,
        path=settings.cookie_path,
        domain=settings.cookie_domain or None,
    )


def _session_body(user: User) -> dict:
    settings = get_settings()
    return {
        "access_token": create_access_token(user.id),
        "token_type": "bearer",
        "expires_in": settings.access_token_expire_seconds,
        "user": user_payload(user),
    }


async def _user_by_email(db: AsyncSession, email: str) -> Optional[User]:
    result = await db.execute(select(User).where(User.email == email))
    return result.scalar_one_or_none()


@router.post("/signup", status_code=status.HTTP_201_CREATED)
async def signup(payload: SignupIn, response: Response, db: DbSession) -> dict:
    email = _normalise_email(payload.email)
    password = _validate_password(payload.password)

    if await _user_by_email(db, email) is not None:
        raise APIError(
            status.HTTP_409_CONFLICT, "An account with that email already exists."
        )

    display_name = (payload.display_name or "").strip() or None
    user = User(email=email, password_hash=hash_password(password), display_name=display_name)
    db.add(user)
    await db.commit()
    await db.refresh(user)

    _set_refresh_cookie(response, create_refresh_token(user.id, user.token_version))
    return _session_body(user)


@router.post("/login")
async def login(payload: LoginIn, response: Response, db: DbSession) -> dict:
    email = (payload.email or "").strip().lower()
    password = payload.password or ""

    user = await _user_by_email(db, email) if email else None

    # The same message, the same status, and the same amount of hashing work for
    # an unknown email as for a wrong password. Contract 1 forbids enumeration
    # "not by message, not by status, not by timing".
    if not verify_password_constant_time(password, user.password_hash if user else None):
        raise APIError(status.HTTP_401_UNAUTHORIZED, CREDENTIALS_MESSAGE)
    assert user is not None  # implied by the verify above succeeding

    _set_refresh_cookie(response, create_refresh_token(user.id, user.token_version))
    return _session_body(user)


@router.post("/refresh")
async def refresh(request: Request, response: Response, db: DbSession) -> dict:
    """Cookie only — no body, no Authorization header.

    The cookie is rotated on every refresh, and the token's ``tv`` claim is
    checked against the user's current ``token_version`` so that a logout
    invalidates every refresh token outstanding at the time.
    """
    token = request.cookies.get(REFRESH_COOKIE_NAME)
    if not token:
        raise APIError(status.HTTP_401_UNAUTHORIZED, SESSION_EXPIRED_MESSAGE)

    try:
        claims = decode_token(token, TOKEN_TYPE_REFRESH)
    except TokenError:
        _clear_refresh_cookie(response)
        raise APIError(status.HTTP_401_UNAUTHORIZED, SESSION_EXPIRED_MESSAGE)

    user = await db.get(User, claims["user_id"])
    if user is None or claims.get("tv") != user.token_version:
        _clear_refresh_cookie(response)
        raise APIError(status.HTTP_401_UNAUTHORIZED, SESSION_EXPIRED_MESSAGE)

    settings = get_settings()
    _set_refresh_cookie(response, create_refresh_token(user.id, user.token_version))
    return {
        "access_token": create_access_token(user.id),
        "token_type": "bearer",
        "expires_in": settings.access_token_expire_seconds,
    }


@router.post("/logout", status_code=status.HTTP_204_NO_CONTENT)
async def logout(user: CurrentUser, response: Response, db: DbSession) -> Response:
    """Clears the cookie and invalidates every outstanding refresh token."""
    user.token_version += 1
    db.add(user)
    await db.commit()

    result = Response(status_code=status.HTTP_204_NO_CONTENT)
    _clear_refresh_cookie(result)
    return result


@router.get("/me")
async def me(user: CurrentUser) -> dict:
    return user_payload(user)


__all__ = ["router", "REFRESH_COOKIE_NAME", "NOT_AUTHENTICATED"]
