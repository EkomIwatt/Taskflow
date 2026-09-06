"""Boards, membership and the snapshot — Contract 2."""

from typing import Optional

from fastapi import APIRouter, Query, Response, status
from sqlalchemy import func, select

from app.activity import record_activity
from app.deps import (
    BOARD_NOT_FOUND,
    ClientOpId,
    CurrentUser,
    DbSession,
    board_access_or_404,
    owner_board_or_404,
)
from app.errors import APIError
from app.events import Event, emit
from app.models import Board, BoardMember, Card, User
from app.queries import board_snapshot, recent_activity
from app.realtime import WS_CLOSE_BOARD_NOT_FOUND, WS_CLOSE_NOT_A_MEMBER, hub
from app.schemas import BoardCreateIn, BoardUpdateIn, MemberAddIn
from app.serializers import (
    activity_payload,
    board_summary_payload,
    display_name_for,
    member_payload,
    user_payload,
)

router = APIRouter(prefix="/api", tags=["boards"])

MAX_TITLE_LENGTH = 80
TITLE_REQUIRED = "Board title is required."


def _validate_title(title: Optional[str]) -> str:
    cleaned = (title or "").strip()
    if not cleaned or len(cleaned) > MAX_TITLE_LENGTH:
        raise APIError(status.HTTP_422_UNPROCESSABLE_ENTITY, TITLE_REQUIRED)
    return cleaned


@router.get("/boards")
async def list_boards(user: CurrentUser, db: DbSession) -> dict:
    """Boards the caller owns or is a member of, newest activity first."""
    member_counts = (
        select(BoardMember.board_id, func.count(BoardMember.id).label("member_count"))
        .group_by(BoardMember.board_id)
        .subquery()
    )
    card_counts = (
        select(Card.board_id, func.count(Card.id).label("card_count"))
        .group_by(Card.board_id)
        .subquery()
    )

    result = await db.execute(
        select(
            Board,
            BoardMember.role,
            func.coalesce(member_counts.c.member_count, 0),
            func.coalesce(card_counts.c.card_count, 0),
        )
        .join(BoardMember, BoardMember.board_id == Board.id)
        .outerjoin(member_counts, member_counts.c.board_id == Board.id)
        .outerjoin(card_counts, card_counts.c.board_id == Board.id)
        .where(BoardMember.user_id == user.id)
        .order_by(Board.updated_at.desc(), Board.id.desc())
    )

    return {
        "boards": [
            board_summary_payload(board, role, int(members), int(cards))
            for board, role, members, cards in result.all()
        ]
    }


@router.post("/boards", status_code=status.HTTP_201_CREATED)
async def create_board(
    payload: BoardCreateIn, user: CurrentUser, db: DbSession, client_op_id: ClientOpId
) -> dict:
    title = _validate_title(payload.title)

    board = Board(owner_id=user.id, title=title)
    db.add(board)
    await db.flush()
    # The owner is a membership row too, so every authorization query is the
    # same query regardless of role.
    db.add(BoardMember(board_id=board.id, user_id=user.id, role="owner"))
    await db.flush()

    async with hub.board_lock(board.id):
        entry = await record_activity(
            db, board.id, user, "board.created", {"board_id": board.id, "board_title": board.title}
        )
        # No `board.created` socket event exists — nobody is connected to a
        # board that did not exist a moment ago — but the feed entry is real.
        await emit(
            db,
            hub,
            board.id,
            [Event("activity.appended", activity_payload(entry))],
            actor_id=user.id,
            client_op_id=client_op_id,
        )

    await db.refresh(board)
    return board_summary_payload(board, "owner", member_count=1, card_count=0)


@router.get("/boards/{board_id}")
async def get_board(board_id: int, user: CurrentUser, db: DbSession) -> dict:
    """THE SNAPSHOT. Also the only recovery mechanism after a `seq` gap."""
    access = await board_access_or_404(db, board_id, user.id)
    return await board_snapshot(db, access.board, access.role)


@router.patch("/boards/{board_id}")
async def rename_board(
    board_id: int,
    payload: BoardUpdateIn,
    user: CurrentUser,
    db: DbSession,
    client_op_id: ClientOpId,
) -> dict:
    board = await owner_board_or_404(db, board_id, user.id)
    title = _validate_title(payload.title)

    previous = board.title
    board.title = title
    db.add(board)

    async with hub.board_lock(board.id):
        entry = await record_activity(
            db,
            board.id,
            user,
            "board.renamed",
            {"board_id": board.id, "from_title": previous, "to_title": title},
        )
        await emit(
            db,
            hub,
            board.id,
            [
                Event("board.updated", {"id": board.id, "title": title}),
                Event("activity.appended", activity_payload(entry)),
            ],
            actor_id=user.id,
            client_op_id=client_op_id,
        )

    return {"id": board.id, "title": title}


@router.delete("/boards/{board_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_board(board_id: int, user: CurrentUser, db: DbSession) -> Response:
    """Cascades lists, cards, comments, activity and memberships.

    There is no `board.deleted` event in Contract 6, so connected clients are
    told the only other way the protocol allows: their sockets are closed 4004,
    which routes them away without a reconnect.
    """
    board = await owner_board_or_404(db, board_id, user.id)

    async with hub.board_lock(board_id):
        await db.delete(board)
        await db.commit()
        await hub.close_board_connections(board_id, WS_CLOSE_BOARD_NOT_FOUND)

    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post("/boards/{board_id}/members", status_code=status.HTTP_201_CREATED)
async def add_member(
    board_id: int,
    payload: MemberAddIn,
    user: CurrentUser,
    db: DbSession,
    client_op_id: ClientOpId,
) -> dict:
    board = await owner_board_or_404(db, board_id, user.id)

    email = (payload.email or "").strip().lower()
    invitee = None
    if email:
        result = await db.execute(select(User).where(User.email == email))
        invitee = result.scalar_one_or_none()
    if invitee is None:
        raise APIError(status.HTTP_404_NOT_FOUND, "No account with that email address.")

    existing = await db.execute(
        select(BoardMember).where(
            BoardMember.board_id == board.id, BoardMember.user_id == invitee.id
        )
    )
    if existing.scalar_one_or_none() is not None:
        raise APIError(
            status.HTTP_409_CONFLICT, "That person is already a member of this board."
        )

    membership = BoardMember(board_id=board.id, user_id=invitee.id, role="member")
    db.add(membership)
    await db.flush()

    async with hub.board_lock(board.id):
        entry = await record_activity(
            db,
            board.id,
            user,
            "member.added",
            {"user_id": invitee.id, "display_name": display_name_for(invitee)},
        )
        await emit(
            db,
            hub,
            board.id,
            [
                Event("board.member_added", {"user": user_payload(invitee), "role": "member"}),
                Event("activity.appended", activity_payload(entry)),
            ],
            actor_id=user.id,
            client_op_id=client_op_id,
        )

    return member_payload(invitee, "member", membership.added_at)


@router.delete(
    "/boards/{board_id}/members/{user_id}", status_code=status.HTTP_204_NO_CONTENT
)
async def remove_member(
    board_id: int,
    user_id: int,
    user: CurrentUser,
    db: DbSession,
    client_op_id: ClientOpId,
) -> Response:
    board = await owner_board_or_404(db, board_id, user.id)

    result = await db.execute(
        select(BoardMember, User)
        .join(User, User.id == BoardMember.user_id)
        .where(BoardMember.board_id == board.id, BoardMember.user_id == user_id)
    )
    row = result.first()
    if row is None:
        raise APIError(status.HTTP_404_NOT_FOUND, BOARD_NOT_FOUND)
    membership, member_user = row

    if membership.role == "owner":
        raise APIError(status.HTTP_409_CONFLICT, "The board owner cannot be removed.")

    await db.delete(membership)
    await db.flush()

    async with hub.board_lock(board.id):
        entry = await record_activity(
            db,
            board.id,
            user,
            "member.removed",
            {"user_id": member_user.id, "display_name": display_name_for(member_user)},
        )
        await emit(
            db,
            hub,
            board.id,
            [
                Event("board.member_removed", {"user_id": member_user.id}),
                Event("activity.appended", activity_payload(entry)),
            ],
            actor_id=user.id,
            client_op_id=client_op_id,
        )
        # Contract 6 §3: the removed user is told first, then disconnected. A
        # ticket minted a moment ago is now useless — connect-time membership is
        # re-checked, so it cannot be used to get back in.
        await hub.close_user_connections(board.id, member_user.id, WS_CLOSE_NOT_A_MEMBER)

    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.get("/boards/{board_id}/activity")
async def board_activity(
    board_id: int,
    user: CurrentUser,
    db: DbSession,
    limit: int = Query(default=50, ge=1, le=100),
    before_id: Optional[int] = Query(default=None),
) -> dict:
    """Newest first, cursored by id — Contract 5."""
    access = await board_access_or_404(db, board_id, user.id)
    entries = await recent_activity(db, access.board.id, limit=limit, before_id=before_id)
    next_before_id = entries[-1].id if len(entries) == limit else None
    return {
        "activity": [activity_payload(entry) for entry in entries],
        "next_before_id": next_before_id,
    }
