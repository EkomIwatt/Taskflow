"""The ticket endpoint and the WebSocket endpoint — Contract 6.

Browsers cannot set an ``Authorization`` header on a WebSocket, so the socket
authenticates with a short-lived single-use ticket fetched over ordinary
authenticated HTTP. Two things about the handshake are easy to get wrong and are
handled explicitly below:

* **Origin is checked by hand.** Browsers do not apply same-origin policy to
  WebSockets and the CORS middleware never sees this endpoint. A disallowed
  Origin is refused *before* the handshake completes, so the peer never becomes
  a WebSocket at all.
* **Membership is re-checked at connect time**, not only at ticket time. A
  ticket minted a moment before its holder was removed from the board must not
  open a socket.
"""

import asyncio
import json
import logging
import time

from fastapi import APIRouter, status
from sqlalchemy import select
from starlette.websockets import WebSocket, WebSocketDisconnect

from app.config import get_settings
from app.database import get_session_factory
from app.deps import BOARD_NOT_FOUND, ClientOpId, CurrentUser, DbSession, board_access_or_404
from app.errors import APIError
from app.models import Board, BoardMember, User
from app.realtime import (
    WS_CLOSE_BAD_TICKET,
    WS_CLOSE_BOARD_NOT_FOUND,
    WS_CLOSE_NOT_A_MEMBER,
    WS_CLOSE_POLICY_VIOLATION,
    WS_CLOSE_SERVER_ERROR,
    Connection,
    build_envelope,
    heartbeat,
    hub,
    origin_is_allowed,
    presence_envelope,
)
from app.schemas import TicketIn
from app.serializers import user_payload

logger = logging.getLogger("taskflow.ws")

router = APIRouter(tags=["realtime"])


@router.post("/api/realtime/ticket", status_code=status.HTTP_201_CREATED)
async def create_ticket(
    payload: TicketIn, user: CurrentUser, db: DbSession, client_op_id: ClientOpId
) -> dict:
    """Mint a single-use, 30-second ticket bound to (user_id, board_id).

    Consuming it does not consume the caller's session; a reconnect just fetches
    a fresh one. A non-member gets 404, like everywhere else.
    """
    if payload.board_id is None:
        raise APIError(status.HTTP_404_NOT_FOUND, BOARD_NOT_FOUND)

    await board_access_or_404(db, payload.board_id, user.id)

    settings = get_settings()
    ticket = hub.mint_ticket(user.id, payload.board_id, settings.ws_ticket_ttl_seconds)
    del client_op_id
    return {"ticket": ticket, "expires_in": settings.ws_ticket_ttl_seconds}


async def _load_membership(board_id: int, user_id: int):
    """Re-check the board and membership at connect time, on a fresh session.

    Returns ``(board_exists, is_member, user)``.
    """
    async with get_session_factory()() as db:
        board = await db.get(Board, board_id)
        if board is None:
            return False, False, None, 0
        result = await db.execute(
            select(BoardMember).where(
                BoardMember.board_id == board_id, BoardMember.user_id == user_id
            )
        )
        member = result.scalar_one_or_none()
        user = await db.get(User, user_id)
        return True, member is not None and user is not None, user, board.seq


@router.websocket("/ws/boards/{board_id}")
async def board_socket(websocket: WebSocket, board_id: int) -> None:
    settings = get_settings()

    # --- Origin (before the handshake completes) ---------------------------
    origin = websocket.headers.get("origin")
    if not origin_is_allowed(origin, settings.origin_allow_list, settings.ws_allow_missing_origin):
        logger.warning("rejecting WebSocket handshake from origin %r", origin)
        await websocket.close(code=WS_CLOSE_POLICY_VIOLATION)
        return

    # --- Ticket -------------------------------------------------------------
    # The close codes of Contract 6 §5 only reach the client if the socket was
    # accepted first; closing before accept yields an HTTP error with no code.
    ticket = websocket.query_params.get("ticket")
    user_id = hub.consume_ticket(ticket, board_id)
    await websocket.accept()
    if user_id is None:
        await websocket.close(code=WS_CLOSE_BAD_TICKET)
        return

    board_exists, is_member, user, current_seq = await _load_membership(board_id, user_id)
    if not board_exists:
        await websocket.close(code=WS_CLOSE_BOARD_NOT_FOUND)
        return
    if not is_member or user is None:
        await websocket.close(code=WS_CLOSE_NOT_A_MEMBER)
        return

    connection = Connection(websocket, user_id=user_id, board_id=board_id)
    first_for_user = hub.register(connection)
    heartbeat_task = None

    try:
        online = [
            user_payload(u)
            for u in await _load_online_users(hub.online_user_ids(board_id))
        ]
        # `hello` is the only frame the client may treat as specially. It carries
        # the board's current seq, which the client compares against its own.
        await connection.send(
            build_envelope(
                "hello",
                board_id,
                {
                    "board_id": board_id,
                    "seq": current_seq,
                    "you": user_payload(user),
                    "online": online,
                },
                seq=current_seq,
            ),
            settings.ws_send_timeout_seconds,
        )

        if first_for_user:
            # The joiner already learned about itself from `hello.online`.
            await hub.broadcast(
                board_id,
                presence_envelope("presence.joined", board_id, {"user": user_payload(user)}),
                exclude=connection,
            )

        heartbeat_task = asyncio.create_task(
            heartbeat(connection, settings.ws_ping_interval_seconds, hub)
        )

        # The socket is broadcast-only: the client sends nothing but `pong`.
        # Anything else is ignored rather than treated as an error.
        while True:
            message = await websocket.receive_text()
            try:
                parsed = json.loads(message)
            except ValueError:
                continue
            if isinstance(parsed, dict) and parsed.get("type") == "pong":
                connection.last_pong = time.monotonic()

    except WebSocketDisconnect:
        pass
    except Exception:  # pragma: no cover - defensive
        logger.exception("WebSocket error on board %s", board_id)
        await connection.close(WS_CLOSE_SERVER_ERROR)
    finally:
        # Cleanup runs on every path, including exceptions, or presence leaks
        # ghost users who never left.
        if heartbeat_task is not None:
            heartbeat_task.cancel()
        last_for_user = hub.unregister(connection)
        connection.closed = True
        if last_for_user:
            await hub.broadcast(
                board_id,
                presence_envelope("presence.left", board_id, {"user_id": user_id}),
            )


async def _load_online_users(user_ids):
    """Hydrate the presence list; a user with three tabs open appears once."""
    if not user_ids:
        return []
    async with get_session_factory()() as db:
        result = await db.execute(select(User).where(User.id.in_(list(user_ids))))
        by_id = {u.id: u for u in result.scalars().all()}
    return [by_id[uid] for uid in user_ids if uid in by_id]
