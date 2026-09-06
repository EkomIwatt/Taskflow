# TaskFlow

A real-time collaborative kanban board. Sign in, create a board, add lists and cards, and drag
cards within and between lists — every change appears on every other open client within a second,
without a refresh.

Built as a parallel two-instance [Swarm run](BUILT-WITH-SWARM.md): a backend and a frontend
developed simultaneously by two Claude Code instances that never saw each other's code, against
eight interface contracts frozen before either wrote a line.

---

## What it does

- **Live boards.** Card moves, card edits, new comments, the activity feed and a presence row
  showing who else has the board open — all pushed over one WebSocket.
- **Optimistic drag-and-drop.** A dragged card moves under your cursor immediately; the server's
  authoritative position arrives with the echo and replaces the local guess. Pointer *and*
  keyboard accessible.
- **Convergence under conflict.** Two people dragging into the same gap at the same instant land
  on the same board on both screens — no lost card, no duplicate position.
- **Recovery.** A client that drops its connection detects that it missed events and resyncs
  without a manual refresh.
- **Fractional order keys.** Inserting a card between two others writes exactly one row and never
  renumbers the list.

## Stack

| Layer | Choice |
|---|---|
| Backend | FastAPI · SQLAlchemy 2 (async) · asyncpg |
| Realtime | Native WebSocket + an in-process per-board hub (no Socket.IO) |
| Database | Postgres (Neon in production); tests run on in-memory SQLite |
| Auth | argon2 · HS256 JWT access token · httpOnly refresh cookie |
| Frontend | React 19 · Vite · TypeScript · react-router |
| Drag & drop | `@dnd-kit/core` + `@dnd-kit/sortable` |
| Tests | pytest + httpx (backend) · Vitest + Testing Library (frontend) |
| Deploy | Vercel (UI) → Render (API + WS) → Neon (Postgres) |

## Running it locally

**Backend** — needs Python 3.12 (3.9+ works for the test suite):

```bash
cd backend
python -m venv .venv && .venv/bin/pip install -r requirements-dev.txt
cp .env.example .env          # the defaults use SQLite; no services needed
.venv/bin/python -m uvicorn app.main:app --reload --workers 1
```

**Frontend:**

```bash
cd frontend
npm install
cp .env.example .env          # defaults point at localhost:8000
npm run dev
```

Open http://localhost:5173. The Vite dev proxy keeps HTTP same-origin so the refresh cookie works;
the WebSocket connects to the API directly.

**With no backend at all** — set `VITE_USE_MOCKS=true` and `VITE_USE_FAKE_SOCKET=true` in
`frontend/.env`. The whole app runs against a mock HTTP layer and a scripted socket. This is how
the entire frontend was built before the two halves ever met.

## Tests

```bash
cd backend  && .venv/bin/python -m pytest      # 227 tests
cd frontend && npm test                        # 204 tests
```

431 in total. The frontend suite includes `src/test/reconciliation.test.ts`, which replays
**frames captured from a live server** through the real client reducer — the check that neither
half could run on its own.

## Architecture notes

- **The WebSocket is broadcast-only.** Server → client carries state changes; client → server
  carries nothing but `pong`. Every mutation is an ordinary authenticated HTTP request, so
  validation, authorization, error envelopes and status codes all live on one well-understood
  channel. A client with a dead socket is stale, not read-only.
- **The server is the sole authority on order keys.** The client sends the neighbours it dropped
  between; the server computes the fractional key. The midpoint algorithm exists in exactly one
  language, in exactly one file — see [BUILT-WITH-SWARM.md](BUILT-WITH-SWARM.md), because that
  single decision is what let the project be built in parallel at all.
- **The hub is in-process**, so the API must run with **one** uvicorn worker. See
  [DEPLOY.md](DEPLOY.md).

## Documentation

- [DEPLOY.md](DEPLOY.md) — the Vercel → Render → Neon runbook
- [BUILT-WITH-SWARM.md](BUILT-WITH-SWARM.md) — how it was built in parallel, and the reconciliation report
- [CLAUDE.md](CLAUDE.md) — the coordination file and the eight frozen contracts
- [backend/README.md](backend/README.md) · [frontend/README.md](frontend/README.md)
