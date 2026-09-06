"""Request bodies.

These models are deliberately *permissive*: fields are optional with defaults so
that a missing field reaches the route rather than tripping FastAPI's own
validation. The routes then raise the exact sentence Contracts 1-5 specify
("Card title is required.", "Comment cannot be empty."), which a generic
validation handler could not produce.

Response bodies are not modelled here — they are built by ``serializers.py``, in
one place, so that an HTTP body and the matching WebSocket payload cannot drift.
"""

from typing import Optional

from pydantic import BaseModel, ConfigDict


class _In(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True, extra="ignore")


# --- Contract 1: auth -------------------------------------------------------


class SignupIn(_In):
    email: Optional[str] = None
    password: Optional[str] = None
    display_name: Optional[str] = None


class LoginIn(_In):
    email: Optional[str] = None
    password: Optional[str] = None


# --- Contract 2: boards & membership ---------------------------------------


class BoardCreateIn(_In):
    title: Optional[str] = None


class BoardUpdateIn(_In):
    title: Optional[str] = None


class MemberAddIn(_In):
    email: Optional[str] = None


# --- Contract 3: lists & cards ---------------------------------------------


class ListCreateIn(_In):
    title: Optional[str] = None
    #: null = append to the end.
    after_list_id: Optional[int] = None


class ListUpdateIn(_In):
    title: Optional[str] = None


class ListMoveIn(_In):
    #: The list to the LEFT of the drop point; null = far left.
    before_list_id: Optional[int] = None
    #: The list to the RIGHT of the drop point; null = far right.
    after_list_id: Optional[int] = None


class CardCreateIn(_In):
    title: Optional[str] = None
    #: null = append to the end.
    after_card_id: Optional[int] = None


class CardUpdateIn(_In):
    """Partial: an absent key means unchanged.

    Use ``model_fields_set`` to tell "absent" from "explicitly set to empty" —
    clearing a description is a real edit, not a no-op.
    """

    title: Optional[str] = None
    description: Optional[str] = None


class CardMoveIn(_In):
    #: Destination list; may equal the card's current list.
    list_id: Optional[int] = None
    #: The card ABOVE the drop point; null = top of the list.
    before_card_id: Optional[int] = None
    #: The card BELOW the drop point; null = bottom of the list.
    after_card_id: Optional[int] = None


# --- Contract 5: comments ---------------------------------------------------


class CommentCreateIn(_In):
    body: Optional[str] = None


# --- Contract 6: realtime ---------------------------------------------------


class TicketIn(_In):
    board_id: Optional[int] = None
