"""Activity entries and their server-rendered sentences — Contract 5.

``summary`` is rendered here, on the server, on purpose. The frontend prints the
sentence and must not reconstruct one from ``verb`` + ``subject``; ``subject``
exists so the UI can link the card and bold a name, not so it can compose prose.
The pay-off is that a new verb ships without a frontend change.
"""

from typing import Any, Dict, Optional

from sqlalchemy.ext.asyncio import AsyncSession

from app.models import Activity, User
from app.serializers import display_name_for

#: The complete verb enumeration from Contract 5. Anything not in here is a bug.
VERBS = frozenset(
    {
        "board.created",
        "board.renamed",
        "member.added",
        "member.removed",
        "list.created",
        "list.renamed",
        "list.deleted",
        "card.created",
        "card.moved",
        "card.renamed",
        "card.described",
        "card.deleted",
        "comment.added",
    }
)


def render_summary(verb: str, actor: Optional[User], subject: Dict[str, Any]) -> str:
    """Build the one sentence the activity feed prints verbatim."""
    who = display_name_for(actor) if actor is not None else "Someone"

    if verb == "board.created":
        return "{} created {}".format(who, subject.get("board_title", "the board"))
    if verb == "board.renamed":
        return "{} renamed the board to {}".format(who, subject.get("to_title", ""))
    if verb == "member.added":
        return "{} added {} to the board".format(who, subject.get("display_name", "someone"))
    if verb == "member.removed":
        return "{} removed {} from the board".format(who, subject.get("display_name", "someone"))

    if verb == "list.created":
        return "{} added list {}".format(who, subject.get("list_title", ""))
    if verb == "list.renamed":
        return "{} renamed list {} to {}".format(
            who, subject.get("from_title", ""), subject.get("list_title", "")
        )
    if verb == "list.deleted":
        return "{} deleted list {}".format(who, subject.get("list_title", ""))

    if verb == "card.created":
        return "{} added {} to {}".format(
            who, subject.get("card_title", ""), subject.get("to_list", "")
        )
    if verb == "card.moved":
        from_list = subject.get("from_list")
        to_list = subject.get("to_list")
        if from_list == to_list:
            # A move within one list still writes card.moved, with
            # from_list == to_list (Contract 5).
            return "{} reordered {} in {}".format(who, subject.get("card_title", ""), to_list or "")
        return "{} moved {} from {} to {}".format(
            who, subject.get("card_title", ""), from_list or "", to_list or ""
        )
    if verb == "card.renamed":
        return "{} renamed {} to {}".format(
            who, subject.get("from_title", ""), subject.get("card_title", "")
        )
    if verb == "card.described":
        return "{} updated the description of {}".format(who, subject.get("card_title", ""))
    if verb == "card.deleted":
        return "{} deleted {}".format(who, subject.get("card_title", ""))

    if verb == "comment.added":
        return "{} commented on {}".format(who, subject.get("card_title", ""))

    raise ValueError("Unknown activity verb: {!r}".format(verb))


async def record_activity(
    db: AsyncSession,
    board_id: int,
    actor: Optional[User],
    verb: str,
    subject: Dict[str, Any],
) -> Activity:
    """Write one activity row and flush it, so its id is available to serialize.

    The row is *not* committed here — the caller commits it in the same
    transaction as the mutation it describes, and only then broadcasts.
    """
    if verb not in VERBS:
        raise ValueError("Unknown activity verb: {!r}".format(verb))
    entry = Activity(
        board_id=board_id,
        actor_id=actor.id if actor is not None else None,
        verb=verb,
        summary=render_summary(verb, actor, subject),
        subject=subject,
    )
    db.add(entry)
    await db.flush()
    # The relationship is what activity_payload serializes; set it directly
    # rather than paying for a refresh round-trip.
    entry.actor = actor
    return entry
