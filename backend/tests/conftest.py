"""Test fixtures.

Two decisions here are worth explaining, because they are what make the realtime
tests meaningful rather than decorative:

* **One event loop, one database, one hub.** The hub is in-process state, so a
  test that drives a socket and a mutation has to run both in the same loop. The
  suite therefore uses a single in-memory SQLite database pinned to one
  connection (``StaticPool``) and rebinds ``app.database.SessionLocal``, which
  is what the WebSocket endpoint reads at call time.
* **A hand-rolled ASGI WebSocket client.** Starlette's ``TestClient`` drives the
  app from a worker thread with its own loop, which would put the hub and the
  fixtures on opposite sides of a loop boundary. :class:`WebSocketSession` speaks
  the ASGI websocket protocol directly, in this loop, and gives the tests what
  the contract cares about: the frames, in order, and the close code.
"""

import asyncio
import json
from typing import Any, Dict, List, Optional
from urllib.parse import urlencode

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.pool import StaticPool

from app import database
from app.config import get_settings, reset_settings_cache
from app.database import Base, get_db
from app.main import create_app
from app.realtime import hub

TEST_ORIGIN = "http://localhost:5173"


@pytest.fixture(scope="session", autouse=True)
def _test_environment():
    """Pin settings the whole suite depends on, before the app is built."""
    import os

    os.environ["TASKFLOW_TESTING"] = "1"
    os.environ["JWT_SECRET"] = "test-secret-not-for-production"
    os.environ["ALLOWED_ORIGINS"] = TEST_ORIGIN + ",https://taskflow.example"
    os.environ["COOKIE_SECURE"] = "false"
    os.environ["DATABASE_URL"] = "sqlite+aiosqlite:///:memory:"
    reset_settings_cache()
    yield
    reset_settings_cache()


@pytest_asyncio.fixture
async def engine():
    """One in-memory database per test, pinned to a single shared connection."""
    test_engine = create_async_engine(
        "sqlite+aiosqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    async with test_engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    yield test_engine
    await test_engine.dispose()


@pytest_asyncio.fixture
async def session_factory(engine, monkeypatch):
    factory = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    # The WebSocket endpoint has no Depends to hang off and reads this name at
    # call time, so rebinding it points the whole app at the test database.
    monkeypatch.setattr(database, "SessionLocal", factory)
    return factory


@pytest_asyncio.fixture
async def app(session_factory):
    application = create_app()

    async def override_get_db():
        async with session_factory() as session:
            try:
                yield session
            except Exception:
                await session.rollback()
                raise

    application.dependency_overrides[get_db] = override_get_db
    hub.reset()
    hub.send_timeout = get_settings().ws_send_timeout_seconds
    yield application
    hub.reset()
    application.dependency_overrides.clear()


@pytest_asyncio.fixture
async def client(app):
    transport = ASGITransport(app=app)
    async with AsyncClient(
        transport=transport, base_url="http://testserver", headers={"Origin": TEST_ORIGIN}
    ) as async_client:
        yield async_client


@pytest_asyncio.fixture
async def db(session_factory):
    """A session for tests that need to inspect state directly."""
    async with session_factory() as session:
        yield session


# ---------------------------------------------------------------------------
# Account and board helpers
# ---------------------------------------------------------------------------


class Actor:
    """A signed-up user plus the headers needed to act as them."""

    def __init__(self, client: AsyncClient, email: str, token: str, user: Dict[str, Any]) -> None:
        self._client = client
        self.email = email
        self.token = token
        self.user = user
        self.id = user["id"]

    def headers(self, client_op_id: Optional[str] = None) -> Dict[str, str]:
        headers = {"Authorization": "Bearer " + self.token}
        if client_op_id is not None:
            headers["X-Client-Op-Id"] = client_op_id
        return headers

    async def get(self, url: str, **kwargs):
        return await self._client.get(url, headers=self.headers(), **kwargs)

    async def post(self, url: str, json_body=None, client_op_id: Optional[str] = None, **kwargs):
        return await self._client.post(
            url, json=json_body, headers=self.headers(client_op_id), **kwargs
        )

    async def patch(self, url: str, json_body=None, client_op_id: Optional[str] = None, **kwargs):
        return await self._client.patch(
            url, json=json_body, headers=self.headers(client_op_id), **kwargs
        )

    async def delete(self, url: str, client_op_id: Optional[str] = None, **kwargs):
        return await self._client.delete(url, headers=self.headers(client_op_id), **kwargs)


@pytest_asyncio.fixture
def make_actor(client):
    counter = {"n": 0}

    async def _make(email: Optional[str] = None, display_name: Optional[str] = None) -> Actor:
        counter["n"] += 1
        address = email or "user{}@example.com".format(counter["n"])
        response = await client.post(
            "/api/auth/signup",
            json={
                "email": address,
                "password": "correct-horse-battery",
                "display_name": display_name,
            },
        )
        assert response.status_code == 201, response.text
        body = response.json()
        return Actor(client, address, body["access_token"], body["user"])

    return _make


@pytest_asyncio.fixture
async def alice(make_actor) -> Actor:
    return await make_actor("alice@example.com", "Alice")


@pytest_asyncio.fixture
async def bob(make_actor) -> Actor:
    return await make_actor("bob@example.com", "Bob")


@pytest_asyncio.fixture
async def mallory(make_actor) -> Actor:
    """A signed-in user who is a member of nothing."""
    return await make_actor("mallory@example.com", "Mallory")


@pytest_asyncio.fixture
async def board(alice) -> Dict[str, Any]:
    response = await alice.post("/api/boards", {"title": "Launch"})
    assert response.status_code == 201, response.text
    return response.json()


@pytest_asyncio.fixture
async def shared_board(alice, bob, board) -> Dict[str, Any]:
    """A board Alice owns and Bob is a member of."""
    response = await alice.post(
        "/api/boards/{}/members".format(board["id"]), {"email": bob.email}
    )
    assert response.status_code == 201, response.text
    return board


# ---------------------------------------------------------------------------
# In-process ASGI WebSocket client
# ---------------------------------------------------------------------------


class WebSocketClosed(Exception):
    def __init__(self, code: int) -> None:
        super().__init__("websocket closed with code {}".format(code))
        self.code = code


class WebSocketSession:
    """Drives the ASGI websocket protocol against the app in this event loop."""

    def __init__(self, app, path: str, params: Optional[dict] = None, origin: Optional[str] = None):
        self._app = app
        self._path = path
        self._query = urlencode(params or {}).encode()
        self._origin = origin
        self._to_app: "asyncio.Queue[dict]" = asyncio.Queue()
        self._from_app: "asyncio.Queue[dict]" = asyncio.Queue()
        self._task: Optional[asyncio.Task] = None
        self.accepted = False
        self.close_code: Optional[int] = None

    async def __aenter__(self) -> "WebSocketSession":
        headers: List[tuple] = [(b"host", b"testserver")]
        if self._origin is not None:
            headers.append((b"origin", self._origin.encode()))

        scope = {
            "type": "websocket",
            "asgi": {"version": "3.0", "spec_version": "2.3"},
            "http_version": "1.1",
            "scheme": "ws",
            "server": ("testserver", 80),
            "client": ("testclient", 50000),
            "root_path": "",
            "path": self._path,
            "raw_path": self._path.encode(),
            "query_string": self._query,
            "headers": headers,
            "subprotocols": [],
            "state": {},
        }
        self._task = asyncio.create_task(
            self._app(scope, self._to_app.get, self._from_app.put)
        )
        await self._to_app.put({"type": "websocket.connect"})

        message = await self._next_message()
        if message["type"] == "websocket.accept":
            self.accepted = True
        elif message["type"] == "websocket.close":
            self.close_code = message.get("code", 1000)
        return self

    async def __aexit__(self, exc_type, exc, tb) -> None:
        await self.disconnect()

    async def _next_message(self, timeout: float = 2.0) -> dict:
        getter = asyncio.ensure_future(self._from_app.get())
        assert self._task is not None
        done, _ = await asyncio.wait(
            {getter, self._task}, timeout=timeout, return_when=asyncio.FIRST_COMPLETED
        )
        if getter in done:
            return getter.result()
        getter.cancel()
        if self._task in done:
            # Surface an app-side exception rather than reporting a timeout.
            self._task.result()
            raise WebSocketClosed(self.close_code or 1006)
        raise asyncio.TimeoutError("no websocket message within {}s".format(timeout))

    async def receive_json(self, timeout: float = 2.0) -> Dict[str, Any]:
        """Next application frame, or :class:`WebSocketClosed` if it closed."""
        message = await self._next_message(timeout)
        if message["type"] == "websocket.close":
            self.close_code = message.get("code", 1000)
            raise WebSocketClosed(self.close_code)
        if message["type"] != "websocket.send":
            raise AssertionError("unexpected ASGI message: {!r}".format(message))
        return json.loads(message["text"])

    async def receive_until(self, event_type: str, timeout: float = 2.0) -> Dict[str, Any]:
        """Skip frames until one of ``event_type`` arrives (e.g. past a `ping`)."""
        deadline = asyncio.get_event_loop().time() + timeout
        while True:
            remaining = deadline - asyncio.get_event_loop().time()
            if remaining <= 0:
                raise asyncio.TimeoutError("no {} frame in time".format(event_type))
            frame = await self.receive_json(timeout=remaining)
            if frame["type"] == event_type:
                return frame

    async def drain(self, timeout: float = 0.05) -> List[Dict[str, Any]]:
        """Every frame currently pending. Used to assert exact event counts."""
        frames = []
        while True:
            try:
                frames.append(await self.receive_json(timeout=timeout))
            except (asyncio.TimeoutError, WebSocketClosed):
                return frames

    async def expect_silence(self, timeout: float = 0.1) -> None:
        try:
            frame = await self.receive_json(timeout=timeout)
        except asyncio.TimeoutError:
            return
        except WebSocketClosed:
            return
        raise AssertionError("expected no frame, got {!r}".format(frame))

    async def expect_close(self, timeout: float = 2.0) -> int:
        """Wait for the close frame and return its code."""
        if self.close_code is not None:
            return self.close_code
        try:
            while True:
                message = await self._next_message(timeout)
                if message["type"] == "websocket.close":
                    self.close_code = message.get("code", 1000)
                    return self.close_code
        except WebSocketClosed as exc:
            return exc.code

    async def send_json(self, payload: Dict[str, Any]) -> None:
        await self._to_app.put({"type": "websocket.receive", "text": json.dumps(payload)})

    async def disconnect(self, code: int = 1000) -> None:
        await self._to_app.put({"type": "websocket.disconnect", "code": code})
        if self._task is not None:
            try:
                await asyncio.wait_for(self._task, timeout=2.0)
            except (asyncio.TimeoutError, asyncio.CancelledError):
                self._task.cancel()
            self._task = None


@pytest_asyncio.fixture
async def open_socket(app):
    """Open a board socket with a ticket. Yields a connected WebSocketSession.

    Teardown is awaited rather than fired and forgotten: a leaked heartbeat task
    from one test will happily reap a connection in the next one.
    """
    sessions: List[WebSocketSession] = []

    async def _open(
        board_id: int,
        ticket: Optional[str],
        origin: Optional[str] = TEST_ORIGIN,
        expect_hello: bool = True,
    ) -> WebSocketSession:
        params = {} if ticket is None else {"ticket": ticket}
        session = WebSocketSession(
            app, "/ws/boards/{}".format(board_id), params=params, origin=origin
        )
        await session.__aenter__()
        sessions.append(session)
        if expect_hello and session.accepted:
            session.hello = await session.receive_json()  # type: ignore[attr-defined]
        return session

    yield _open

    for session in sessions:
        await session.disconnect()


@pytest_asyncio.fixture
def ticket_for():
    """Fetch a fresh single-use ticket for an actor and board."""

    async def _ticket(actor: Actor, board_id: int) -> str:
        response = await actor.post("/api/realtime/ticket", {"board_id": board_id})
        assert response.status_code == 201, response.text
        return response.json()["ticket"]

    return _ticket
