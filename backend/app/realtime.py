"""The in-process WebSocket broadcast hub — Contract 6.

The hub is a registry of ``board_id -> set[Connection]`` living inside the
FastAPI process. It is deliberately **single-process**: a Redis fan-out is out
of scope, which means Render must run this service with **one uvicorn worker**.
That constraint is ASSUMED and documented in ``backend/README.md``.

Three rules here are the ones that break subtly if they are got wrong:

* **A slow or dead client must never block a broadcast.** Every send is bounded
  by a timeout and the fan-out runs concurrently; a connection that fails or
  times out is dropped and the rest of the board carries on.
* **Presence is derived from live connections only.** A user with three tabs
  open appears once, and ``presence.left`` fires when their *last* connection
  for that board closes. Cleanup happens in a ``finally`` so an exception path
  cannot leak a ghost user.
* **`seq` is per-board and monotonic.** :meth:`Hub.board_lock` serialises a
  board's mutations end to end — allocate, commit, broadcast — so events reach
  clients in the same order their `seq` values were assigned.
"""

import asyncio
import logging
import secrets
import time
from dataclasses import dataclass, field
from typing import Any, Dict, Iterable, List, Optional, Set

from starlette.websockets import WebSocket, WebSocketState

from app.serializers import now_iso

logger = logging.getLogger("taskflow.realtime")

# --- Close codes (Contract 6 §5) -------------------------------------------
WS_CLOSE_NORMAL = 1000
WS_CLOSE_SERVER_ERROR = 1011
WS_CLOSE_BAD_TICKET = 4001
WS_CLOSE_NOT_A_MEMBER = 4003
WS_CLOSE_BOARD_NOT_FOUND = 4004
#: Origin rejection has no contract code: it is refused before the handshake
#: completes, so the peer never becomes a WebSocket at all.
WS_CLOSE_POLICY_VIOLATION = 1008

#: Ephemeral event types (Contract 6 §4). These carry `"seq": null` and must not
#: advance the client's cursor.
EPHEMERAL_TYPES = frozenset({"presence.joined", "presence.left", "ping"})


@dataclass
class Ticket:
    """A single-use, 30-second credential bound to (user_id, board_id)."""

    user_id: int
    board_id: int
    expires_at: float


class Connection:
    """One live socket, plus the bookkeeping the hub needs about it."""

    __slots__ = ("websocket", "user_id", "board_id", "last_pong", "_send_lock", "closed")

    def __init__(self, websocket: WebSocket, user_id: int, board_id: int) -> None:
        self.websocket = websocket
        self.user_id = user_id
        self.board_id = board_id
        self.last_pong = time.monotonic()
        # The heartbeat task and a broadcast can both reach a socket at once;
        # Starlette does not allow overlapping sends on one connection.
        self._send_lock = asyncio.Lock()
        self.closed = False

    async def send(self, envelope: Dict[str, Any], timeout: float) -> None:
        """Send one frame, bounded by ``timeout``. Raises on failure."""
        async with self._send_lock:
            if self.closed or self.websocket.client_state != WebSocketState.CONNECTED:
                raise RuntimeError("connection is not open")
            await asyncio.wait_for(self.websocket.send_json(envelope), timeout=timeout)

    async def close(self, code: int) -> None:
        self.closed = True
        try:
            if self.websocket.client_state == WebSocketState.CONNECTED:
                await self.websocket.close(code=code)
        except Exception:  # pragma: no cover - the peer is already gone
            logger.debug("close(%s) failed on a socket that was already down", code)


def build_envelope(
    event_type: str,
    board_id: int,
    payload: Dict[str, Any],
    seq: Optional[int] = None,
    actor_id: Optional[int] = None,
    client_op_id: Optional[str] = None,
    ts: Optional[str] = None,
) -> Dict[str, Any]:
    """The server -> client frame of Contract 6 §2.

    Every field is always present. `seq` is ``None`` for ephemeral events, and
    `ts` is informational only — `seq` orders events, never `ts`.
    """
    return {
        "type": event_type,
        "board_id": board_id,
        "seq": seq,
        "actor_id": actor_id,
        "client_op_id": client_op_id,
        "ts": ts or now_iso(),
        "payload": payload,
    }


@dataclass
class Hub:
    """Per-board connection registry, ticket store and broadcast fan-out."""

    send_timeout: float = 5.0
    _connections: Dict[int, Set[Connection]] = field(default_factory=dict)
    _tickets: Dict[str, Ticket] = field(default_factory=dict)
    _board_locks: Dict[int, asyncio.Lock] = field(default_factory=dict)

    # -- Mutation serialisation ---------------------------------------------

    def board_lock(self, board_id: int) -> asyncio.Lock:
        """The per-board mutation lock.

        Held across allocate-seq, commit and broadcast, so two concurrent
        mutations on one board can never be assigned the same `seq` nor be
        delivered out of `seq` order. Boards are independent, so this costs
        nothing across boards.
        """
        lock = self._board_locks.get(board_id)
        if lock is None:
            lock = asyncio.Lock()
            self._board_locks[board_id] = lock
        return lock

    # -- Tickets (Contract 6 §1) --------------------------------------------

    def mint_ticket(self, user_id: int, board_id: int, ttl_seconds: int) -> str:
        self._purge_expired_tickets()
        ticket = secrets.token_urlsafe(32)
        self._tickets[ticket] = Ticket(
            user_id=user_id, board_id=board_id, expires_at=time.monotonic() + ttl_seconds
        )
        return ticket

    def consume_ticket(self, ticket: Optional[str], board_id: int) -> Optional[int]:
        """Redeem a ticket for its user id, or ``None`` if it is not usable.

        Single-use: the entry is removed whether or not it turns out to match,
        so a replay of the same string can never succeed.
        """
        self._purge_expired_tickets()
        if not ticket:
            return None
        entry = self._tickets.pop(ticket, None)
        if entry is None:
            return None
        if entry.expires_at < time.monotonic():
            return None
        if entry.board_id != board_id:
            return None
        return entry.user_id

    def _purge_expired_tickets(self) -> None:
        now = time.monotonic()
        expired = [key for key, value in self._tickets.items() if value.expires_at < now]
        for key in expired:
            del self._tickets[key]

    # -- Registry ------------------------------------------------------------

    def register(self, connection: Connection) -> bool:
        """Add a connection. Returns True if this is the user's first for the board."""
        peers = self._connections.setdefault(connection.board_id, set())
        first = not any(c.user_id == connection.user_id for c in peers)
        peers.add(connection)
        return first

    def unregister(self, connection: Connection) -> bool:
        """Remove a connection. Returns True if it was the user's last for the board."""
        peers = self._connections.get(connection.board_id)
        if not peers:
            return False
        peers.discard(connection)
        last = not any(c.user_id == connection.user_id for c in peers)
        if not peers:
            self._connections.pop(connection.board_id, None)
        return last

    def connections(self, board_id: int) -> List[Connection]:
        return list(self._connections.get(board_id, ()))

    def online_user_ids(self, board_id: int) -> List[int]:
        """Distinct user ids with at least one live connection to the board."""
        seen: List[int] = []
        for connection in self._connections.get(board_id, ()):
            if connection.user_id not in seen:
                seen.append(connection.user_id)
        return seen

    def connection_count(self, board_id: int) -> int:
        return len(self._connections.get(board_id, ()))

    # -- Fan-out -------------------------------------------------------------

    async def broadcast(
        self,
        board_id: int,
        envelope: Dict[str, Any],
        exclude: Optional[Connection] = None,
    ) -> int:
        """Send one envelope to every connection on the board.

        Contract 7 §1: the originating client is **not** skipped — it receives
        its own broadcast like everyone else, which is what makes the echo the
        single settling signal.

        Sends run concurrently and each is bounded by ``send_timeout``; a
        connection that fails or times out is closed and dropped, and the rest
        of the fan-out is unaffected. Returns the number of successful sends.
        """
        targets = [c for c in self.connections(board_id) if c is not exclude and not c.closed]
        if not targets:
            return 0

        results = await asyncio.gather(
            *(c.send(envelope, self.send_timeout) for c in targets), return_exceptions=True
        )

        delivered = 0
        for connection, result in zip(targets, results):
            if isinstance(result, BaseException):
                logger.warning(
                    "dropping connection for user %s on board %s: %r",
                    connection.user_id,
                    board_id,
                    result,
                )
                self.unregister(connection)
                await connection.close(WS_CLOSE_SERVER_ERROR)
            else:
                delivered += 1
        return delivered

    async def close_user_connections(self, board_id: int, user_id: int, code: int) -> None:
        """Close every connection a user holds on a board (e.g. they were removed)."""
        for connection in self.connections(board_id):
            if connection.user_id == user_id:
                self.unregister(connection)
                await connection.close(code)

    async def close_board_connections(self, board_id: int, code: int) -> None:
        """Close every connection on a board (e.g. the board was deleted)."""
        for connection in self.connections(board_id):
            self.unregister(connection)
            await connection.close(code)

    # -- Test / lifecycle support -------------------------------------------

    def reset(self) -> None:
        self._connections.clear()
        self._tickets.clear()
        self._board_locks.clear()


#: The process-wide hub. Single-process by design (see the module docstring).
hub = Hub()


def presence_envelope(event_type: str, board_id: int, payload: Dict[str, Any]) -> Dict[str, Any]:
    """An ephemeral envelope: `seq` is null and it never advances the cursor."""
    return build_envelope(event_type, board_id, payload, seq=None, actor_id=None)


async def heartbeat(connection: Connection, interval: float, hub_ref: Hub) -> None:
    """Send `ping` every ``interval`` seconds and reap silent peers.

    Contract 6 §6.1 has the server ping every 25 s and the client reply `pong`
    immediately. A peer that has not ponged for three intervals is treated as
    gone: this is what stops a slept laptop's half-open TCP connection from
    leaving a ghost in the presence row.
    """
    grace = interval * 3
    try:
        while True:
            await asyncio.sleep(interval)
            if connection.closed:
                return
            if time.monotonic() - connection.last_pong > grace:
                logger.info(
                    "no pong from user %s on board %s within %.0fs; closing",
                    connection.user_id,
                    connection.board_id,
                    grace,
                )
                hub_ref.unregister(connection)
                await connection.close(WS_CLOSE_SERVER_ERROR)
                return
            try:
                await connection.send(
                    presence_envelope("ping", connection.board_id, {}), hub_ref.send_timeout
                )
            except Exception:
                hub_ref.unregister(connection)
                await connection.close(WS_CLOSE_SERVER_ERROR)
                return
    except asyncio.CancelledError:  # pragma: no cover - normal shutdown path
        raise


def origin_is_allowed(origin: Optional[str], allow_list: Iterable[str], allow_missing: bool) -> bool:
    """Check a WebSocket handshake's Origin against the CORS allow-list.

    Browsers do not apply same-origin policy to WebSockets and the CORS
    middleware never sees this endpoint, so this check has to be explicit. An
    absent Origin means a non-browser client (websocat, the test suite), which
    cannot be driven cross-site by a third party; ``allow_missing`` controls
    whether that is tolerated.
    """
    if origin is None or origin == "":
        return allow_missing
    return origin.rstrip("/") in list(allow_list)
