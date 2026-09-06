"""Reusable reads, ordering and the rebalance primitive.

Every ordered read in the project goes through here so the binding tie-break of
Contract 4 — ``ORDER BY order_key ASC, id ASC`` — is written once. The tie-break
is not decorative: two concurrent inserts against the same neighbours can, in a
pathological interleaving, mint the same key. The server treats that as legal,
and the ``id`` secondary sort is what keeps every client deterministic anyway.
"""

from typing import Any, Dict, List, Optional, Sequence, Tuple

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.models import Activity, Board, BoardList, BoardMember, Card, Comment, User
from app.ordering import MAX_KEY_LENGTH, key_between, sequential_keys
from app.serializers import (
    activity_payload,
    card_payload,
    member_payload,
    snapshot_list_payload,
)

#: Contract 2: the snapshot carries the most recent 50 activity entries.
ACTIVITY_PAGE_SIZE = 50


# ---------------------------------------------------------------------------
# Ordered reads
# ---------------------------------------------------------------------------


async def lists_in_board(db: AsyncSession, board_id: int) -> List[BoardList]:
    result = await db.execute(
        select(BoardList)
        .where(BoardList.board_id == board_id)
        .order_by(BoardList.order_key.asc(), BoardList.id.asc())
    )
    return list(result.scalars().all())


async def cards_in_list(db: AsyncSession, list_id: int) -> List[Card]:
    result = await db.execute(
        select(Card)
        .options(selectinload(Card.creator))
        .where(Card.list_id == list_id)
        .order_by(Card.order_key.asc(), Card.id.asc())
    )
    return list(result.scalars().all())


async def cards_in_board(db: AsyncSession, board_id: int) -> List[Card]:
    result = await db.execute(
        select(Card)
        .options(selectinload(Card.creator))
        .where(Card.board_id == board_id)
        .order_by(Card.order_key.asc(), Card.id.asc())
    )
    return list(result.scalars().all())


async def comment_counts(db: AsyncSession, card_ids: Sequence[int]) -> Dict[int, int]:
    """Comment counts for many cards in one query, so the snapshot is not N+1."""
    if not card_ids:
        return {}
    result = await db.execute(
        select(Comment.card_id, func.count(Comment.id))
        .where(Comment.card_id.in_(list(card_ids)))
        .group_by(Comment.card_id)
    )
    return {card_id: count for card_id, count in result.all()}


async def comment_count(db: AsyncSession, card_id: int) -> int:
    result = await db.execute(select(func.count(Comment.id)).where(Comment.card_id == card_id))
    return int(result.scalar_one())


async def card_payload_with_count(db: AsyncSession, card: Card) -> Dict[str, Any]:
    return card_payload(card, await comment_count(db, card.id))


# ---------------------------------------------------------------------------
# Neighbour keys
# ---------------------------------------------------------------------------


async def last_card_key(db: AsyncSession, list_id: int) -> Optional[str]:
    """The highest key in a list, for appending."""
    result = await db.execute(
        select(Card.order_key)
        .where(Card.list_id == list_id)
        .order_by(Card.order_key.desc(), Card.id.desc())
        .limit(1)
    )
    return result.scalar_one_or_none()


async def last_list_key(db: AsyncSession, board_id: int) -> Optional[str]:
    result = await db.execute(
        select(BoardList.order_key)
        .where(BoardList.board_id == board_id)
        .order_by(BoardList.order_key.desc(), BoardList.id.desc())
        .limit(1)
    )
    return result.scalar_one_or_none()


async def key_after_card(db: AsyncSession, list_id: int, after_card_id: Optional[int]) -> str:
    """Mint the key for a new card placed directly after ``after_card_id``.

    ``None`` appends to the end of the list.
    """
    if after_card_id is None:
        return key_between(await last_card_key(db, list_id), None)

    result = await db.execute(
        select(Card.order_key).where(Card.id == after_card_id, Card.list_id == list_id)
    )
    anchor = result.scalar_one_or_none()
    if anchor is None:
        # The anchor is gone or was never in this list: appending is the
        # forgiving answer for a *create*, where there is no drag to roll back.
        return key_between(await last_card_key(db, list_id), None)

    following = await db.execute(
        select(Card.order_key)
        .where(Card.list_id == list_id, Card.order_key > anchor)
        .order_by(Card.order_key.asc(), Card.id.asc())
        .limit(1)
    )
    return key_between(anchor, following.scalar_one_or_none())


async def key_after_list(db: AsyncSession, board_id: int, after_list_id: Optional[int]) -> str:
    if after_list_id is None:
        return key_between(await last_list_key(db, board_id), None)

    result = await db.execute(
        select(BoardList.order_key).where(
            BoardList.id == after_list_id, BoardList.board_id == board_id
        )
    )
    anchor = result.scalar_one_or_none()
    if anchor is None:
        return key_between(await last_list_key(db, board_id), None)

    following = await db.execute(
        select(BoardList.order_key)
        .where(BoardList.board_id == board_id, BoardList.order_key > anchor)
        .order_by(BoardList.order_key.asc(), BoardList.id.asc())
        .limit(1)
    )
    return key_between(anchor, following.scalar_one_or_none())


def needs_rebalance(before: Optional[str], after: Optional[str]) -> bool:
    """True when no key can be minted between these two neighbours.

    Two cases: the neighbours share a key (legal, but there is nothing strictly
    between them), or the gap has been squeezed so hard that the next key would
    breach Contract 4's 64-character ceiling.
    """
    if before is None or after is None:
        return False
    if before >= after:
        return True
    try:
        return len(key_between(before, after)) > MAX_KEY_LENGTH
    except ValueError:
        return True


async def rebalance_list(db: AsyncSession, list_id: int) -> List[Dict[str, Any]]:
    """Renormalise every key in a list, preserving the order clients already see.

    This is Contract 4's escape hatch — the thing that makes invariant I2 ("the
    server can always mint a key strictly between") true without exception. It
    should almost never fire. Returns the ``[{id, order_key}]`` payload for the
    ``list.rebalanced`` broadcast.
    """
    cards = await cards_in_list(db, list_id)
    fresh = sequential_keys(len(cards))
    for card, key in zip(cards, fresh):
        card.order_key = key
        db.add(card)
    await db.flush()
    return [{"id": card.id, "order_key": card.order_key} for card in cards]


# ---------------------------------------------------------------------------
# Board snapshot (Contract 2)
# ---------------------------------------------------------------------------


async def board_members(db: AsyncSession, board_id: int) -> List[Tuple[User, str, Any]]:
    result = await db.execute(
        select(User, BoardMember.role, BoardMember.added_at)
        .join(BoardMember, BoardMember.user_id == User.id)
        .where(BoardMember.board_id == board_id)
        .order_by(BoardMember.added_at.asc(), BoardMember.id.asc())
    )
    return [(row[0], row[1], row[2]) for row in result.all()]


async def recent_activity(
    db: AsyncSession, board_id: int, limit: int = ACTIVITY_PAGE_SIZE, before_id: Optional[int] = None
) -> List[Activity]:
    """Newest first, optionally paging backwards from ``before_id``."""
    query = (
        select(Activity)
        .options(selectinload(Activity.actor))
        .where(Activity.board_id == board_id)
        .order_by(Activity.id.desc())
        .limit(limit)
    )
    if before_id is not None:
        query = query.where(Activity.id < before_id)
    result = await db.execute(query)
    return list(result.scalars().all())


async def board_snapshot(db: AsyncSession, board: Board, role: str) -> Dict[str, Any]:
    """The full board state — Contract 2's load-bearing endpoint.

    ``seq`` is the client's starting cursor and the value it compares against
    ``hello`` on socket connect. A snapshot without it is unusable, so it is
    read from the same row as everything else here.
    """
    lists = await lists_in_board(db, board.id)
    cards = await cards_in_board(db, board.id)
    counts = await comment_counts(db, [card.id for card in cards])

    cards_by_list: Dict[int, List[Dict[str, Any]]] = {board_list.id: [] for board_list in lists}
    for card in cards:
        # Already globally ordered by (order_key, id); bucketing preserves that.
        cards_by_list.setdefault(card.list_id, []).append(
            card_payload(card, counts.get(card.id, 0))
        )

    members = await board_members(db, board.id)
    activity = await recent_activity(db, board.id)

    return {
        "id": board.id,
        "title": board.title,
        "seq": board.seq,
        "role": role,
        "members": [member_payload(user, member_role, added) for user, member_role, added in members],
        "lists": [
            snapshot_list_payload(board_list, cards_by_list.get(board_list.id, []))
            for board_list in lists
        ],
        "activity": [activity_payload(entry) for entry in activity],
    }
