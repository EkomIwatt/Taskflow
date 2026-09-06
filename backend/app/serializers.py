"""Wire shapes.

Every JSON object either side of the contract exchanges is built here, in one
place, so the HTTP response body and the WebSocket payload for the same entity
are byte-identical by construction rather than by discipline. Instance 2 built
its whole UI against a mock of these shapes without seeing this code, so a
field name that drifts here is a merge failure.
"""

from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from app.models import Activity, Board, BoardList, Card, Comment, User

#: Deterministic per-user colour (Contract conventions: "display identity is
#: server-computed"). Tailwind 500-weights, chosen for contrast on both themes.
AVATAR_COLORS = [
    "#3B82F6",  # blue
    "#EF4444",  # red
    "#10B981",  # emerald
    "#F59E0B",  # amber
    "#8B5CF6",  # violet
    "#EC4899",  # pink
    "#14B8A6",  # teal
    "#F97316",  # orange
    "#6366F1",  # indigo
    "#84CC16",  # lime
    "#06B6D4",  # cyan
    "#A855F7",  # purple
]


def iso(value: Optional[datetime]) -> Optional[str]:
    """ISO-8601 UTC with a trailing Z, to the second.

    SQLite drops tzinfo on the way back out, so a naive value is read as the UTC
    it was written as.
    """
    if value is None:
        return None
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def now_iso() -> str:
    return iso(datetime.now(timezone.utc))


def avatar_color(user_id: int) -> str:
    """Deterministic from the user id, so the same person is the same colour in
    presence, in comments and in the activity feed."""
    return AVATAR_COLORS[user_id % len(AVATAR_COLORS)]


def display_name_for(user: User) -> str:
    """Never null on the wire; falls back to the email local-part.

    Marked ASSUMED in CLAUDE.md — low stakes, display-only.
    """
    if user.display_name and user.display_name.strip():
        return user.display_name.strip()
    return user.email.split("@", 1)[0]


def user_payload(user: User) -> Dict[str, Any]:
    """<User> — Contract 1."""
    return {
        "id": user.id,
        "email": user.email,
        "display_name": display_name_for(user),
        "avatar_color": avatar_color(user.id),
        "created_at": iso(user.created_at),
    }


def card_payload(card: Card, comment_count: int = 0) -> Dict[str, Any]:
    """<Card> — Contract 3."""
    return {
        "id": card.id,
        "list_id": card.list_id,
        "board_id": card.board_id,
        "title": card.title,
        "description": card.description or "",
        "order_key": card.order_key,
        "comment_count": comment_count,
        "created_by": user_payload(card.creator) if card.creator is not None else None,
        "created_at": iso(card.created_at),
        "updated_at": iso(card.updated_at),
    }


def list_payload(board_list: BoardList, cards: Optional[List[Dict[str, Any]]] = None) -> Dict[str, Any]:
    """A list as returned by POST /lists and broadcast as `list.created`.

    Carries board_id; the snapshot's nested form (below) deliberately does not,
    because Contract 2 spells that shape out without it.
    """
    return {
        "id": board_list.id,
        "board_id": board_list.board_id,
        "title": board_list.title,
        "order_key": board_list.order_key,
        "cards": cards if cards is not None else [],
    }


def snapshot_list_payload(board_list: BoardList, cards: List[Dict[str, Any]]) -> Dict[str, Any]:
    """A list as nested inside the board snapshot — Contract 2."""
    return {
        "id": board_list.id,
        "title": board_list.title,
        "order_key": board_list.order_key,
        "cards": cards,
    }


def comment_payload(comment: Comment) -> Dict[str, Any]:
    """<Comment> — Contract 5."""
    return {
        "id": comment.id,
        "card_id": comment.card_id,
        "board_id": comment.board_id,
        "author": user_payload(comment.author) if comment.author is not None else None,
        "body": comment.body,
        "created_at": iso(comment.created_at),
    }


def activity_payload(activity: Activity) -> Dict[str, Any]:
    """<Activity> — Contract 5. `summary` is rendered here, never on the client."""
    return {
        "id": activity.id,
        "board_id": activity.board_id,
        "actor": user_payload(activity.actor) if activity.actor is not None else None,
        "verb": activity.verb,
        "summary": activity.summary,
        "subject": activity.subject or {},
        "created_at": iso(activity.created_at),
    }


def member_payload(user: User, role: str, added_at: Optional[datetime]) -> Dict[str, Any]:
    return {"user": user_payload(user), "role": role, "added_at": iso(added_at)}


def board_summary_payload(
    board: Board, role: str, member_count: int, card_count: int
) -> Dict[str, Any]:
    """<BoardSummary> — Contract 2's GET /api/boards row."""
    return {
        "id": board.id,
        "title": board.title,
        "role": role,
        "member_count": member_count,
        "card_count": card_count,
        "updated_at": iso(board.updated_at),
    }
