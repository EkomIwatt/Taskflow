# TaskFlow — Multi-Agent Coordination File

> Project 4 of 10 in the AI-accelerated full-stack ladder. Third Swarm run.
> Snipp proved the machinery. LedgerLite added auth and user-scoped data.
> This run adds the first genuinely hard contract: **a live protocol between two
> processes that must converge when two people act at the same instant.**

## Project goal

TaskFlow is a real-time collaborative kanban board — Trello-lite. A signed-in user creates a
board, adds lists, adds cards, and drags cards within and between lists. Every change appears
**on every other open client within a second, without a refresh**: card moves, card edits, new
comments, the activity feed, and a live presence row showing who else has the board open. Cards
carry comments, every mutation writes an activity entry ("Ekom moved *Fix login* from Doing to
Done"), and card order uses **fractional (lexicographic) order keys**, so inserting a card
between two others writes exactly one row and never renumbers the list.

The engineering targets are (a) **real-time state** — one broadcast protocol, optimistic UI on
the client, and reconciliation when the server's authoritative echo disagrees with the local
guess; (b) **conflict handling** — two people dragging into the same gap at the same moment must
converge to the same board on both screens, with no lost card and no duplicate position; and
(c) **resync** — a client that drops its connection (laptop sleeps, Render cold-starts) must
detect that it missed events and recover without a manual refresh.

**Deliverables:** a FastAPI + Postgres backend with a native-WebSocket broadcast hub, a
React/Vite/TypeScript board UI with drag-and-drop and optimistic reconciliation, both test suites
green, and a clean Reconciler merge with every frozen contract holding on both real sides.

## Stack (settled with the human — do not change without them)

| Layer | Choice |
|-------|--------|
| Backend | **FastAPI** + SQLAlchemy 2 (async) + asyncpg |
| Realtime | **Native WebSocket** on FastAPI + an in-process per-board hub. No Socket.IO. |
| Database | **Postgres** (Neon in prod); tests run on in-memory SQLite via aiosqlite |
| Auth | **argon2** (passlib) · **HS256 JWT** access token · httpOnly refresh cookie — carried over from LedgerLite unchanged |
| Frontend | **React 19** + Vite + TypeScript + react-router |
| Drag & drop | **@dnd-kit/core** + **@dnd-kit/sortable** (pointer *and* keyboard accessible; `react-beautiful-dnd` is unmaintained — do not use it) |
| Tests | pytest + httpx + `websocket_connect` (backend) · Vitest + Testing Library + a fake socket (frontend) |
| Deploy | Vercel (UI) → Render (API + WS) → Neon (Postgres) |

**Four foundational decisions the human ratified before any contract was drafted:**

1. **Native WebSocket, not Socket.IO.** The wire format is ours and fully explicit (Contract 6)
   rather than hidden inside a library's framing. Heartbeat, backoff and resync are hand-rolled —
   that is the learning, not an oversight.
2. **The server is the sole authority on order keys.** The client sends the neighbours it dropped
   between; the server computes the fractional key. The midpoint algorithm therefore exists in
   **exactly one language, inside exactly one instance's codebase** (Contract 4). This is the
   single decision that makes a clean two-way split possible — see the rationale below.
3. **Real auth + explicit board membership.** LedgerLite's auth layer is carried over verbatim so
   the new difficulty stays concentrated on real-time. Boards have an owner and members.
4. **Live over the socket:** cards, lists, comments, activity, presence. **Not** live: drag-ghost
   indicators — deliberately cut, because ephemeral high-frequency events are a second message
   class with different persistence, sequencing and reconnect rules, and one message class is
   enough for a first real-time contract.

## Decomposition rationale

**Two instances. The seam is the process boundary: server vs. client.**

*Could one instance do this?* Yes — and unlike the previous two runs that was a live question
here, because this project has a component that genuinely spans the seam: the **real-time
protocol**. So the split had to be argued rather than assumed.

*Why the split still holds.* The two halves are written in different languages, live in disjoint
directories, and communicate over exactly two channels — HTTP/JSON and a WebSocket carrying JSON
envelopes. Both channels are fully specifiable in text (Contracts 1–8), and both are stubbable:
Instance 2 builds against a mock HTTP layer *and* a scripted fake socket that replays
contract-shaped envelopes on demand. Nothing in Instance 2's work requires Instance 1's real
process to exist.

*The real-time coupling trap, and how it was defused.* The dangerous version of this project is
the one where **the ordering algorithm lives on both sides**. If the client minted its own
fractional keys, `midpoint()` would have to exist in Python *and* TypeScript and agree
byte-for-byte forever — a duplicated algorithm straddling the instance boundary, invisible to
both test suites, and discovered only at merge, when two clients quietly disagree about card
order. That is not a contract; it is a shared implementation pretending to be one. Ratifying
**server-computed keys** (decision 2) collapses it into an ordinary producer/consumer contract:
the key is an **opaque sortable string** the client stores and compares but never generates,
parses, or reasons about. Instance 2 cannot get the algorithm wrong, because Instance 2 does not
have the algorithm.

*Why the WebSocket layer is not a third instance.* It fails the separability test in both
directions. On the server, the hub is not a service — it lives inside the FastAPI process, shares
the same session lifecycle and the same auth dependency, and **every mutating route emits into it
at its own transaction boundary**. Giving it to a third instance would mean handing Instance 1
real importable Python, not a stubbable JSON contract — precisely the "can't be stubbed" test for
work that must not run in parallel. On the client the socket manager is no more separable: it
feeds the same React state the drag handlers mutate, and the optimistic-reconciliation logic *is*
the join between them. So the hub **folds into Instance 1** and the socket client **folds into
Instance 2** (rule a: fold cross-cutting work into the domain owner that naturally produces it).
What crosses the seam is the protocol, and the protocol is Contract 6.

*Why not a third instance for glue?* Same rule. `docker-compose.yml`, `Dockerfile`, `db/init.sql`,
CORS + WS-origin config and `backend/.env.example` fold into Instance 1. The Vite dev proxy,
`vercel.json` and `frontend/.env.example` fold into Instance 2. `BUILT-WITH-SWARM.md`, `DEPLOY.md`
and the root `README.md` are **merge-time artifacts for the human/Reconciler** (rule b: small,
spanning both, best written once both halves are real). Nothing cross-cutting here is substantial
enough to earn its own instance (rule c not triggered).

**Nothing is deliberately sequenced.** Both instances build fully in parallel behind the frozen
contracts.

**Three boundaries that cannot be proven until merge** — the analogue of LedgerLite's httpOnly
cookie round-trip, known and scoped in advance:

1. **Convergence under concurrent drags.** A fake socket can replay *scripted* events, but it
   cannot prove that a real server receiving two moves into the same gap milliseconds apart
   serializes them into two distinct keys, nor that both real clients land on the same order.
   That needs two browsers and one server.
2. **Reconnect resync.** Instance 2 tests the gap-detection rule (Contract 6 §6) against a fake
   socket it can silence at will; Instance 1 tests that `seq` is monotonic per board. Neither can
   prove that a genuinely dropped connection during a burst of real edits recovers cleanly.
3. **The WebSocket ticket round-trip.** Browsers cannot set an `Authorization` header on a
   WebSocket, so the connection authenticates with a short-lived single-use ticket fetched over
   HTTP (Contract 6 §1). Mocks can simulate both halves; only a real origin proves the handshake.

All three are written up as ★ checks in MERGE-TIME ARTIFACTS & CHECKS at the bottom of this file.

## Status legend
IN PROGRESS · PENDING · BLOCKED · DONE · ASSUMED · WAITING ON <who/what>

## Project-wide conventions (binding on both instances)

- **The WebSocket is broadcast-only.** Server → client carries state changes; client → server
  carries **nothing but `pong`**. Every mutation is an ordinary authenticated HTTP request. This
  is deliberate: it keeps validation, authorization, error envelopes, status codes and the whole
  test surface on one well-understood channel, and it means a client with a dead socket is
  degraded (stale) rather than broken (read-only). Do not add a client→server mutation message.
- **`order_key` is an opaque sortable string.** Both sides sort by plain lexicographic string
  comparison with the binding tie-break `(order_key, id)` ascending. The client never generates,
  parses, splits or does arithmetic on a key. See Contract 4.
- **The server is authoritative, always.** Where local optimistic state and a server payload
  disagree, the server payload wins and *replaces* it — no merging, no clever resolution.
- **`seq` is a per-board monotonic integer** assigned at broadcast, starting at 1. It is the
  client's staleness detector. Presence events are ephemeral and carry `"seq": null` (Contract 6 §4).
- **The client never invents a server id.** Optimistic rows carry a local `temp_id` string
  (`"temp:<uuid>"`) that is never sent to the server; they are reconciled by `client_op_id`
  (Contract 7) — never by matching on title, position or timestamp.
- **Error envelope is `{ "error": "<sentence>" }`** for every non-2xx HTTP response, from every
  endpoint. WebSocket failures close with a numeric code instead (Contract 8).
- **Non-member access returns 404, never 403** — carried from LedgerLite. Board membership must
  not be discoverable by probing ids.
- **The client never sends a user id.** Actorship is derived from the access token, always.
- **Timestamps** are ISO-8601 UTC with a trailing `Z`. This project has no calendar-date fields.
- **Display identity is server-computed.** Every user payload carries `display_name` (falling back
  to the email local-part) and `avatar_color` (a hex string derived deterministically from the
  user id). The frontend invents neither — the same person is the same colour in presence, in
  comments and in the activity feed because the server said so. `ASSUMED` for the fallback rule;
  low stakes, display-only.

---

## INTERFACE CONTRACTS  —  STATUS: FROZEN

<!-- Becomes FROZEN only on human ratification. After that: no edits without the human.
     Ratify and commit on `main` BEFORE creating the worktrees, so both instances provably
     branch from byte-identical contract text. -->

### Contract 1: Authentication  (carried over from LedgerLite, unchanged)

- **Producer:** Instance 1
- **Consumer(s):** Instance 2
- **Shape / format:**

```
POST /api/auth/signup            (public)
  request   { "email": string, "password": string, "display_name": string | null }
  201       { "access_token": string,
              "token_type": "bearer",
              "expires_in": 900,
              "user": <User> }
            + Set-Cookie: refresh_token=<jwt>; HttpOnly; Path=/api/auth; Max-Age=2592000
  409       { "error": "An account with that email already exists." }
  422       { "error": "Password must be at least 8 characters." }

POST /api/auth/login             (public)
  request   { "email": string, "password": string }
  200       <identical body + Set-Cookie to signup's 201>
  401       { "error": "Incorrect email or password." }
            ^ THE SAME message for an unknown email and a wrong password.
              No user enumeration — not by message, not by status, not by timing.

POST /api/auth/refresh           (cookie only — no body, no Authorization header)
  200       { "access_token": string, "token_type": "bearer", "expires_in": 900 }
            + Set-Cookie: refresh_token=<new jwt>   (rotated on every refresh)
  401       { "error": "Session expired. Please sign in again." }

POST /api/auth/logout            (bearer)
  204       no body; clears the cookie and invalidates outstanding refresh tokens

GET  /api/auth/me                (bearer)
  200       <User>
  401       { "error": "Not authenticated." }

<User> = { "id": int,
           "email": "ekom@example.com",
           "display_name": "ekom",        // never null on the wire; server falls back
           "avatar_color": "#3B82F6",     // deterministic from id; never null
           "created_at": "2026-09-06T10:00:00Z" }
```

Access tokens carry `typ: "access"`, refresh tokens `typ: "refresh"`; the claim is verified on
every path, so a refresh token presented as a Bearer credential is rejected 401. Cookie flags are
environment-driven (`COOKIE_SECURE`, `COOKIE_SAMESITE`).

---

### Contract 2: Boards & membership

- **Producer:** Instance 1
- **Consumer(s):** Instance 2
- **Shape / format:**

```
GET  /api/boards                                 (bearer)
  200  { "boards": [ { "id": int, "title": string, "role": "owner" | "member",
                       "member_count": int, "card_count": int,
                       "updated_at": "2026-09-06T10:00:00Z" } ] }
       ^ boards the caller owns OR is a member of, newest activity first. [] for a new account.

POST /api/boards                                 (bearer)
  request  { "title": string }                   // 1..80 chars after trim
  201      <BoardSummary as above, role "owner">
  422      { "error": "Board title is required." }

GET  /api/boards/{board_id}                      (bearer, member only)   ← THE SNAPSHOT
  200  { "id": 7,
         "title": "Launch",
         "seq": 412,                             // last event applied to this board; see C6
         "role": "owner",
         "members": [ { "user": <User>, "role": "owner",
                        "added_at": "2026-09-06T10:00:00Z" } ],
         "lists": [ { "id": 4, "title": "Doing", "order_key": "a1",
                      "cards": [ <Card>, ... ] } ],
         "activity": [ <Activity>, ... ] }       // most recent 50, newest first
  404  { "error": "Board not found." }           // ALSO the answer for a non-member

PATCH /api/boards/{board_id}                     (bearer, owner only)
  request  { "title": string }
  200      { "id": int, "title": string }
  404      { "error": "Board not found." }

DELETE /api/boards/{board_id}                    (bearer, owner only)
  204      no body; cascades lists, cards, comments, activity, memberships

POST /api/boards/{board_id}/members              (bearer, owner only)
  request  { "email": string }
  201      { "user": <User>, "role": "member", "added_at": "..." }
  404      { "error": "No account with that email address." }
  409      { "error": "That person is already a member of this board." }

DELETE /api/boards/{board_id}/members/{user_id}  (bearer, owner only)
  204      no body
  409      { "error": "The board owner cannot be removed." }
```

`seq` in the snapshot is the contract's load-bearing field: it is the client's starting cursor
and the value it compares against `hello` on socket connect. A snapshot without a `seq` is
unusable.

---

### Contract 3: Lists & cards

- **Producer:** Instance 1
- **Consumer(s):** Instance 2
- **Shape / format:**

```
<Card> = { "id": 19,
           "list_id": 4,
           "board_id": 7,
           "title": "Fix login redirect",
           "description": "" | string,          // markdown-free plain text, may be ""
           "order_key": "a0V",                  // OPAQUE — see Contract 4
           "comment_count": 3,
           "created_by": <User>,
           "created_at": "...", "updated_at": "..." }

POST   /api/boards/{board_id}/lists              (bearer, member)
  request  { "title": string, "after_list_id": int | null }   // null = append to the end
  201      { "id": int, "board_id": int, "title": string, "order_key": string, "cards": [] }

PATCH  /api/lists/{list_id}                      (bearer, member)
  request  { "title": string }
  200      { "id": int, "title": string }

PATCH  /api/lists/{list_id}/move                 (bearer, member)
  request  { "before_list_id": int | null, "after_list_id": int | null }
  200      { "id": int, "order_key": string }

DELETE /api/lists/{list_id}                      (bearer, member)
  204      no body; cascades its cards

POST   /api/lists/{list_id}/cards                (bearer, member)
  request  { "title": string, "after_card_id": int | null }   // null = append to the end
  201      <Card>
  422      { "error": "Card title is required." }

PATCH  /api/cards/{card_id}                      (bearer, member)
  request  { "title"?: string, "description"?: string }       // partial; absent = unchanged
  200      <Card>

PATCH  /api/cards/{card_id}/move                 (bearer, member)   ← THE INTERESTING ONE
  request  { "list_id": int,                     // destination list (may equal the current one)
             "before_card_id": int | null,       // the card ABOVE the drop point, null = top
             "after_card_id": int | null }       // the card BELOW the drop point, null = bottom
  200      <Card>                                // with the server's authoritative order_key
  404      { "error": "Card not found." }        // it was deleted mid-drag — roll back
  409      { "error": "The board changed while you were dragging. Refreshing." }
           ^ ONLY when a named neighbour no longer sits in the destination list. The server
             does not guess a position from a stale neighbour; the client refetches the snapshot.
  422      { "error": "Cards cannot be moved to another board." }

DELETE /api/cards/{card_id}                      (bearer, member)
  204      no body
```

Every mutating endpoint above accepts the optional header `X-Client-Op-Id` (Contract 7) and emits
exactly one WebSocket event (Contract 6) plus exactly one activity entry (Contract 5).

---

### Contract 4: Fractional order keys

- **Producer:** Instance 1 (sole implementer)
- **Consumer(s):** Instance 2 (sorts by them; never generates them)
- **Shape / format:**

```
order_key : string, 1..64 chars, alphabet [0-9A-Za-z] ordered by ASCII
            ('0' < '9' < 'A' < 'Z' < 'a' < 'z')

SORTING (binding on both sides):
    cards.sort(by (order_key ASC, id ASC))
    lists.sort(by (order_key ASC, id ASC))
    ^ plain byte-wise string comparison. JS: a.order_key < b.order_key. Python: a < b.
      The `id` tie-break is mandatory, not decorative — see below.

INVARIANTS the server guarantees:
  I1  Keys are unique per (list_id) for cards, and per (board_id) for lists.
  I2  For any two neighbours a < b the server can always mint a key strictly between them.
      No "ran out of room" failure is ever surfaced to the client.
  I3  A key is never mutated except by an explicit move or a rebalance (below).
  I4  Keys are NEVER exposed as a position, index, or number, and carry no meaning beyond
      their sort order. Two keys being "close" means nothing.

THE CLIENT MUST NOT:
  - generate a key, parse one, measure its length, or compute a midpoint;
  - infer position from a key ("a0V is halfway") or display one;
  - assume keys are dense, contiguous, evenly spaced, or of equal length;
  - reuse a key from a deleted card.

REBALANCE (rare, server-initiated):
  If the server ever renormalises a list's keys it broadcasts ONE event:
    list.rebalanced { "list_id": 4, "cards": [ { "id": 19, "order_key": "a1" }, ... ] }
  The client replaces that list's keys wholesale and re-sorts. It must handle this event even
  if it never fires in practice — it is the escape hatch that makes I2 true.
```

The tie-break exists because two concurrent inserts against the same neighbours can, in a
pathological interleaving, produce equal keys. The server treats that as legal, not as an error;
`(order_key, id)` keeps both clients deterministic regardless. **Both sides must implement the
tie-break, and both must test it with a fixture containing two cards that share a key.**

---

### Contract 5: Comments & activity

- **Producer:** Instance 1
- **Consumer(s):** Instance 2
- **Shape / format:**

```
<Comment> = { "id": 88, "card_id": 19, "board_id": 7,
              "author": <User>, "body": string,       // 1..2000 chars, plain text
              "created_at": "2026-09-06T10:00:00Z" }

GET  /api/cards/{card_id}/comments               (bearer, member)
  200  { "comments": [ <Comment>, ... ] }         // oldest first

POST /api/cards/{card_id}/comments               (bearer, member)
  request  { "body": string }
  201      <Comment>
  422      { "error": "Comment cannot be empty." }

DELETE /api/comments/{comment_id}                (bearer, author only)
  204      no body
  404      { "error": "Comment not found." }      // also the answer for someone else's comment

<Activity> = { "id": 501, "board_id": 7,
               "actor": <User>,
               "verb": "card.moved",              // enumerated below
               "summary": "Ekom moved Fix login redirect from Doing to Done",
               "subject": { "card_id": 19, "card_title": "Fix login redirect",
                            "from_list": "Doing", "to_list": "Done" },
               "created_at": "2026-09-06T10:00:00Z" }

  verb ∈ { board.created, board.renamed, member.added, member.removed,
           list.created, list.renamed, list.deleted,
           card.created, card.moved, card.renamed, card.described, card.deleted,
           comment.added }

GET /api/boards/{board_id}/activity?limit=50&before_id=<int>   (bearer, member)
  200  { "activity": [ <Activity>, ... ], "next_before_id": int | null }   // newest first
```

**`summary` is server-rendered on purpose.** The frontend prints the sentence; it must not
reconstruct one from `verb` + `subject`. `subject` exists so the UI can link the card and bold a
name, not so it can compose prose. Keeping the sentence on the server means a new verb ships
without a frontend change — the same principle as LedgerLite computing its chart aggregates in SQL.

A card move **within** one list writes `card.moved` with `from_list == to_list`; the summary reads
"Ekom reordered *Fix login redirect* in Doing". Cross-list moves read "moved … from X to Y".

---

### Contract 6: The WebSocket protocol  ★ the centrepiece

- **Producer:** Instance 1
- **Consumer(s):** Instance 2
- **Shape / format:**

#### §1 — Connecting (ticket auth)

Browsers cannot set an `Authorization` header on a WebSocket, so the socket authenticates with a
short-lived ticket fetched over ordinary authenticated HTTP:

```
POST /api/realtime/ticket                        (bearer)
  request  { "board_id": 7 }
  201      { "ticket": "<opaque string>", "expires_in": 30 }
  404      { "error": "Board not found." }       // non-member

  A ticket is SINGLE-USE, expires in 30 seconds, and is bound to (user_id, board_id).
  Consuming it does not consume the caller's session; a reconnect fetches a fresh one.

WS  {WS_BASE}/ws/boards/{board_id}?ticket=<ticket>
```

`WS_BASE` is configuration on both sides (`ws://localhost:8000` in dev, `wss://<render-host>` in
prod). Note for deployment: the browser connects to the API origin **directly** — Vercel does not
proxy WebSockets — so the WS origin is not necessarily the HTTP origin the app was served from.

#### §2 — The envelope (every server → client frame)

```json
{
  "type": "card.moved",
  "board_id": 7,
  "seq": 412,
  "actor_id": 3,
  "client_op_id": "3f1c…" ,
  "ts": "2026-09-06T10:00:00Z",
  "payload": { }
}
```

| Field | Rule |
|---|---|
| `type` | one of the enumerated types in §3/§4. An unknown `type` **must be ignored silently** by the client — that is what lets the server add an event type without breaking deployed clients. |
| `board_id` | always present; the client drops frames for any other board. |
| `seq` | per-board monotonic int for state events; **`null`** for ephemeral events (§4). |
| `actor_id` | the user who caused it; `null` for server-originated events. |
| `client_op_id` | echoed from the originating request's `X-Client-Op-Id`, else `null` (Contract 7). |
| `ts` | ISO-8601 UTC. Informational — never used for ordering. `seq` orders events, not `ts`. |
| `payload` | type-specific, defined below. |

#### §3 — State events (carry a `seq`)

```
hello              { "board_id": 7, "seq": 412, "you": <User>,
                     "online": [ <User>, ... ] }        ← FIRST frame after accept, always

board.updated      { "id": 7, "title": "Launch v2" }
board.member_added { "user": <User>, "role": "member" }
board.member_removed { "user_id": 5 }
                     ^ if the removed user is you, the server then closes with 4003 (§5)

list.created       <the full list object, cards: []>
list.updated       { "id": 4, "title": "Doing" }
list.moved         { "id": 4, "order_key": "a2" }
list.deleted       { "id": 4 }
list.rebalanced    { "list_id": 4, "cards": [ { "id": int, "order_key": string } ] }

card.created       <Card>
card.updated       <Card>
card.moved         { "id": 19, "list_id": 4, "from_list_id": 2, "order_key": "a0V",
                     "updated_at": "..." }
card.deleted       { "id": 19, "list_id": 4 }

comment.created    <Comment>
activity.appended  <Activity>
```

`hello` is the only frame the client may treat as special. Everything else is uniform: apply the
payload to local state, keyed by `id`.

#### §4 — Ephemeral events (`seq` is `null`, never persisted, never replayed)

```
presence.joined    { "user": <User> }
presence.left      { "user_id": 5 }
ping               { }        ← server heartbeat; client replies { "type": "pong" }
```

Presence is derived from live connections only. It is never stored, never appears in the activity
feed, and **must not advance the client's `seq` cursor**. A user with three tabs open appears
once; `presence.left` fires when their last connection for that board closes.

#### §5 — Close codes

| Code | Meaning | Client behaviour |
|---|---|---|
| 1000 | normal closure (client navigated away) | do not reconnect |
| 1011 | server error | reconnect with backoff |
| 4001 | ticket missing, invalid, expired or already used | fetch a **new ticket**, reconnect once; if it fails again, run the auth-refresh flow, then retry |
| 4003 | not (or no longer) a member of this board | do not reconnect; route to the board list with a message |
| 4004 | board not found | do not reconnect |

#### §6 — Heartbeat, reconnect and resync (the resilience rules)

1. The server sends `ping` every **25 s**. The client replies `{"type":"pong"}` immediately. A
   client that receives no frame of any kind for **60 s** treats the socket as dead, closes it,
   and reconnects.
2. Reconnect uses exponential backoff with jitter: **1 s, 2 s, 4 s, 8 s, 16 s, then 30 s
   capped**, reset on a successful `hello`. Never reconnect in a tight loop; a Render cold start
   can take 30 s and must not become a stampede.
3. **The client tracks `seq`.** It is initialised from the snapshot (Contract 2) and updated on
   every state event.
   - `event.seq == local_seq + 1` → apply, advance.
   - `event.seq <= local_seq` → **duplicate, drop silently.**
   - `event.seq > local_seq + 1` → **a gap: events were missed.** Do not apply. Refetch
     `GET /api/boards/{id}`, replace local state wholesale, and set `local_seq` from the snapshot.
   - ephemeral events (§4) → apply, do **not** touch `local_seq`.
4. On `hello`, if `hello.seq != local_seq`, refetch the snapshot before applying anything else.
   This is the same rule as (3) and is the normal path after any disconnect longer than a moment.
5. There is **no server-side replay buffer.** Snapshot-refetch is the only recovery mechanism.
   This is a deliberate simplification: it is O(1) state on the server, it cannot go stale, and
   it collapses "missed 3 events" and "missed 3000" into one code path.
6. While disconnected the UI shows a **"Reconnecting…" indicator** and continues to accept edits
   over HTTP (they still succeed — only the *notifications* are down). The client must not queue
   mutations for later replay; a failed request surfaces its error immediately.

---

### Contract 7: Optimistic UI & reconciliation

- **Producer:** Instance 1 (echo semantics) · Instance 2 (local application)
- **Consumer(s):** both
- **Shape / format:**

```
Every mutating HTTP request MAY carry:      X-Client-Op-Id: <uuid4 string>
The server echoes it verbatim in the resulting broadcast envelope as `client_op_id`.
It is opaque to the server: never stored, never validated, never used for idempotency.
```

**The rules, binding on both sides:**

1. **The server does not skip the sender.** The originating client receives its own broadcast
   like everyone else. One code path, self-healing, and it makes the echo the single settling
   signal.
2. **The client settles on whichever arrives first** — the HTTP 2xx response body or the matching
   broadcast. Both carry the same authoritative object; applying both is a no-op because
   application is by `id`, replacing wholesale.
3. **A pending optimistic op is retired when** `client_op_id` matches, **or** when the HTTP
   response for it resolves. Never by title, position, or timestamp matching.
4. **On an HTTP error the client rolls back that op's local mutation entirely** and shows
   `body.error`. It never leaves a half-applied optimistic state on screen.
5. **A late broadcast for an op the client already rolled back is applied normally** — it is
   authoritative server state, and by then the rollback is irrelevant.
6. **Conflict policy is last-write-wins, at the field level, decided by the server.** Two people
   editing one card title: the second write wins, and both clients converge on it because both
   receive both `card.updated` events in `seq` order. No merge, no CRDT, no vector clocks.
7. **A move whose neighbour vanished** returns 409 (Contract 3). The client rolls back and
   refetches the snapshot — the 409 message is written to be shown to the user as-is.
8. **Optimistic moves reorder the local array positionally**, without a key. The card renders
   between its new neighbours; the authoritative `order_key` arrives with the echo and replaces
   the local placeholder. This is exactly why the client never needs the key algorithm.

---

### Contract 8: Errors, status codes and CORS

- **Producer:** Instance 1
- **Consumer(s):** Instance 2
- **Shape / format:**

```
EVERY non-2xx HTTP response body, from every endpoint, without exception:
    { "error": "<a complete, user-showable sentence.>" }
There is no `detail` key anywhere. FastAPI's default validation envelope is overridden.

400  malformed request               422  validation failed (per-endpoint message)
401  missing/invalid/expired token   404  not found — INCLUDING every non-member access
409  conflict (stale drag, duplicate member, owner removal)
500  { "error": "Something went wrong on our end." }   — never leaks internals

CORS (credentialed, because of the refresh cookie):
    allow_origins        = explicit list from env (no "*", ever — it is illegal with credentials)
    allow_credentials    = True
    allow_methods        = GET, POST, PATCH, DELETE, OPTIONS
    allow_headers        = Authorization, Content-Type, X-Client-Op-Id
    expose_headers       = (none required)

WebSocket origin checking is separate from CORS and must be done explicitly in the handshake
against the same allow-list. Browsers do not enforce same-origin policy on WebSockets.
```

---

## ESCALATIONS & PROPOSED AMENDMENTS

<!-- Instances write structured requests + *proposed* amendments here. Never edit the
     frozen block or another instance's section directly. Human resolves. -->

### ESCALATION 2026-09-06T13:40:00Z — Instance 2
**Type:** gap
**Re:** Contract 3 (`<Card>.comment_count`) × Contract 5 (`comment.created`) × Contract 6 §3
**Issue:** `<Card>` carries `comment_count`, but no broadcast event carries an updated value for
it. `comment.created` delivers a `<Comment>`, and Contract 3 says a mutation emits *exactly one*
state event, so posting a comment produces no `card.updated`. A client that stays connected
therefore shows a `comment_count` that is stale until its next snapshot refetch.
**Proposed resolution:** human to decide between (a) leave as-is and let clients derive the
count locally from `comment.created` — what Instance 2 has implemented, self-healing on the next
snapshot, no wire change; (b) amend Contract 3 so `<Comment>` includes the card's new
`comment_count`; (c) amend Contract 6 §3 so a comment additionally emits `card.updated` — note
this contradicts the one-mutation-one-event rule and is the weakest option.
**Blocked work:** none — continuing other work. Implemented as (a) and marked `ASSUMED` in
`frontend/README.md` and in `boardReducer.ts`. If the human ratifies (b), the client's local
increment is deleted and the server value is applied; that is a small, contained change.
**Status:** OPEN

---

## INSTANCE 1 — Backend API, Realtime Hub & Ordering  ·  STATUS: PENDING

**Owns:** `backend/` in full — `app/` (models, schemas, routers, auth, crud, ordering, realtime
hub, activity, errors, config, database), `tests/`, `db/init.sql`, `requirements.txt`,
`pytest.ini`, `Dockerfile`, `docker-compose.yml`, `.python-version`, `backend/.env.example`,
`backend/README.md`.

**Does NOT touch:** `frontend/` (anything at all), the root `README.md`, `BUILT-WITH-SWARM.md`,
`DEPLOY.md`, the INTERFACE CONTRACTS block, or Instance 2's section of this file.

**Assigned skills:** `fastapi-expert`, `websocket-engineer`, `postgres-pro`, `api-designer`,
`security-reviewer`, `test-master`

**Role prompt:**

You are **Instance 1**, owner of the TaskFlow backend. You build a FastAPI + Postgres API for a
collaborative kanban board, and you own the two things that make this project hard: **the
fractional ordering algorithm** and **the WebSocket broadcast hub**.

You **produce all eight contracts**. Instance 2 is building its entire UI against a mock of your
HTTP layer and a *fake socket replaying your envelopes*, without ever seeing your code — so the
contract text is the specification, not a sketch. If you believe a contract is wrong, do not
"improve" it silently: write a proposed amendment in ESCALATIONS and wait for the human.

**The ordering algorithm is yours alone, and it is the reason this run splits cleanly.**

- Implement fractional/lexicographic keys in `app/ordering.py`: `key_between(a: str|None,
  b: str|None) -> str`, returning a key strictly between two neighbours, where `None` means
  "no neighbour on that side". Contract 4's invariants I1–I4 are the specification.
- **Property-test it, not just example-test it.** Generate thousands of random insert sequences —
  always-at-front, always-at-back, always-into-the-same-gap (the pathological case that grows key
  length fastest), random gaps — and assert after every step that sorting the keys reproduces the
  intended order and that all keys are unique. The always-into-the-same-gap case is what a naive
  midpoint implementation gets wrong on iteration ~40.
- **Never renumber a list on a normal move.** One card moved is exactly one row updated. If you
  find yourself writing an UPDATE that touches sibling rows, you have built integer positions
  with extra steps, and the project's stated purpose is gone.
- `list.rebalanced` (Contract 4) is the escape hatch that lets you guarantee I2. Implement and
  test it even though it should almost never fire — Instance 2 has written a handler for it and
  a merge where it fires for the first time is not the moment to discover it is broken.
- The client sends **neighbour ids, never keys** (Contract 3). Re-read both neighbours inside the
  move transaction; if either no longer sits in the destination list, return 409 rather than
  guessing a position from stale input. Do not accept an `order_key` from a client, ever.

**The realtime hub — `app/realtime.py`:**

- An in-process registry: `board_id -> set[connection]`, each connection carrying its `user_id`.
  Single-process only; a Redis fan-out is explicitly out of scope. **`ASSUMED`** — note it in
  `backend/README.md` so the constraint is visible when this deploys to more than one worker.
  Render must therefore run this service with **one** uvicorn worker.
- **`seq` is per-board, monotonic, and assigned at broadcast.** A `boards.seq` column bumped
  inside the same transaction as the mutation is the straightforward mechanism (the contract only
  constrains observable behaviour; the mechanism is yours). Two concurrent mutations must never
  receive the same `seq` — test it with concurrent requests, not by inspection.
- **Broadcast after commit, never before.** A client that receives `card.moved` and immediately
  refetches the snapshot must see that move already in it. Emitting inside the transaction is the
  classic source of "the event arrived before the data existed" flakiness.
- **One mutation → exactly one state event + exactly one activity entry.** Not two, not zero. A
  card move that also touches `updated_at` is still one `card.moved`.
- **A slow or dead client must never block a broadcast.** Send with a per-connection timeout;
  on failure, drop that connection and continue the fan-out. One hung socket must not stall the
  board for everyone else.
- **Ticket auth (Contract 6 §1):** single-use, 30-second, bound to `(user_id, board_id)`, stored
  in-process. Validate membership **at connect time as well as at ticket time** — a ticket minted
  a moment before removal from the board must not open a socket.
- **Check the `Origin` header explicitly on the WS handshake** against the same allow-list as
  CORS. Browsers do not apply same-origin policy to WebSockets; CORS middleware does not protect
  this endpoint. This is the security bug most likely to ship unnoticed in this project.
- Clean up on disconnect in a `finally` — including on exception paths — or presence leaks
  ghost users who never left.

**Data model** (yours to finalize; these constraints are required):

- `users` — carried from LedgerLite, plus `display_name` (nullable; falls back to the email
  local-part on the wire) and a deterministic `avatar_color` derived from `id`.
- `boards` — id, owner_id FK→users, title, `seq` BIGINT NOT NULL DEFAULT 0, created_at, updated_at.
- `board_members` — board_id FK ON DELETE CASCADE, user_id FK ON DELETE CASCADE, role, added_at.
  **UNIQUE (board_id, user_id)**. The owner is also a row here, with `role='owner'`.
- `lists` — id, board_id FK ON DELETE CASCADE, title, `order_key` TEXT NOT NULL.
  Index `(board_id, order_key)`.
- `cards` — id, list_id FK ON DELETE CASCADE, board_id (**denormalised**, for board-scoped
  authorization and broadcast without a join), title, description, `order_key` TEXT NOT NULL,
  created_by FK→users, created_at, updated_at. Index `(list_id, order_key)`.
- `comments` — id, card_id FK ON DELETE CASCADE, board_id, author_id FK→users, body, created_at.
- `activity` — id, board_id FK ON DELETE CASCADE, actor_id FK→users ON DELETE SET NULL, verb,
  `summary` TEXT, `subject` JSON, created_at. Index `(board_id, id DESC)` for the feed.

**Authorization is the LedgerLite discipline, one level up.** There, scoping was
`user_id = current_user.id`. Here it is **membership**: every read and write resolves the target
to a board and asserts the caller is a member of it, in the same query. A card id and a comment
id must both be authorized through their board — not through their parent alone. Write the
`member_board_or_404` dependency once and route everything through it; a route that fetches by id
without it is the worst bug this project can ship. Cross-board access returns **404**.

**Tests** (pytest + httpx against the real ASGI app over in-memory SQLite):

- **Ordering property tests** as described above — thousands of inserts, order preserved, keys
  unique, no sibling rows updated on a single move.
- **Membership isolation:** a non-member gets 404 from every board, list, card, comment and
  activity endpoint, and 4003/404 from the socket. A removed member's existing socket is closed.
- **`seq` monotonicity under concurrency:** fire N concurrent mutations on one board with
  `asyncio.gather`; assert N distinct, contiguous `seq` values and N broadcast events.
- **The socket, with `websocket_connect`:** `hello` arrives first and carries the current `seq`;
  a mutation by client A is received by client B; B's payload matches the contract field-for-field;
  an invalid ticket closes 4001; a reused ticket closes 4001; a non-member closes 4003.
- **Echo:** a mutation sent with `X-Client-Op-Id: abc` broadcasts an envelope whose
  `client_op_id` is exactly `abc`, and the sender's own socket receives it too (Contract 7 §1).
- **Broadcast-after-commit:** on receiving an event, an immediate snapshot fetch already contains
  the change.
- **Stale-neighbour move:** moving a card next to a neighbour that has been deleted or relocated
  returns 409 and changes nothing.
- **Error envelope:** a 422, a 404 and a 401 each return `{ "error": ... }` and no `detail` key.

**Deployment carry-overs from Snipp and LedgerLite — apply from the start, each cost a redeploy:**

- Pin **Python 3.12.8** in `backend/.python-version` and the `Dockerfile`. Render otherwise
  defaults to a Python with no prebuilt `pydantic-core` wheel and the source build fails on a
  read-only filesystem.
- **Normalise hosted Postgres URLs** in `database.py`: force the `+asyncpg` driver, enable SSL,
  strip libpq-only query args (`sslmode`, `channel_binding`) that asyncpg rejects. Local and
  SQLite URLs pass through untouched. LedgerLite's `database.py` is a working reference.
- Match the local interpreter version when choosing typing syntax, as LedgerLite did, so the suite
  runs locally while the container pins 3.12.
- **New this run:** Render free-tier services sleep, and a cold start drops every socket. Your
  reconnect story (Contract 6 §6) is client-side, but note the behaviour in `backend/README.md` so
  it is not mistaken for a bug at merge.

**Also yours:** `docker-compose.yml` (Postgres + api, healthcheck, env), `db/init.sql`, the CORS
and WS-origin configuration, and a `backend/README.md` covering local run, test commands, the
single-worker constraint, and how to drive the socket by hand with `websocat` or a browser console.

Follow the `swarm-worker` runtime protocol for all shared-file, escalation, and git rules.

**Work log:**

(instance writes only here)

---

## INSTANCE 2 — Frontend Board & Realtime Client  ·  STATUS: DONE

**Owns:** `frontend/` in full — `src/` (pages, board UI, drag-and-drop, socket client, api client,
mock + fake-socket layer, auth context, hooks, state reducer), `index.html`, `package.json`,
`vite.config.ts`, `tsconfig*.json`, `frontend/.env.example`, `vercel.json`, `frontend/README.md`.

**Does NOT touch:** `backend/` (anything at all), the root `README.md`, `BUILT-WITH-SWARM.md`,
`DEPLOY.md`, the INTERFACE CONTRACTS block, or Instance 1's section of this file.

**Assigned skills:** `react-expert`, `typescript-pro`, `websocket-engineer`, `ui-ux-pro-max`,
`frontend-design`, `test-master`

**Role prompt:**

You are **Instance 2**, owner of the TaskFlow frontend. You build the whole React/Vite/TypeScript
app: signup and login, the board list, the board view with drag-and-drop lists and cards, the card
detail panel with comments, the activity feed, and the presence row.

You **consume Contracts 1–8** and produce none. You will never see Instance 1's code. Build the
entire app against **two** stubs, both toggled by env flags:

1. `src/api/mocks.ts` — the HTTP layer, implementing Contracts 1–5 and 8 verbatim.
2. `src/realtime/fakeSocket.ts` — **a scripted socket you control**: it can emit any contract
   envelope on demand, deliver events out of order, deliver duplicates, skip a `seq` to force a
   gap, go silent to trip the 60 s heartbeat timeout, and close with any code from Contract 6 §5.
   This is your most valuable test asset. Every rule in Contract 6 §6 and Contract 7 is testable
   against it, and doing so is what will make the merge land.

Write a **contract-conformance suite** asserting your stubs match the frozen shapes — that suite
is what made Snipp's and LedgerLite's merges land byte-for-byte, so repeat it here, and extend it
to the WebSocket envelopes.

**Optimistic drag-and-drop is the graded part of this project:**

- Use `@dnd-kit` (`core` + `sortable`). It supports keyboard dragging out of the box; wire it up
  and keep it working — a board that only responds to a mouse is an unfinished board.
- **On drop, apply the move locally, immediately, positionally** — splice the card into its new
  index in the local array with a placeholder key, then fire
  `PATCH /api/cards/{id}/move` with `{ list_id, before_card_id, after_card_id }` derived from the
  cards now above and below it, plus an `X-Client-Op-Id`. **You never compute an `order_key`**;
  Contract 4 forbids it and Contract 7 §8 explains why you do not need one. If you find yourself
  wanting a midpoint function in TypeScript, stop — that is the coupling trap this plan exists to
  avoid, and it is an escalation, not a patch.
- **Sort with the binding tie-break** `(order_key, id)` everywhere you render an ordered list.
  Write a `sortByOrder` helper, use it in exactly one place, and test it with a fixture where two
  cards share an `order_key`.
- **Rollback must be complete.** A 404, 409 or 500 restores the pre-drag state exactly and shows
  `body.error`. Half-applied optimistic state on screen is worse than no optimism at all.

**The socket client — `src/realtime/`:**

- A single connection per open board, owned by one module, exposing events to React through one
  reducer. Not one socket per component, and no direct `setState` from the socket callback into
  five different components.
- Implement Contract 6 §6 exactly: fetch a ticket → connect → `hello` → heartbeat with a 60 s
  dead-man timer → exponential backoff with jitter on reconnect → `seq` gap detection →
  snapshot refetch. **Test each of these against the fake socket**, including the two easy ones to
  get wrong: a duplicate event (`seq <= local_seq`) must be dropped silently, and a presence event
  must not advance `local_seq`.
- **Ignore unknown `type` values silently.** Do not throw, do not log an error to the user, do not
  refetch. Forward compatibility is a contract requirement, not politeness.
- A ticket is single-use: **every reconnect fetches a fresh one.** A 4001 close means fetch a new
  ticket and retry once; if that fails too, run the auth-refresh flow before trying again.
- Show a **"Reconnecting…"** indicator while the socket is down. Edits still work over HTTP during
  that window (Contract 6 §6.6) — do not disable the board, and do not queue mutations for replay.
- Close the socket on unmount and on navigating away from the board, with code 1000.

**Auth carries over from LedgerLite unchanged — reuse the pattern, do not redesign it:**

- Access token **in memory only**; never localStorage, never sessionStorage. Session survival
  across a reload comes from the httpOnly refresh cookie your JavaScript cannot read.
- Boot with one `POST /api/auth/refresh`: 200 → hydrate and render; 401 → login screen. Show a
  loading state; do not flash the login page at an already-authenticated user.
- **Refresh-on-401 with single-flight.** Concurrent 401s share one in-flight refresh promise —
  and this project fires more concurrent requests than LedgerLite did (snapshot + ticket +
  comments), so the single-flight is not optional. One retry, never a loop.
- `credentials: "include"` on every `/api/auth/*` request.
- **New here:** the WebSocket ticket request is an ordinary authenticated call and goes through
  the same 401-refresh path. A socket that dies because the access token expired must recover by
  refreshing and re-ticketing, not by prompting a re-login.

**The board UI:**

- **Presence row** — the visible proof the realtime layer works, so make it good: avatars using
  the server's `avatar_color` and `display_name`, "you" marked, an overflow count past ~5.
- **Card detail** — a panel or route showing description, comments (live via `comment.created`)
  and a compose box. It must handle its card being moved *or deleted by someone else while open*:
  a `card.deleted` for the open card closes the panel with a brief explanation rather than
  rendering a ghost.
- **Activity feed** — print `summary` verbatim (Contract 5). Do not reconstruct sentences from
  `verb` + `subject`; `subject` is for linking the card, nothing more. New entries arrive via
  `activity.appended` and prepend with a subtle highlight.
- **Empty states are a real requirement**, as they were in LedgerLite: no boards, a board with no
  lists, a list with no cards, a card with no comments, a board where you are the only one online.
  None may crash on `[]`.
- **Someone else's change should be legible as theirs.** A card that moves because a teammate
  dragged it should animate, not teleport. This is the difference between "it works" and "it feels
  real-time", and it is what a portfolio reviewer actually notices.

**Tests (Vitest + Testing Library + the fake socket):** contract conformance for both stubs;
`sortByOrder` including the shared-key tie-break; optimistic move applied then settled by echo;
optimistic move rolled back on 409; duplicate `seq` dropped; gap in `seq` triggers exactly one
snapshot refetch; presence event does not advance `seq`; unknown event type ignored; heartbeat
timeout triggers reconnect; backoff schedule; 4001 refetches a ticket; 4003 routes away without
reconnecting.

Follow the `swarm-worker` runtime protocol for all shared-file, escalation, and git rules.

**Work log:**

### 2026-09-06 — Instance 2 — STATUS: DONE

Built the whole frontend against the two stubs. Never saw Instance 1's code. Everything below
lives under `frontend/`.

**What was built**

| Area | Where |
|---|---|
| Contracts 1-5, 8 as TypeScript | `src/types/contracts.ts` |
| Contract 6 (envelope, event union, close codes, timings) | `src/realtime/protocol.ts` |
| Socket client — ticket, heartbeat, dead-man timer, backoff, close codes | `src/realtime/socket.ts` |
| **The scripted fake socket** | `src/realtime/fakeSocket.ts` |
| **The mock HTTP layer** (Contracts 1-5, 8) | `src/api/mocks.ts` |
| Transport: in-memory token, single-flight 401 refresh, `X-Client-Op-Id` | `src/api/http.ts` |
| Typed endpoint surface | `src/api/endpoints.ts` |
| **The board state machine** — seq rules + reconciliation | `src/board/boardReducer.ts` |
| Contract 4's `(order_key, id)` sort + the pinning rule | `src/board/sortByOrder.ts` |
| The join: reducer + socket + mutations | `src/board/useBoard.ts` |
| Drag-and-drop canvas (`@dnd-kit`, pointer + keyboard) | `src/components/BoardCanvas.tsx` |
| Presence row, connection lamp, activity feed, card panel | `src/components/` |
| Auth / board list / board pages | `src/pages/` |

**Verification:** `npm test` — **184 tests, 6 files, all green**. `tsc --noEmit` clean under
`strict` + `noUncheckedIndexedAccess`. `npm run build` produces a working production bundle.

**Decisions worth a merger's attention**

- **`OrderKey` is a branded type.** A key cannot be constructed anywhere in the app except at the
  parse boundary (`asOrderKey`) or as the optimistic placeholder. Contract 4's "the client never
  generates a key" is enforced by the compiler, not by discipline. There is no midpoint function
  in this codebase.
- **Optimistic rows are pinned, not sorted.** A dragged card carries `PENDING_ORDER_KEY` and is
  held at its dropped array index by `sortByOrderPinningPending`; everything else sorts around it.
  Without this a moved card flings to one end and snaps back when the echo lands.
- **Optimistic rows use a negative local `id` alongside `temp_id`.** `temp_id` (`"temp:<uuid>"`)
  is the identity and is never sent to the server; reconciliation is by `client_op_id` alone. The
  negative id exists only so the row has a React key and so the numeric `(order_key, id)`
  tie-break stays total. Server ids are positive, so the spaces cannot collide.
- **The 2xx response body is applied, not just used to retire the op.** Contract 7 §2 makes the
  HTTP body and the broadcast equally authoritative. A bug found by the integration test: settling
  on the response *without applying it* left the placeholder key in place whenever the socket was
  down — which Contract 6 §6.6 explicitly allows. Both paths now apply by `id`, so applying both
  is a no-op.
- **Deletions are deliberately NOT optimistic.** Moves, creates and edits are. Removing a row and
  restoring it reads worse than a moment's wait.
- **`neighboursAt` skips unconfirmed rows.** An optimistic neighbour has no server id, so naming
  it would name a card the server has never heard of; the search walks outward to the nearest
  confirmed card.

**Contract surfaces a merger should double-check against Instance 1's real output**

1. **Envelope field names and nullability** — `seq: null` on the three ephemeral types, and
   `client_op_id` echoed *verbatim*. `src/test/contract.test.ts` asserts all seven §2 fields on
   every event type; point it at real captured frames and it either passes or names the field.
2. **`card.moved` payload** is the five-field form (`id`, `list_id`, `from_list_id`, `order_key`,
   `updated_at`) — **not** a full `<Card>`. The reducer merges those five onto the local row.
3. **`list.created`** — the client reads `payload.cards` and tolerates it being absent, but the
   contract shows a full list object with `cards: []`.
4. **Close-code behaviour on 4001.** The client retries once with a fresh ticket, then runs the
   auth-refresh flow, then falls back to backoff. If the real server sends 4001 for a reason
   other than a stale ticket, that becomes a slow loop rather than a fast one — worth one look.
5. **The snapshot's `seq`** must be the value the *next* event increments from. The client treats
   `hello.seq != local_seq` as a resync trigger, so an off-by-one here shows up as a snapshot
   refetch on every single connect.
6. **404-vs-403 on the ticket endpoint.** A 404 from `POST /api/realtime/ticket` is treated as a
   permanent denial (no retry). A 403 would be retried with backoff instead.

**Remaining ASSUMED items**

- **`comment_count` is derived client-side** on `comment.created` — no event carries an updated
  count. Raised as an OPEN escalation above; implemented as the self-healing option. Low stakes.
- **`display_name` fallback** (email local-part) is only exercised in the mock; the real server
  owns it. Display-only.
- The mock's key minting in `src/api/mocks.ts` is a **fixture generator, not Contract 4** — it is
  confined to that file and nothing in `board/`, `realtime/` or the components imports it. It
  exists so the stub has sortable data, and it is replaced wholesale at merge.

**Not done, by design:** the three ★ merge-time checks (two-browser convergence, reconnect resync
against a real process, the ticket round-trip). They need both halves running and are the
Reconciler's, per the plan. Root `README.md`, `DEPLOY.md` and `BUILT-WITH-SWARM.md` untouched —
they are merge-time artifacts.

— Instance 2, 2026-09-06

---

## MERGE-TIME ARTIFACTS & CHECKS (human / Reconciler — not assigned to any instance)

Deferred here deliberately (rule b): small, spanning both halves, and best written once both
sides are real.

1. **`BUILT-WITH-SWARM.md`** — the portfolio narrative: this coordination file, the frozen
   contracts, and the reconciliation report. LedgerLite's is the template. This run's story is the
   ordering-algorithm decision — worth writing up properly, since "we moved the algorithm to one
   side of the boundary so it could not diverge" is the most interesting engineering judgement in
   the project.
2. **`DEPLOY.md`** — the Vercel → Render → Neon runbook, extended with three realtime specifics:
   Render must run **one uvicorn worker** (the hub is in-process); `VITE_WS_BASE` points at the
   **Render origin directly**, not through Vercel, which does not proxy WebSockets; and the WS
   origin allow-list must include the Vercel production and preview domains.
3. **Root `README.md`** — update from the placeholder once the app exists.
4. **★ The two-browser convergence check** — the boundary no mock can prove. Two real browsers,
   two accounts, one board: (a) drag a card in A, confirm it moves in B within a second, with the
   same final order; (b) both clients drag *different* cards into the *same gap* as close to
   simultaneously as you can manage, and confirm both screens agree and no card is lost or
   duplicated; (c) both edit the same card title at once and confirm both converge on one value.
5. **★ The reconnect-resync check** — open a board in two browsers, kill the network on A
   (DevTools offline) for ~30 s while making five changes in B, then restore. Confirm A shows
   "Reconnecting…", reconnects with backoff, detects the `seq` gap, refetches the snapshot exactly
   once, and ends up identical to B. Then repeat by restarting the API process instead, which is
   what a Render cold start actually looks like.
6. **★ The ticket round-trip check** — confirm a real `POST /api/realtime/ticket` → WS handshake
   succeeds; that replaying the same ticket closes 4001; that a ticket for someone else's board is
   refused; and that connecting from a disallowed `Origin` is rejected at the handshake.
7. **The one-move-one-row check** — with SQL logging on, drag a card into the middle of a
   20-card list and confirm the move updates exactly one row. This is the project's whole premise;
   verify it once against the real database rather than trusting the unit tests.
