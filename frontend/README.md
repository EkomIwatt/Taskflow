# TaskFlow — frontend

React 19 + Vite + TypeScript. The board UI, the drag-and-drop layer, and the
WebSocket client for TaskFlow's realtime kanban board.

This half **consumes** Contracts 1–8 (see the root `CLAUDE.md`) and produces
none. It was built entirely against two stubs, without ever seeing the backend.

---

## Running it

```bash
npm install
cp .env.example .env      # then edit
npm run dev               # http://localhost:5173
```

| Command | What it does |
|---|---|
| `npm run dev` | Vite dev server, proxying `/api` and `/ws` to `localhost:8000` |
| `npm run build` | `tsc -b` then a production build into `dist/` |
| `npm test` | The whole Vitest suite |
| `npm run test:watch` | Vitest in watch mode |
| `npm run typecheck` | `tsc --noEmit` |

### Running with no backend at all

Both stubs are env-flagged, so the entire app runs standalone:

```bash
VITE_USE_MOCKS=true VITE_USE_FAKE_SOCKET=true npm run dev
```

`src/api/mocks.ts` serves Contracts 1–5 and 8 from memory and seeds a board
("Launch", three lists, five cards, one comment, three activity entries). The
console prints the seeded credentials — `ekom@example.com` / `password123`.
`ada@example.com` and `chidi@example.com` share that password if you want a
second account to invite.

### Configuration

| Variable | Meaning |
|---|---|
| `VITE_API_BASE` | HTTP base URL. **Empty in dev** — the Vite proxy keeps everything same-origin so the httpOnly refresh cookie round-trips. In production, the Render API origin. |
| `VITE_WS_BASE` | WebSocket origin (Contract 6 §1). `ws://localhost:8000` in dev; in production the **Render origin directly**. |
| `VITE_USE_MOCKS` | `true` serves the HTTP layer from `src/api/mocks.ts`. |
| `VITE_USE_FAKE_SOCKET` | `true` replaces the native WebSocket with `src/realtime/fakeSocket.ts`. |

> **Deployment note.** `VITE_WS_BASE` is **not** derived from the page's origin.
> Vercel does not proxy WebSockets, so the browser connects to Render directly
> and the WS origin is deliberately a separate setting. The backend's WS-origin
> allow-list must therefore include the Vercel production **and preview**
> domains.

---

## How it is put together

```
src/
  types/contracts.ts     Contracts 1-5, 8 transcribed to TypeScript
  realtime/
    protocol.ts          Contract 6: envelope, event union, close codes, timings
    socket.ts            RealtimeClient — ticket, heartbeat, backoff, close codes
    fakeSocket.ts        the scripted socket (the main test asset)
  api/
    http.ts              transport: in-memory token, single-flight 401 refresh
    endpoints.ts         one function per contract endpoint
    mocks.ts             the mock HTTP layer
  board/
    types.ts             BoardState, LocalCard, PendingOp
    boardReducer.ts      THE state machine: seq rules + reconciliation
    sortByOrder.ts       Contract 4's binding (order_key, id) sort
    useBoard.ts          the join: reducer + socket + mutations
  components/            canvas, card panel, presence, activity feed
  pages/                 auth, board list, board
```

### Four things worth knowing before changing anything

**1. `order_key` is opaque, and the type system enforces it.**
`OrderKey` is a branded string. You cannot produce one from a literal anywhere
outside the parse boundary (`asOrderKey`, used only when decoding server data)
or the optimistic placeholder. There is no `midpoint()` in this codebase and
there must never be one — the ordering algorithm lives in exactly one language
in exactly one codebase, which is what lets the two halves of this project be
built in parallel without diverging. If you find yourself wanting to compute a
key here, that is an escalation, not a patch.

**2. Optimistic rows are pinned, not sorted.**
A dragged card is spliced into its new array index carrying
`PENDING_ORDER_KEY`. `sortByOrderPinningPending` holds it at that index while
sorting everything else around it, so it does not fling to one end of the list
and snap back when the echo arrives. Once the authoritative key lands, the
function collapses to a plain `sortByOrder`.

**3. Everything settles by `client_op_id`, never by matching content.**
An optimistic row is retired when a broadcast carries its op id, or when its
HTTP response resolves — whichever is first. Both paths apply the authoritative
object by `id`, so applying both is a no-op. Two people creating a same-titled
card at the same instant do not eat each other's optimistic rows.

**4. One reducer owns `seq`.**
`boardReducer` is the only place the gap rule exists: `+1` applies, `<=` drops
silently, `> +1` raises `needsResync`. It is pure, so it cannot fetch —
`useBoard` watches the flag and performs **exactly one** snapshot refetch,
clearing the flag first so a burst of gapped events cannot queue a second.

---

## Tests

```bash
npm test        # 184 tests
```

| File | Covers |
|---|---|
| `test/contract.test.ts` | **Contract conformance** — both stubs asserted field-for-field against the frozen shapes, including the error envelope and every WebSocket envelope |
| `board/sortByOrder.test.ts` | the `(order_key, id)` sort, incl. **two cards sharing a key**, and the pinning rule |
| `board/boardReducer.test.ts` | the seq gate, ephemeral events, `hello`, optimistic apply/settle/rollback, rebalance, panel behaviour |
| `realtime/socket.test.ts` | heartbeat, the 60 s dead-man timer, the backoff schedule, every close code, ticket single-use |
| `board/useBoard.test.tsx` | the three layers wired together: gap → **exactly one** refetch, move settled by echo, move rolled back on 409 |
| `components/ui.test.tsx` | drop resolution, presence overflow, `summary` printed verbatim, empty states |

The fake socket is the reason most of this is testable: it emits any contract
envelope on demand, delivers duplicates, skips a `seq` to force a gap, goes
silent to trip the heartbeat, and closes with any code from Contract 6 §5.

---

## What this half cannot prove

Three boundaries need both real processes, and are written up as ★ checks at the
bottom of the root `CLAUDE.md`:

1. **Convergence under concurrent drags.** A scripted socket cannot prove that a
   real server receiving two moves into the same gap milliseconds apart mints
   two distinct keys and that both browsers land on the same order.
2. **Reconnect resync.** The gap rule is tested against a socket that can be
   silenced at will; a genuinely dropped connection during a burst of real edits
   is a different thing.
3. **The ticket round-trip.** Only a real origin proves the handshake, that
   replaying a ticket closes 4001, and that a disallowed `Origin` is rejected.

## Known assumptions

- **`comment_count` is derived on `comment.created`.** No contract event carries
  an updated count, so the client increments the card's own counter when a
  comment arrives. Self-healing — the next snapshot restores the server's value.
  Raised as a non-blocking escalation in `CLAUDE.md`.
- **Deletions are not optimistic.** Removing a row and putting it back reads
  worse than a moment's wait. Moves, creates and edits are optimistic; deletes
  wait for the server.

## Accessibility

Dragging works from the keyboard: `Tab` to a card, `Space` to lift, arrow keys
to move, `Space` to drop, `Escape` to cancel — `@dnd-kit`'s keyboard sensor with
live-region announcements. `Enter` on a card opens its detail panel. The
connection lamp is a live region, and `prefers-reduced-motion` disables the
remote-change animation while keeping the colour, which is what actually carries
the meaning.
