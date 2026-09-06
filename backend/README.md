# TaskFlow — Backend (Instance 1)

FastAPI + SQLAlchemy 2 (async) + Postgres, with a native-WebSocket broadcast hub and
server-authoritative fractional ordering. Produces Contracts 1–8 of `../CLAUDE.md`.

```
app/
  ordering.py     the fractional key algorithm — the only copy, in any language
  realtime.py     the in-process hub: registry, tickets, fan-out, heartbeat
  events.py       seq allocation + broadcast-after-commit
  queries.py      ordered reads, neighbour keys, the rebalance primitive
  deps.py         current user + membership-scoped resolution (404, never 403)
  serializers.py  every wire shape, built once so HTTP and WS payloads cannot drift
  activity.py     server-rendered activity sentences
  errors.py       the { "error": "<sentence>" } envelope
  routers/        auth · boards · lists · cards · comments · realtime
```

## Run it locally

SQLite, no services needed — the schema is created on boot:

```bash
cd backend
python -m venv .venv && .venv/Scripts/activate      # Windows
pip install -r requirements-dev.txt
cp .env.example .env                                 # then set JWT_SECRET
uvicorn app.main:app --reload --port 8000
```

Postgres via compose (applies `db/init.sql` on first boot):

```bash
cd backend && docker compose up --build
```

Interactive API docs: <http://localhost:8000/docs>. Health: `GET /api/health`.

## Tests

```bash
cd backend && python -m pytest            # 227 tests
python -m pytest tests/test_ordering.py   # the property tests, on their own
```

Tests run against the real ASGI app over in-memory SQLite. `tests/conftest.py` includes a
hand-rolled ASGI WebSocket client: Starlette's `TestClient` drives the app from a worker thread
with its own event loop, which would put the in-process hub and the fixtures on opposite sides of
a loop boundary. The custom client speaks the ASGI websocket protocol in the same loop, so a test
can perform a mutation and observe the resulting broadcast.

## Things a merger should know

### One uvicorn worker. Always. — `ASSUMED`

The hub is **in-process state**: `board_id -> set[connection]`, plus the ticket store, plus the
per-board mutation locks. A second worker would serve half the clients from a registry that never
sees the other half's broadcasts — cards would move on one browser and not the other, with no
error anywhere. A Redis fan-out is explicitly out of scope.

**Render must run this service with `--workers 1`.** The `Dockerfile` hard-codes it; do not add a
`WEB_CONCURRENCY` env var.

### Render free-tier services sleep

A cold start drops every socket and can take ~30 s. That is expected, not a bug: the client's
reconnect story (Contract 6 §6 — backoff with jitter, `seq` gap detection, snapshot refetch) is
what covers it. When testing at merge, a board that shows "Reconnecting…" for half a minute after
an idle period is the service waking up.

### `seq` and event counts

- `seq` is a per-board counter on `boards.seq`, incremented **inside the mutation's transaction**
  by a single `UPDATE ... RETURNING`, and every broadcast happens **after commit**. A client that
  receives `card.moved` and immediately refetches the snapshot always sees that move in it.
- Mutations are serialised per board by an `asyncio.Lock` held across allocate → commit →
  broadcast, so two concurrent mutations can neither share a `seq` nor arrive out of order.
- **One mutation emits one domain event *and* one `activity.appended`**, with consecutive `seq`
  values. So `seq` advances by 2 per mutation, not 1. Nothing in Contract 6 §6 depends on the
  ratio — the client's rule is purely `local_seq + 1` — but it surprises people reading the
  numbers, so: `POST /lists` moves `seq` from 4 to 6.
- Three mutations are deliberate exceptions:
  - `PATCH /lists/{id}/move` → one event, **no** activity entry (Contract 5 enumerates no
    `list.moved` verb).
  - `DELETE /comments/{id}` → **no** event, no activity entry (Contract 6 enumerates no
    `comment.deleted` event and Contract 5 no matching verb). Consequence: other clients'
    `comment_count` on that card goes stale until their next snapshot.
  - `POST /boards` → activity entry only; there is no `board.created` socket event, and nobody is
    connected to a board that did not exist a moment ago.
- `list.rebalanced` is server-originated: `actor_id` is `null` and it writes no activity entry.

### Ordering

`app/ordering.py` is base-62 fractional indexing with a length-encoded integer part, which is what
makes Contract 4's own example keys come out right: `key_between(None, None) == "a0"`,
then `"a1"`, `"a2"`, and `key_between("a0", "a1") == "a0V"`.

- **The client never sends a key.** Every position is expressed as neighbour ids, both of which are
  re-read inside the move transaction. A neighbour that has been deleted, relocated out of the
  destination list, or is the moved card itself → **409**, never a guessed position.
- **One card moved is exactly one row updated.** `tests/test_lists_cards.py` asserts this against
  the real SQL, on a 3-card list and again on a 20-card one.
- Appending stays compact (4 characters at 5000 cards). The pathological "always into the same
  gap" case grows about one character every five inserts, so 250 same-gap inserts still fit in 64.
- **Rebalance** (`list.rebalanced`) fires when there is genuinely no key between two neighbours:
  they hold equal keys (legal — see the tie-break below), or the gap has been squeezed past 64
  characters. It renormalises the list to `a0`, `a1`, `a2`… and broadcasts once. It is tested, not
  merely written, because a merge where it fires for the first time is the wrong moment to find
  out it is broken.
- **The `(order_key, id)` tie-break is mandatory on both sides.** Two concurrent inserts against
  the same neighbours can legally mint equal keys; the id secondary sort keeps every client
  deterministic anyway. Tested with a fixture where two cards share a key.
- ⚠️ **Open escalation:** Contract 4's rebalance escape hatch has no equivalent for a *board's
  lists*, so a list move with no room returns 409 instead. See ESCALATIONS in `../CLAUDE.md`.

### Authorization

Every read and write resolves its target to a board and asserts membership **in the same query**
(`app/deps.py`). A card is authorized through `cards.board_id` — denormalised for exactly this —
and a comment through `comments.board_id`, never through their parent alone. Every failure is
**404, never 403**: board membership must not be discoverable by probing ids. Owner-only routes
give a non-owner *member* the same 404 as a stranger.

### WebSocket security

- **Origin is checked by hand on the handshake**, against the same allow-list as CORS. Browsers do
  not apply same-origin policy to WebSockets and the CORS middleware never sees `/ws`. A
  disallowed origin is refused *before* accept, so the peer never becomes a WebSocket (HTTP 403).
  This is the security bug most likely to ship unnoticed in this project.
- A missing `Origin` is allowed by default (`WS_ALLOW_MISSING_ORIGIN=true`) so `websocat` and the
  test suite work; a non-browser client cannot be driven cross-site by a third party. Set it
  `false` to require one.
- Tickets are single-use, 30 seconds, bound to `(user_id, board_id)`, stored in-process.
  **Membership is re-checked at connect time**, so a ticket minted a moment before its holder was
  removed from the board cannot open a socket.
- A client that stops replying `pong` is dropped after three ping intervals (75 s). This is what
  stops a slept laptop's half-open TCP connection from leaving a ghost in the presence row.

## Driving the socket by hand

```bash
# 1. Sign in and keep the access token.
TOKEN=$(curl -s -X POST localhost:8000/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"you@example.com","password":"correct-horse-battery"}' | jq -r .access_token)

# 2. Mint a ticket for a board you are a member of (single-use, 30 s).
TICKET=$(curl -s -X POST localhost:8000/api/realtime/ticket \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"board_id":1}' | jq -r .ticket)

# 3. Connect. `hello` arrives first, then a ping every 25 s.
websocat "ws://localhost:8000/ws/boards/1?ticket=$TICKET"
```

Reply `{"type":"pong"}` to each `ping` or you will be dropped after 75 s. Now mutate the board in
another terminal (or a browser) and watch the envelopes arrive. Replaying the same `$TICKET`
closes with **4001**, which is the single-use rule working.

From a browser console on an allowed origin:

```js
const { ticket } = await (await fetch("/api/realtime/ticket", {
  method: "POST",
  headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
  body: JSON.stringify({ board_id: 1 }),
})).json();

const ws = new WebSocket(`ws://localhost:8000/ws/boards/1?ticket=${ticket}`);
ws.onmessage = (e) => {
  const frame = JSON.parse(e.data);
  if (frame.type === "ping") ws.send(JSON.stringify({ type: "pong" }));
  else console.log(frame.seq, frame.type, frame.payload);
};
ws.onclose = (e) => console.log("closed", e.code);   // 4001 / 4003 / 4004
```

## Environment

See `.env.example`. Two settings bite in production:

- `ALLOWED_ORIGINS` must include the Vercel **production and preview** domains. It is both the
  CORS allow-list and the WebSocket origin allow-list.
- The refresh cookie is cross-site in production (Vercel UI, Render API), so it needs
  `COOKIE_SECURE=true` and `COOKIE_SAMESITE=none`. With `lax` the browser silently declines to
  send it and every reload lands on the login screen.

`database.py` normalises hosted Postgres URLs on the way in: forces the `+asyncpg` driver, enables
SSL for remote hosts, and strips the libpq-only query args (`sslmode`, `channel_binding`) that
asyncpg rejects. Paste Neon's connection string unedited.

Python is pinned to **3.12.8** in `.python-version` and the `Dockerfile`; Render otherwise picks a
version with no prebuilt `pydantic-core` wheel and the source build fails on a read-only
filesystem. The source itself targets 3.9+ typing syntax (`Optional[X]`, not `X | None`) so the
suite also runs on an older local interpreter.
