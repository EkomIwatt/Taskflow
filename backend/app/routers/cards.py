"""Cards — Contract 3, including the move endpoint.

The move is the project's whole premise, so the invariants it has to hold are
worth stating plainly:

* **The client sends neighbour ids, never keys.** An ``order_key`` is never
  accepted from a client, on any route.
* **Both neighbours are re-read inside the move transaction.** If either no
  longer sits in the destination list the answer is 409 — the server does not
  guess a position from stale input.
* **One card moved is exactly one row updated.** No sibling is renumbered. The
  only code path that touches siblings is the rebalance escape hatch, which is
  a separate, broadcast, server-originated event.
"""

from typing import Optional, Tuple

from fastapi import APIRouter, Response, status
from sqlalchemy import select

from app.activity import record_activity
from app.deps import ClientOpId, CurrentUser, DbSession, card_access_or_404, list_access_or_404
from app.errors import APIError
from app.events import Event, emit, emit_rebalance
from app.models import BoardList, Card, utcnow
from app.ordering import MAX_KEY_LENGTH, key_between
from app.queries import (
    card_payload_with_count,
    comment_count,
    key_after_card,
    needs_rebalance,
    rebalance_list,
)
from app.realtime import hub
from app.schemas import CardCreateIn, CardMoveIn, CardUpdateIn
from app.serializers import activity_payload, card_payload

router = APIRouter(prefix="/api", tags=["cards"])

MAX_TITLE_LENGTH = 255
TITLE_REQUIRED = "Card title is required."
STALE_DRAG = "The board changed while you were dragging. Refreshing."
CROSS_BOARD = "Cards cannot be moved to another board."
DESTINATION_REQUIRED = "A destination list is required."
NOTHING_TO_UPDATE = "There is nothing to update."


def _validate_title(title: Optional[str]) -> str:
    cleaned = (title or "").strip()
    if not cleaned or len(cleaned) > MAX_TITLE_LENGTH:
        raise APIError(status.HTTP_422_UNPROCESSABLE_ENTITY, TITLE_REQUIRED)
    return cleaned


@router.post("/lists/{list_id}/cards", status_code=status.HTTP_201_CREATED)
async def create_card(
    list_id: int,
    payload: CardCreateIn,
    user: CurrentUser,
    db: DbSession,
    client_op_id: ClientOpId,
) -> dict:
    board_list = await list_access_or_404(db, list_id, user.id)
    title = _validate_title(payload.title)

    order_key = await key_after_card(db, list_id, payload.after_card_id)
    card = Card(
        list_id=list_id,
        board_id=board_list.board_id,
        title=title,
        description="",
        order_key=order_key,
        created_by=user.id,
    )
    db.add(card)
    await db.flush()
    card.creator = user

    body = card_payload(card, comment_count=0)

    async with hub.board_lock(board_list.board_id):
        entry = await record_activity(
            db,
            board_list.board_id,
            user,
            "card.created",
            {"card_id": card.id, "card_title": title, "to_list": board_list.title},
        )
        await emit(
            db,
            hub,
            board_list.board_id,
            [
                Event("card.created", body),
                Event("activity.appended", activity_payload(entry)),
            ],
            actor_id=user.id,
            client_op_id=client_op_id,
        )

    return body


@router.patch("/cards/{card_id}")
async def update_card(
    card_id: int,
    payload: CardUpdateIn,
    user: CurrentUser,
    db: DbSession,
    client_op_id: ClientOpId,
) -> dict:
    """Partial update. An absent key means unchanged; ``description: ""`` clears it.

    Conflict policy is last-write-wins at the field level, decided here
    (Contract 7 §6). Two people editing one title: the second write wins, and
    both clients converge because both receive both `card.updated` events in
    `seq` order.
    """
    card = await card_access_or_404(db, card_id, user.id)
    provided = payload.model_fields_set

    if "title" not in provided and "description" not in provided:
        raise APIError(status.HTTP_422_UNPROCESSABLE_ENTITY, NOTHING_TO_UPDATE)

    previous_title = card.title
    if "title" in provided:
        card.title = _validate_title(payload.title)
        verb = "card.renamed"
    else:
        verb = "card.described"

    if "description" in provided:
        card.description = payload.description or ""

    card.updated_at = utcnow()
    db.add(card)
    await db.flush()

    body = await card_payload_with_count(db, card)

    async with hub.board_lock(card.board_id):
        entry = await record_activity(
            db,
            card.board_id,
            user,
            verb,
            {"card_id": card.id, "card_title": card.title, "from_title": previous_title},
        )
        await emit(
            db,
            hub,
            card.board_id,
            [
                Event("card.updated", body),
                Event("activity.appended", activity_payload(entry)),
            ],
            actor_id=user.id,
            client_op_id=client_op_id,
        )

    return body


async def _neighbour_card_key(
    db: DbSession, destination_list_id: int, card_id: Optional[int], moving_id: int
) -> Optional[str]:
    """Re-read a named neighbour inside the move transaction, or 409.

    A neighbour that has been deleted, has been moved out of the destination
    list, or is the moved card itself, all mean the same thing: the board the
    client was looking at is not the board that exists now.
    """
    if card_id is None:
        return None
    if card_id == moving_id:
        raise APIError(status.HTTP_409_CONFLICT, STALE_DRAG)
    result = await db.execute(
        select(Card.order_key).where(Card.id == card_id, Card.list_id == destination_list_id)
    )
    key = result.scalar_one_or_none()
    if key is None:
        raise APIError(status.HTTP_409_CONFLICT, STALE_DRAG)
    return key


async def _resolve_destination(db: DbSession, card: Card, list_id: Optional[int]) -> BoardList:
    if list_id is None:
        raise APIError(status.HTTP_422_UNPROCESSABLE_ENTITY, DESTINATION_REQUIRED)
    destination = await db.get(BoardList, list_id)
    if destination is None:
        # The destination list was deleted mid-drag.
        raise APIError(status.HTTP_409_CONFLICT, STALE_DRAG)
    if destination.board_id != card.board_id:
        raise APIError(status.HTTP_422_UNPROCESSABLE_ENTITY, CROSS_BOARD)
    return destination


@router.patch("/cards/{card_id}/move")
async def move_card(
    card_id: int,
    payload: CardMoveIn,
    user: CurrentUser,
    db: DbSession,
    client_op_id: ClientOpId,
) -> dict:
    card = await card_access_or_404(db, card_id, user.id)
    destination = await _resolve_destination(db, card, payload.list_id)

    source_list = await db.get(BoardList, card.list_id)
    from_list_id = card.list_id
    from_list_title = source_list.title if source_list is not None else ""

    async def read_neighbours() -> Tuple[Optional[str], Optional[str]]:
        before = await _neighbour_card_key(db, destination.id, payload.before_card_id, card.id)
        after = await _neighbour_card_key(db, destination.id, payload.after_card_id, card.id)
        return before, after

    before_key, after_key = await read_neighbours()

    rebalanced: Optional[list] = None
    if needs_rebalance(before_key, after_key):
        # Contract 4's escape hatch. Two concurrent inserts into one gap can
        # legally mint equal keys, and a gap squeezed for long enough runs out
        # of room; either way the list is renormalised and the neighbours are
        # re-read against their fresh keys.
        rebalanced = await rebalance_list(db, destination.id)
        before_key, after_key = await read_neighbours()

    order_key = key_between(before_key, after_key)
    if len(order_key) > MAX_KEY_LENGTH:  # pragma: no cover - rebalance prevents this
        rebalanced = await rebalance_list(db, destination.id)
        before_key, after_key = await read_neighbours()
        order_key = key_between(before_key, after_key)

    # THE move: exactly one row, two columns. No sibling is touched.
    card.list_id = destination.id
    card.order_key = order_key
    card.updated_at = utcnow()
    db.add(card)
    await db.flush()

    count = await comment_count(db, card.id)
    body = card_payload(card, count)

    async with hub.board_lock(card.board_id):
        if rebalanced is not None:
            # Server-originated, actor-less, and separate from the move itself,
            # so clients apply the fresh keys before the move that needed them.
            await emit_rebalance(db, hub, card.board_id, destination.id, rebalanced)

        entry = await record_activity(
            db,
            card.board_id,
            user,
            "card.moved",
            {
                "card_id": card.id,
                "card_title": card.title,
                "from_list": from_list_title,
                "to_list": destination.title,
            },
        )
        await emit(
            db,
            hub,
            card.board_id,
            [
                Event(
                    "card.moved",
                    {
                        "id": card.id,
                        "list_id": card.list_id,
                        "from_list_id": from_list_id,
                        "order_key": card.order_key,
                        "updated_at": body["updated_at"],
                    },
                ),
                Event("activity.appended", activity_payload(entry)),
            ],
            actor_id=user.id,
            client_op_id=client_op_id,
        )

    return body


@router.delete("/cards/{card_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_card(
    card_id: int, user: CurrentUser, db: DbSession, client_op_id: ClientOpId
) -> Response:
    card = await card_access_or_404(db, card_id, user.id)
    board_id = card.board_id
    list_id = card.list_id
    title = card.title

    await db.delete(card)
    await db.flush()

    async with hub.board_lock(board_id):
        entry = await record_activity(
            db, board_id, user, "card.deleted", {"card_id": card_id, "card_title": title}
        )
        await emit(
            db,
            hub,
            board_id,
            [
                Event("card.deleted", {"id": card_id, "list_id": list_id}),
                Event("activity.appended", activity_payload(entry)),
            ],
            actor_id=user.id,
            client_op_id=client_op_id,
        )

    return Response(status_code=status.HTTP_204_NO_CONTENT)
