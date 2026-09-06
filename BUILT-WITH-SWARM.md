# Built with Swarm

TaskFlow was built by **two Claude Code instances working in parallel**, in separate git
worktrees, for the duration of the build. Neither instance ever saw the other's code. They
communicated through exactly one thing: **eight interface contracts, frozen before either wrote a
line**, in [CLAUDE.md](CLAUDE.md).

At merge the two halves — a FastAPI backend with a WebSocket hub, and a React client with
optimistic drag-and-drop — were combined and every contract was verified against both real
implementations.

**All eight contracts passed. There were no mismatches.**

This is the third run of this method (after Snipp and LedgerLite) and the first one where the
split was genuinely in question, because this project has a component that spans the seam: a
real-time protocol between two processes that must converge when two people act at the same
instant.

---

## The decision the whole project rests on

The dangerous version of TaskFlow is the one where **the card-ordering algorithm lives on both
sides of the boundary.**

Card order uses fractional (lexicographic) keys: to insert a card between two others you mint a
key that sorts strictly between their keys, write one row, and never renumber the list. The
obvious design has the client compute that key — it already knows where the user dropped the card.

That design would have been fatal to a parallel build, and it would have been fatal quietly.
`midpoint()` would have had to exist in **Python and in TypeScript**, and agree byte-for-byte,
forever. Two implementations of one algorithm, straddling the instance boundary, invisible to both
test suites — because each suite would test its own copy and both would pass. The divergence
surfaces at merge, as two clients that quietly disagree about what order the cards are in. That is
not a contract. It is a shared implementation pretending to be one.

So the decision was ratified before any contract was drafted:

> **The server is the sole authority on order keys.** The client sends the *neighbours it dropped
> between*; the server computes the key. To the client, `order_key` is an **opaque sortable
> string** — it stores it and compares it, and never generates, parses, splits, measures or does
> arithmetic on one.

That one move collapses the hardest part of the project into an ordinary producer/consumer
contract. **Instance 2 cannot get the ordering algorithm wrong, because Instance 2 does not have
the ordering algorithm.**

It held. At merge, the frontend contains no midpoint function — and cannot, because `OrderKey` is
a branded TypeScript type that can only be constructed at the parse boundary where server data
arrives. Instance 2 enforced the contract with the compiler rather than with discipline. The
algorithm exists once, in `backend/app/ordering.py`, property-tested across thousands of random
insert sequences including the pathological always-into-the-same-gap case that a naive midpoint
implementation gets wrong around iteration 40.

---

## How the work was split

**Two instances. The seam is the process boundary: server vs. client.**

| | Instance 1 | Instance 2 |
|---|---|---|
| Owns | `backend/` in full | `frontend/` in full |
| Produces | Contracts 1–8 | none |
| Consumes | none | Contracts 1–8 |
| Built against | the real database | a mock HTTP layer **and a scripted fake socket** |

Two components that looked like candidates for their own instance were deliberately folded in:

- **The WebSocket hub** folds into Instance 1. It is not a service — it lives inside the FastAPI
  process, shares the session lifecycle and the auth dependency, and every mutating route emits
  into it at its own transaction boundary. Handing it to a third instance would have meant handing
  Instance 1 real importable Python instead of a stubbable JSON contract.
- **The socket client** folds into Instance 2, for the mirror-image reason: it feeds the same React
  state the drag handlers mutate, and the optimistic-reconciliation logic *is* the join between
  them.

What crosses the seam is the protocol, and the protocol is Contract 6.

The most valuable thing Instance 2 built was not a feature. It was
`src/realtime/fakeSocket.ts` — a scripted socket it could drive at will: emit any contract
envelope, deliver duplicates, skip a `seq` to force a gap, go silent to trip the 60-second
heartbeat timer, close with any code. Every resilience rule in Contract 6 §6 was testable against
it *before the real server existed*.

---

## What the contracts could not prove

Three boundaries were identified in advance as unprovable until merge, and written into the plan
as ★ checks rather than discovered late:

1. **Convergence under concurrent drags** — a fake socket replays scripted events; it cannot prove
   a real server receiving two moves into the same gap milliseconds apart serializes them into two
   distinct keys.
2. **Reconnect resync** — neither side can prove that a genuinely dropped connection during a burst
   of real edits recovers cleanly.
3. **The WebSocket ticket round-trip** — browsers cannot set an `Authorization` header on a
   WebSocket, so the socket authenticates with a short-lived single-use ticket. Mocks can simulate
   both halves; only a real origin proves the handshake.

Naming these in advance is the point. They were the merge agenda, not merge surprises.

---

## The reconciliation

Merged in dependency order — producer before consumer — one commit each.

**The only conflict in the entire merge was the coordination file**, where both instances had
appended to the escalations section. No source file conflicted; disjoint ownership held exactly.
The frozen contract block was verified byte-identical to the pre-build commit: neither instance
had edited the specification to match its own implementation, which is the failure mode the freeze
exists to prevent.

### Verifying the contracts against real code

Reading both sides and comparing them is necessary but weak — it proves the two *look* compatible.
So the merged stack was run for real: a live server, two accounts, one board, **two real WebSocket
clients**. Every frame the second client received was captured verbatim, then replayed through
Instance 2's own protocol guards and board reducer.

That test is now committed as `frontend/src/test/reconciliation.test.ts`. It asserts, on real
server output:

- every frame passes the client's own `isEnvelope` guard and carries all seven envelope fields;
- the server emits no event type the client does not know;
- ephemeral events carry `seq: null` and state events carry a number;
- the real `seq` stream is contiguous, so the client's strict `local_seq + 1` rule never trips a
  false gap;
- **applying the real stream reproduces the server's own authoritative board order.**

| Contract | Verdict |
|---|---|
| 1 · Authentication | PASS |
| 2 · Boards & membership | PASS |
| 3 · Lists & cards | PASS |
| 4 · Fractional order keys | PASS |
| 5 · Comments & activity | PASS |
| 6 · WebSocket protocol | PASS |
| 7 · Optimistic UI & reconciliation | PASS |
| 8 · Errors, status codes & CORS | PASS |

The two highest-risk pairings both held. `hello.seq` and the snapshot's `seq` are the same value —
an off-by-one there would have caused a snapshot refetch on *every single connect*, a bug that
degrades gracefully enough to ship unnoticed. And `seq` advances by **two** per mutation (the
domain event plus its `activity.appended`), which is harmless precisely because both are
seq-bearing state events, so the client sees a contiguous stream. Neither instance could have
confirmed either fact alone.

### The ★ checks

- **★ One move, one row — PROVEN.** A card dragged into the middle of a 20-card list changed
  exactly one `order_key`. This is the project's entire premise, verified against a real database
  rather than trusted from unit tests.
- **★ Concurrent same-gap moves — PROVEN, headlessly and then in two real browsers.** Headlessly:
  two clients moved different cards into the same gap simultaneously and got two distinct keys,
  no card lost or duplicated, both snapshots identical. Then for real — two browsers, two
  accounts, two people dragging into the gap between `Alpha[a0]` and `Beta[a1]` at the same
  moment:

  ```
  To Do:  Alpha[a0]   Delta[a0V]   Epsilon[a0k]   Beta[a1]
  ```

  Both cards landed in the contested gap with distinct keys, each sorting strictly between the
  neighbours; zero duplicate `(list, order_key)` pairs; every card still present exactly once.
  **Both screens agreed.** Note that these keys differ from the headless run's `a0F`/`a0V` for the
  same scenario — which is the point. The exact key, and which of the two cards ends up first,
  depend on arrival order and are deliberately unspecified. What the contract requires is only
  that both clients agree, and they did.
- **★ Reconnect resync — PROVEN.** A real socket was killed, five edits were made while it was
  down, and it reconnected with a fresh ticket: `hello.seq=15` against a stale `local_seq=5`.
  Feeding that real `hello` to the real reducer trips exactly one resync.
- **★ Ticket round-trip — PROVEN.** Real handshake succeeds; a replayed ticket closes 4001; a
  ticket for someone else's board is 404; a disallowed `Origin` is refused at the handshake.

Propagation was confirmed in the same session: a card dragged in one browser appeared in the
other within a second, animated rather than teleported, and the activity feed printed the
server's own sentence — "ekom moved Gamma from To Do to Doing" — verbatim.

**Concurrent edits to the same card title — PROVEN.** Two users PATCHed the same field of the
same card simultaneously while two real WebSocket clients watched. Both writes were accepted (no
lock, no 409), both clients received both `card.updated` events at seq **38 and 40** in identical
order, each echo carried its own originating `client_op_id`, and both converged on the same final
title — the server's authoritative value. The losing write was overwritten wholesale, not merged:
last-write-wins at the field level, exactly as Contract 7 §6 specifies, with no CRDT and no vector
clocks.

The seq pair being 38 and 40 rather than 38 and 39 is the "two seqs per mutation" property in the
wild: each edit emits its `card.updated` plus an `activity.appended`.

To be precise about the scope of that one: it was verified at the protocol level, through two real
sockets against the live server, rather than by watching two browser windows. The step from
"both clients converge on the same value" to "both screens show it" is the reducer, which the
merge-time reconciliation test already drives with real captured frames.

### The bug the 427 tests did not catch

The two-browser check was worth running, and here is the evidence: the first time anyone started
the dev server against the real backend, **the app hung forever on "Restoring your session…".**

The cause was entirely inside the frontend, in two individually-sensible guards that were mutually
destructive. A `booted` ref allowed exactly one boot refresh, so React StrictMode's double-invoke
could not rotate the refresh cookie twice. A `cancelled` flag in the effect's cleanup discarded
late results. But StrictMode runs the first invocation's cleanup *before* the second invocation,
and the ref makes that second invocation a no-op — so the flag cancelled the only request that was
ever issued, and the boot state never resolved.

What makes it worth writing down is why nothing had caught it. StrictMode's double-invoke is
**dev-only**: the production build was unaffected, so `npm run build` was clean. No test rendered
the provider inside `<StrictMode>`, so Vitest was clean. And Instance 2 could not run the dev
server end-to-end against a real API, because it did not have one — that was the whole premise of
the parallel build. The bug required a real server *and* a real browser *and* dev mode at once, a
combination that first existed at merge.

It was **not** a contract mismatch. All eight contracts still held; this was React lifecycle code
that never touched the wire. But it is the clearest argument in this project for scoping the ★
checks in advance rather than treating a green test suite as proof of a working system. 427
passing tests, a clean typecheck and a clean production build all agreed the app was fine. Opening
it in a browser disagreed.

The fix removes the redundant flag — the ref alone already guarantees a single boot — and adds
`frontend/src/auth/AuthContext.test.tsx`, which renders the provider inside `<StrictMode>`. All
four of its tests fail against the previous code, which is the only thing that makes them worth
having.

### Two gaps in the contracts themselves

Both instances filed an escalation rather than patching around a contract they thought was wrong.
Both were resolved by the human at merge, and both turned out to be **underspecification, not
divergence** — the two implementations agreed; the specification had simply not said what should
happen.

1. **Contract 4's invariant I2 had no escape hatch for a board's lists.** `list.rebalanced`
   renormalises the cards inside a list, but nothing covers the board's *list* ordering. Instance 1
   shipped a 409 + client-refetch fallback and filed the gap, explicitly declining to invent an
   unratified `board.rebalanced` event — because shipping a state event the client had no handler
   for would have let list order diverge silently on every connected client, which is worse than
   the failure it fixed. **Resolved:** I2 narrowed to cards; the 409 path ratified. Zero code
   change — it already worked end-to-end.
2. **`comment_count` has no broadcast carrying an updated value.** Both instances found this
   independently, from opposite sides — good evidence a gap is real rather than a misreading.
   **Resolved:** client-side derivation ratified, with an asymmetry neither escalation had stated
   now documented explicitly: comment *deletion* broadcasts nothing at all, so the count goes stale
   downward too. The count is display-only and eventually consistent, and it is written down as
   such rather than left as a silent surprise.

That an instance chose to file and keep building, rather than quietly "improve" a frozen contract,
is the behaviour the method depends on. Both did it.

---

## Result

**431 tests green** — 227 backend, 204 frontend, `tsc --noEmit` clean. The production
Docker image builds, and the ★ checks above were run against a live stack.

Two halves of a real-time system, written simultaneously by two agents who never read each other's
code, that agreed on first contact — verified by two people dragging cards into the same gap at
the same moment and landing on the same board.

The reason is not that the agents were careful. It is that **the one algorithm that could have
diverged was placed where it could only exist once.**
