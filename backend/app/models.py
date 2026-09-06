"""SQLAlchemy models.

Authorization in this project is *membership*, one level up from LedgerLite's
``user_id = current_user.id`` scoping. Two shapes below exist purely to serve
that: ``board_members`` with its UNIQUE (board_id, user_id), and the
denormalised ``cards.board_id``, which lets a card be authorized and broadcast
without joining back through its list.
"""

from datetime import datetime, timezone
from typing import List, Optional

from sqlalchemy import (
    BigInteger,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    JSON,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


class User(Base):
    __tablename__ = "users"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    email: Mapped[str] = mapped_column(String(320), unique=True, nullable=False, index=True)
    password_hash: Mapped[str] = mapped_column(String(255), nullable=False)
    #: Nullable in storage; the wire always carries a value, falling back to the
    #: email local-part (see serializers.user_payload).
    display_name: Mapped[Optional[str]] = mapped_column(String(80), nullable=True)
    #: Bumped on logout, which invalidates every outstanding refresh token.
    token_version: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=utcnow
    )


class Board(Base):
    __tablename__ = "boards"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    owner_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    title: Mapped[str] = mapped_column(String(80), nullable=False)
    #: Contract 6: per-board monotonic event counter, assigned at broadcast.
    #: Incremented inside the same transaction as the mutation it describes.
    seq: Mapped[int] = mapped_column(BigInteger, nullable=False, default=0, server_default="0")
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=utcnow
    )
    #: Drives the "newest activity first" ordering of GET /api/boards, so it is
    #: touched by every mutation anywhere in the board, not just by a rename.
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=utcnow, onupdate=utcnow
    )

    members: Mapped[List["BoardMember"]] = relationship(
        back_populates="board", cascade="all, delete-orphan"
    )
    lists: Mapped[List["BoardList"]] = relationship(
        back_populates="board", cascade="all, delete-orphan"
    )


class BoardMember(Base):
    __tablename__ = "board_members"
    __table_args__ = (UniqueConstraint("board_id", "user_id", name="uq_board_members_board_user"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    board_id: Mapped[int] = mapped_column(
        ForeignKey("boards.id", ondelete="CASCADE"), nullable=False, index=True
    )
    user_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    #: "owner" or "member". The owner has a row here too.
    role: Mapped[str] = mapped_column(String(16), nullable=False, default="member")
    added_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=utcnow
    )

    board: Mapped["Board"] = relationship(back_populates="members")
    user: Mapped["User"] = relationship()


class BoardList(Base):
    """A kanban column. Named BoardList because `list` is a Python builtin."""

    __tablename__ = "lists"
    __table_args__ = (Index("ix_lists_board_order", "board_id", "order_key"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    board_id: Mapped[int] = mapped_column(
        ForeignKey("boards.id", ondelete="CASCADE"), nullable=False, index=True
    )
    title: Mapped[str] = mapped_column(String(80), nullable=False)
    order_key: Mapped[str] = mapped_column(String(64), nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=utcnow
    )

    board: Mapped["Board"] = relationship(back_populates="lists")
    cards: Mapped[List["Card"]] = relationship(
        back_populates="list", cascade="all, delete-orphan"
    )


class Card(Base):
    __tablename__ = "cards"
    __table_args__ = (Index("ix_cards_list_order", "list_id", "order_key"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    list_id: Mapped[int] = mapped_column(
        ForeignKey("lists.id", ondelete="CASCADE"), nullable=False, index=True
    )
    #: Denormalised so authorization and broadcast never need a join to the list.
    board_id: Mapped[int] = mapped_column(
        ForeignKey("boards.id", ondelete="CASCADE"), nullable=False, index=True
    )
    title: Mapped[str] = mapped_column(String(255), nullable=False)
    description: Mapped[str] = mapped_column(Text, nullable=False, default="")
    order_key: Mapped[str] = mapped_column(String(64), nullable=False)
    created_by: Mapped[Optional[int]] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=utcnow
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=utcnow, onupdate=utcnow
    )

    list: Mapped["BoardList"] = relationship(back_populates="cards")
    creator: Mapped[Optional["User"]] = relationship()


class Comment(Base):
    __tablename__ = "comments"
    __table_args__ = (Index("ix_comments_card_id", "card_id", "id"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    #: Not index=True: the composite (card_id, id) index above already covers it.
    card_id: Mapped[int] = mapped_column(
        ForeignKey("cards.id", ondelete="CASCADE"), nullable=False
    )
    board_id: Mapped[int] = mapped_column(
        ForeignKey("boards.id", ondelete="CASCADE"), nullable=False, index=True
    )
    author_id: Mapped[Optional[int]] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    body: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=utcnow
    )

    author: Mapped[Optional["User"]] = relationship()


class Activity(Base):
    __tablename__ = "activity"
    __table_args__ = (Index("ix_activity_board_id_desc", "board_id", "id"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    board_id: Mapped[int] = mapped_column(
        ForeignKey("boards.id", ondelete="CASCADE"), nullable=False, index=True
    )
    #: SET NULL rather than CASCADE: deleting an account must not rewrite history.
    actor_id: Mapped[Optional[int]] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    verb: Mapped[str] = mapped_column(String(32), nullable=False)
    #: Rendered on the server on purpose (Contract 5) — the client prints it.
    summary: Mapped[str] = mapped_column(Text, nullable=False)
    #: For linking the card and bolding a name, not for composing prose.
    subject: Mapped[dict] = mapped_column(JSON, nullable=False, default=dict)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=utcnow
    )

    actor: Mapped[Optional["User"]] = relationship()
