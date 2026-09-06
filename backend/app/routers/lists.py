"""Lists — Contract 3.

A list move is the same shape as a card move: the client names the neighbours it
dropped between and the server mints the key. The one asymmetry is the escape
hatch. Contract 4's ``list.rebalanced`` renormalises the *cards inside* a list;
there is no broadcast for renormalising the *board's lists*, so when a list gap
is genuinely exhausted this route returns 409 and lets the client refetch rather
than silently renumbering keys the client would never hear about.
See ESCALATION 2026-09-06 in CLAUDE.md.
"""

from typing import Optional

from fastapi import APIRouter, Response, status
from sqlalchemy import select

from app.activity import record_activity
from app.deps import (
    ClientOpId,
    CurrentUser,
    DbSession,
    board_access_or_404,
    list_access_or_404,
)
from app.errors import APIError
from app.events import Event, emit
from app.models import BoardList
from app.ordering import MAX_KEY_LENGTH, key_between
from app.queries import key_after_list, needs_rebalance
from app.realtime import hub
from app.schemas import ListCreateIn, ListMoveIn, ListUpdateIn
from app.serializers import activity_payload, list_payload

router = APIRouter(prefix="/api", tags=["lists"])

MAX_TITLE_LENGTH = 80
TITLE_REQUIRED = "List title is required."
STALE_DRAG = "The board changed while you were dragging. Refreshing."


def _validate_title(title: Optional[str]) -> str:
    cleaned = (title or "").strip()
    if not cleaned or len(cleaned) > MAX_TITLE_LENGTH:
        raise APIError(status.HTTP_422_UNPROCESSABLE_ENTITY, TITLE_REQUIRED)
    return cleaned


@router.post("/boards/{board_id}/lists", status_code=status.HTTP_201_CREATED)
async def create_list(
    board_id: int,
    payload: ListCreateIn,
    user: CurrentUser,
    db: DbSession,
    client_op_id: ClientOpId,
) -> dict:
    access = await board_access_or_404(db, board_id, user.id)
    title = _validate_title(payload.title)

    order_key = await key_after_list(db, board_id, payload.after_list_id)
    board_list = BoardList(board_id=board_id, title=title, order_key=order_key)
    db.add(board_list)
    await db.flush()

    body = list_payload(board_list, cards=[])

    async with hub.board_lock(board_id):
        entry = await record_activity(
            db,
            board_id,
            user,
            "list.created",
            {"list_id": board_list.id, "list_title": title},
        )
        await emit(
            db,
            hub,
            board_id,
            [
                Event("list.created", body),
                Event("activity.appended", activity_payload(entry)),
            ],
            actor_id=user.id,
            client_op_id=client_op_id,
        )

    del access
    return body


@router.patch("/lists/{list_id}")
async def rename_list(
    list_id: int,
    payload: ListUpdateIn,
    user: CurrentUser,
    db: DbSession,
    client_op_id: ClientOpId,
) -> dict:
    board_list = await list_access_or_404(db, list_id, user.id)
    title = _validate_title(payload.title)

    previous = board_list.title
    board_list.title = title
    db.add(board_list)

    async with hub.board_lock(board_list.board_id):
        entry = await record_activity(
            db,
            board_list.board_id,
            user,
            "list.renamed",
            {"list_id": board_list.id, "from_title": previous, "list_title": title},
        )
        await emit(
            db,
            hub,
            board_list.board_id,
            [
                Event("list.updated", {"id": board_list.id, "title": title}),
                Event("activity.appended", activity_payload(entry)),
            ],
            actor_id=user.id,
            client_op_id=client_op_id,
        )

    return {"id": board_list.id, "title": title}


async def _neighbour_list_key(
    db: DbSession, board_id: int, list_id: Optional[int], moving_id: int
) -> Optional[str]:
    """Re-read a named neighbour inside the transaction, or 409.

    The server never guesses a position from stale input: if the neighbour has
    been deleted, moved to another board, or is the list being moved itself, the
    client is told to refetch.
    """
    if list_id is None:
        return None
    if list_id == moving_id:
        raise APIError(status.HTTP_409_CONFLICT, STALE_DRAG)
    result = await db.execute(
        select(BoardList.order_key).where(
            BoardList.id == list_id, BoardList.board_id == board_id
        )
    )
    key = result.scalar_one_or_none()
    if key is None:
        raise APIError(status.HTTP_409_CONFLICT, STALE_DRAG)
    return key


@router.patch("/lists/{list_id}/move")
async def move_list(
    list_id: int,
    payload: ListMoveIn,
    user: CurrentUser,
    db: DbSession,
    client_op_id: ClientOpId,
) -> dict:
    board_list = await list_access_or_404(db, list_id, user.id)
    board_id = board_list.board_id

    before_key = await _neighbour_list_key(db, board_id, payload.before_list_id, list_id)
    after_key = await _neighbour_list_key(db, board_id, payload.after_list_id, list_id)

    if needs_rebalance(before_key, after_key):
        # No contract event exists to tell clients that list keys were
        # renormalised, so refetching is the only honest answer.
        raise APIError(status.HTTP_409_CONFLICT, STALE_DRAG)

    order_key = key_between(before_key, after_key)
    if len(order_key) > MAX_KEY_LENGTH:  # pragma: no cover - guarded above
        raise APIError(status.HTTP_409_CONFLICT, STALE_DRAG)

    # Exactly one row is updated. No siblings are renumbered.
    board_list.order_key = order_key
    db.add(board_list)

    async with hub.board_lock(board_id):
        # Contract 5's verb enumeration has no list.moved verb, so a list move
        # is one of the two mutations that writes no activity entry.
        await emit(
            db,
            hub,
            board_id,
            [Event("list.moved", {"id": board_list.id, "order_key": order_key})],
            actor_id=user.id,
            client_op_id=client_op_id,
        )

    return {"id": board_list.id, "order_key": order_key}


@router.delete("/lists/{list_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_list(
    list_id: int, user: CurrentUser, db: DbSession, client_op_id: ClientOpId
) -> Response:
    """Cascades its cards, but broadcasts one `list.deleted` — not one event per
    orphaned card. The client drops the list and everything in it."""
    board_list = await list_access_or_404(db, list_id, user.id)
    board_id = board_list.board_id
    title = board_list.title

    await db.delete(board_list)
    await db.flush()

    async with hub.board_lock(board_id):
        entry = await record_activity(
            db, board_id, user, "list.deleted", {"list_id": list_id, "list_title": title}
        )
        await emit(
            db,
            hub,
            board_id,
            [
                Event("list.deleted", {"id": list_id}),
                Event("activity.appended", activity_payload(entry)),
            ],
            actor_id=user.id,
            client_op_id=client_op_id,
        )

    return Response(status_code=status.HTTP_204_NO_CONTENT)
