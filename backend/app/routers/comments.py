"""Comments — Contract 5."""

from typing import Optional

from fastapi import APIRouter, Response, status
from sqlalchemy import select
from sqlalchemy.orm import selectinload

from app.activity import record_activity
from app.deps import (
    COMMENT_NOT_FOUND,
    ClientOpId,
    CurrentUser,
    DbSession,
    card_access_or_404,
    comment_access_or_404,
)
from app.errors import APIError
from app.events import Event, emit
from app.models import Comment
from app.realtime import hub
from app.schemas import CommentCreateIn
from app.serializers import activity_payload, comment_payload

router = APIRouter(prefix="/api", tags=["comments"])

MAX_BODY_LENGTH = 2000
BODY_REQUIRED = "Comment cannot be empty."


@router.get("/cards/{card_id}/comments")
async def list_comments(card_id: int, user: CurrentUser, db: DbSession) -> dict:
    """Oldest first."""
    card = await card_access_or_404(db, card_id, user.id)
    result = await db.execute(
        select(Comment)
        .options(selectinload(Comment.author))
        .where(Comment.card_id == card.id)
        .order_by(Comment.created_at.asc(), Comment.id.asc())
    )
    return {"comments": [comment_payload(comment) for comment in result.scalars().all()]}


def _validate_body(body: Optional[str]) -> str:
    cleaned = (body or "").strip()
    if not cleaned:
        raise APIError(status.HTTP_422_UNPROCESSABLE_ENTITY, BODY_REQUIRED)
    if len(cleaned) > MAX_BODY_LENGTH:
        raise APIError(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            "Comment cannot be longer than {} characters.".format(MAX_BODY_LENGTH),
        )
    return cleaned


@router.post("/cards/{card_id}/comments", status_code=status.HTTP_201_CREATED)
async def create_comment(
    card_id: int,
    payload: CommentCreateIn,
    user: CurrentUser,
    db: DbSession,
    client_op_id: ClientOpId,
) -> dict:
    card = await card_access_or_404(db, card_id, user.id)
    body_text = _validate_body(payload.body)

    comment = Comment(
        card_id=card.id, board_id=card.board_id, author_id=user.id, body=body_text
    )
    db.add(comment)
    await db.flush()
    comment.author = user

    body = comment_payload(comment)

    async with hub.board_lock(card.board_id):
        entry = await record_activity(
            db,
            card.board_id,
            user,
            "comment.added",
            {"card_id": card.id, "card_title": card.title, "comment_id": comment.id},
        )
        await emit(
            db,
            hub,
            card.board_id,
            [
                Event("comment.created", body),
                Event("activity.appended", activity_payload(entry)),
            ],
            actor_id=user.id,
            client_op_id=client_op_id,
        )

    return body


@router.delete("/comments/{comment_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_comment(comment_id: int, user: CurrentUser, db: DbSession) -> Response:
    """Author only. Someone else's comment gets the same 404 as a missing one.

    Contract 6 enumerates no `comment.deleted` event and Contract 5 no matching
    verb, so this is the one mutation that broadcasts nothing and writes no
    activity entry. Other clients' `comment_count` therefore goes stale until
    their next snapshot — noted in backend/README.md.
    """
    comment = await comment_access_or_404(db, comment_id, user.id)
    if comment.author_id != user.id:
        raise APIError(status.HTTP_404_NOT_FOUND, COMMENT_NOT_FOUND)

    await db.delete(comment)
    await db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)
