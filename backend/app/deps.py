"""Shared dependencies: the current user, and membership-scoped resolution.

Authorization here is LedgerLite's discipline one level up. There, scoping was
``user_id = current_user.id``; here it is **membership**, and every read and
write resolves its target back to a board and asserts the caller is a member of
it *in the same query*. A card id and a comment id are each authorized through
their board, never through their parent alone.

Every failure is **404, never 403** — board membership must not be discoverable
by probing ids.
"""

from typing import NamedTuple, Optional

from fastapi import Depends, Header, Request, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload
from typing_extensions import Annotated

from app.database import get_db
from app.errors import APIError
from app.models import Board, BoardList, BoardMember, Card, Comment, User
from app.security import TokenError, TOKEN_TYPE_ACCESS, decode_token

NOT_AUTHENTICATED = "Not authenticated."
BOARD_NOT_FOUND = "Board not found."
LIST_NOT_FOUND = "List not found."
CARD_NOT_FOUND = "Card not found."
COMMENT_NOT_FOUND = "Comment not found."


class BoardAccess(NamedTuple):
    """A board the caller is proven to be a member of, plus their role."""

    board: Board
    role: str


def _unauthenticated() -> APIError:
    return APIError(
        status.HTTP_401_UNAUTHORIZED,
        NOT_AUTHENTICATED,
        headers={"WWW-Authenticate": "Bearer"},
    )


def bearer_token(request: Request) -> str:
    header = request.headers.get("authorization") or ""
    scheme, _, token = header.partition(" ")
    if scheme.lower() != "bearer" or not token.strip():
        raise _unauthenticated()
    return token.strip()


async def get_current_user(
    db: Annotated[AsyncSession, Depends(get_db)],
    token: Annotated[str, Depends(bearer_token)],
) -> User:
    """Resolve the access token to a user.

    The ``typ`` claim is checked inside :func:`decode_token`, so a *refresh*
    token presented as a Bearer credential is rejected here with a 401 rather
    than quietly working.
    """
    try:
        claims = decode_token(token, TOKEN_TYPE_ACCESS)
    except TokenError:
        raise _unauthenticated()

    user = await db.get(User, claims["user_id"])
    if user is None:
        raise _unauthenticated()
    return user


CurrentUser = Annotated[User, Depends(get_current_user)]
DbSession = Annotated[AsyncSession, Depends(get_db)]


async def client_op_id(
    x_client_op_id: Annotated[Optional[str], Header(alias="X-Client-Op-Id")] = None,
) -> Optional[str]:
    """Contract 7: echoed verbatim into the broadcast envelope, otherwise opaque.

    Never stored, never validated, never used for idempotency. Trimmed only so a
    stray newline cannot break the envelope.
    """
    if x_client_op_id is None:
        return None
    value = x_client_op_id.strip()
    return value[:128] if value else None


ClientOpId = Annotated[Optional[str], Depends(client_op_id)]


# ---------------------------------------------------------------------------
# Membership-scoped resolution
# ---------------------------------------------------------------------------


async def board_access_or_404(db: AsyncSession, board_id: int, user_id: int) -> BoardAccess:
    """Resolve a board the caller is a member of, or 404.

    This is the single funnel every board-scoped route goes through. A route
    that fetches by id without it is the worst bug this project can ship.
    """
    result = await db.execute(
        select(Board, BoardMember.role)
        .join(BoardMember, BoardMember.board_id == Board.id)
        .where(Board.id == board_id, BoardMember.user_id == user_id)
    )
    row = result.first()
    if row is None:
        raise APIError(status.HTTP_404_NOT_FOUND, BOARD_NOT_FOUND)
    return BoardAccess(board=row[0], role=row[1])


async def owner_board_or_404(db: AsyncSession, board_id: int, user_id: int) -> Board:
    """Owner-only routes. A non-owner member gets the same 404 as a stranger."""
    access = await board_access_or_404(db, board_id, user_id)
    if access.role != "owner":
        raise APIError(status.HTTP_404_NOT_FOUND, BOARD_NOT_FOUND)
    return access.board


async def list_access_or_404(db: AsyncSession, list_id: int, user_id: int) -> BoardList:
    """A list, authorized through its board's membership in one query."""
    result = await db.execute(
        select(BoardList)
        .join(BoardMember, BoardMember.board_id == BoardList.board_id)
        .where(BoardList.id == list_id, BoardMember.user_id == user_id)
    )
    board_list = result.scalar_one_or_none()
    if board_list is None:
        raise APIError(status.HTTP_404_NOT_FOUND, LIST_NOT_FOUND)
    return board_list


async def card_access_or_404(db: AsyncSession, card_id: int, user_id: int) -> Card:
    """A card, authorized through ``cards.board_id`` — no join back via the list.

    This is what the denormalised column is for.
    """
    result = await db.execute(
        select(Card)
        .options(selectinload(Card.creator))
        .join(BoardMember, BoardMember.board_id == Card.board_id)
        .where(Card.id == card_id, BoardMember.user_id == user_id)
    )
    card = result.scalar_one_or_none()
    if card is None:
        raise APIError(status.HTTP_404_NOT_FOUND, CARD_NOT_FOUND)
    return card


async def comment_access_or_404(db: AsyncSession, comment_id: int, user_id: int) -> Comment:
    """A comment, authorized through its board's membership."""
    result = await db.execute(
        select(Comment)
        .options(selectinload(Comment.author))
        .join(BoardMember, BoardMember.board_id == Comment.board_id)
        .where(Comment.id == comment_id, BoardMember.user_id == user_id)
    )
    comment = result.scalar_one_or_none()
    if comment is None:
        raise APIError(status.HTTP_404_NOT_FOUND, COMMENT_NOT_FOUND)
    return comment
