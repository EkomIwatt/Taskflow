"""Password hashing and JWTs — Contract 1.

Two details here are load-bearing rather than incidental:

* ``typ`` is verified on every path. A refresh token presented as a Bearer
  credential is rejected 401, and an access token presented in the refresh
  cookie is rejected the same way.
* :func:`verify_password_constant_time` runs a hash comparison even when the
  email is unknown. Contract 1 forbids user enumeration "not by message, not by
  status, not by timing", and an early return on a missing user is exactly the
  timing oracle that gives it away.
"""

import secrets
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, Optional

import jwt
from passlib.context import CryptContext

from app.config import get_settings

pwd_context = CryptContext(schemes=["argon2"], deprecated="auto")

#: Hashing a throwaway password once at import time gives us a realistic decoy
#: to verify against when the email does not exist.
_DUMMY_HASH = pwd_context.hash("taskflow-timing-equaliser")

TOKEN_TYPE_ACCESS = "access"
TOKEN_TYPE_REFRESH = "refresh"


class TokenError(Exception):
    """A token was missing, malformed, expired, or of the wrong `typ`."""


def hash_password(password: str) -> str:
    return pwd_context.hash(password)


def verify_password(password: str, password_hash: str) -> bool:
    try:
        return pwd_context.verify(password, password_hash)
    except Exception:
        return False


def verify_password_constant_time(password: str, password_hash: Optional[str]) -> bool:
    """Verify, burning the same work when there is no user to verify against."""
    if password_hash is None:
        pwd_context.verify(password, _DUMMY_HASH)
        return False
    return verify_password(password, password_hash)


def _encode(claims: Dict[str, Any], expires_in: int) -> str:
    settings = get_settings()
    now = datetime.now(timezone.utc)
    payload = dict(claims)
    payload.update({"iat": now, "exp": now + timedelta(seconds=expires_in)})
    return jwt.encode(payload, settings.jwt_secret, algorithm=settings.jwt_algorithm)


def create_access_token(user_id: int) -> str:
    settings = get_settings()
    return _encode(
        {"sub": str(user_id), "typ": TOKEN_TYPE_ACCESS}, settings.access_token_expire_seconds
    )


def create_refresh_token(user_id: int, token_version: int) -> str:
    """Mint a refresh token.

    The random ``jti`` is what makes "rotated on every refresh" (Contract 1)
    literally true: without it, two refreshes inside the same second would
    produce byte-identical tokens, since every other claim is unchanged and
    ``iat``/``exp`` only have second resolution.
    """
    settings = get_settings()
    return _encode(
        {
            "sub": str(user_id),
            "typ": TOKEN_TYPE_REFRESH,
            "tv": token_version,
            "jti": secrets.token_urlsafe(8),
        },
        settings.refresh_token_expire_seconds,
    )


def decode_token(token: str, expected_type: str) -> Dict[str, Any]:
    """Decode and verify a token, including its ``typ`` claim.

    Raises :class:`TokenError` for anything wrong — the caller turns that into
    the one 401 sentence the contract specifies for its route.
    """
    settings = get_settings()
    try:
        claims = jwt.decode(token, settings.jwt_secret, algorithms=[settings.jwt_algorithm])
    except jwt.PyJWTError as exc:
        raise TokenError(str(exc)) from exc

    if claims.get("typ") != expected_type:
        raise TokenError("Wrong token type.")
    subject = claims.get("sub")
    if subject is None:
        raise TokenError("Token has no subject.")
    try:
        claims["user_id"] = int(subject)
    except (TypeError, ValueError) as exc:
        raise TokenError("Token subject is not a user id.") from exc
    return claims
