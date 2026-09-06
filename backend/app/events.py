"""Sequencing and broadcast — the transaction boundary of Contract 6.

One helper, :func:`emit`, owns the whole ordering discipline:

1. allocate a contiguous block of `seq` values inside the mutation's transaction,
2. **commit**,
3. only then broadcast.

Step 3 following step 2 is the rule that matters. A client that receives
``card.moved`` and immediately refetches the snapshot must already see that move
in it; emitting inside the transaction is the classic source of "the event
arrived before the data existed" flakiness.

Callers hold ``hub.board_lock(board_id)`` around the whole sequence, so two
concurrent mutations on one board can neither share a `seq` nor be delivered out
of order.
"""

from typing import Any, Dict, List, NamedTuple, Optional

from sqlalchemy import update
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import Board, utcnow
from app.realtime import Hub, build_envelope


class Event(NamedTuple):
    """One state event awaiting a `seq`."""

    type: str
    payload: Dict[str, Any]


async def allocate_seq(db: AsyncSession, board_id: int, count: int) -> int:
    """Reserve ``count`` consecutive `seq` values and return the first.

    A single ``UPDATE ... RETURNING`` takes the board's row lock, so even
    without the hub's asyncio lock two transactions can never be handed the
    same value. ``updated_at`` rides along because GET /api/boards orders by
    "newest activity first", which means any mutation anywhere in the board.
    """
    if count <= 0:
        raise ValueError("count must be positive")
    result = await db.execute(
        update(Board)
        .where(Board.id == board_id)
        .values(seq=Board.seq + count, updated_at=utcnow())
        .returning(Board.seq)
    )
    last = result.scalar_one()
    return last - count + 1


async def emit(
    db: AsyncSession,
    hub: Hub,
    board_id: int,
    events: List[Event],
    actor_id: Optional[int] = None,
    client_op_id: Optional[str] = None,
) -> List[Dict[str, Any]]:
    """Allocate seqs, commit, then broadcast. Returns the envelopes sent.

    ``client_op_id`` is echoed verbatim from the originating request's
    ``X-Client-Op-Id`` header (Contract 7). It is opaque to the server: never
    stored, never validated, never used for idempotency.
    """
    if not events:
        await db.commit()
        return []

    first_seq = await allocate_seq(db, board_id, len(events))
    envelopes = [
        build_envelope(
            event.type,
            board_id,
            event.payload,
            seq=first_seq + offset,
            actor_id=actor_id,
            client_op_id=client_op_id,
        )
        for offset, event in enumerate(events)
    ]

    await db.commit()

    for envelope in envelopes:
        await hub.broadcast(board_id, envelope)
    return envelopes


async def emit_rebalance(
    db: AsyncSession, hub: Hub, board_id: int, list_id: int, cards: List[Dict[str, Any]]
) -> Dict[str, Any]:
    """Broadcast the `list.rebalanced` escape hatch of Contract 4.

    Server-originated, so ``actor_id`` is null and there is no activity entry —
    Contract 5's verb enumeration has no rebalance verb. This should almost
    never fire; it exists so invariant I2 ("the server can always mint a key
    strictly between two neighbours") is true without exception.
    """
    envelopes = await emit(
        db,
        hub,
        board_id,
        [Event("list.rebalanced", {"list_id": list_id, "cards": cards})],
        actor_id=None,
        client_op_id=None,
    )
    return envelopes[0]
