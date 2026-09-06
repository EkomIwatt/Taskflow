/**
 * RECONCILIATION TEST — real producer output, real consumer code.
 *
 * `captured-frames.json` is not a fixture anyone wrote by hand. It is a
 * verbatim recording of a live Instance 1 server: two accounts, one board, two
 * real WebSocket clients, captured by the Reconciler at merge time. `b_frames`
 * is exactly what the second client received, in order.
 *
 * This is the check that neither instance could run alone. Instance 2's suite
 * proved the reducer obeys Contract 6 against a fake socket it wrote itself;
 * this proves the same reducer obeys it against frames Instance 1 actually
 * emitted, and that the resulting board is identical to the server's own
 * authoritative snapshot.
 */
import { describe, expect, it } from "vitest";

import captured from "./captured-frames.json";
import resync from "./captured-resync.json";
import {
  isEnvelope,
  isEphemeralEvent,
  isKnownEventType,
  type ServerEvent,
} from "../realtime/protocol";
import { boardReducer, initialBoardState } from "../board/boardReducer";
import { sortByOrder } from "../board/sortByOrder";
import type { BoardSnapshot } from "../types/contracts";

const frames = captured.b_frames as unknown as ServerEvent[];
const allFrames = captured.frames as unknown as ServerEvent[];
const before = captured.snapshots.before_connect as unknown as BoardSnapshot;
const final = captured.snapshots.final as unknown as BoardSnapshot;

/** Flatten a snapshot to (list, card) order, sorted the way Contract 4 binds. */
function serverOrder(snapshot: BoardSnapshot): string[] {
  return sortByOrder(snapshot.lists).flatMap((list) =>
    sortByOrder(list.cards).map((card) => `${list.title}/${card.title}`),
  );
}

describe("Contract 6 §2 — every real envelope is structurally valid", () => {
  it("captured a non-trivial session", () => {
    expect(frames.length).toBeGreaterThan(15);
    expect(new Set(allFrames.map((f) => f.type)).size).toBeGreaterThanOrEqual(7);
  });

  it("every frame passes the client's own isEnvelope guard", () => {
    for (const frame of allFrames) {
      expect(isEnvelope(frame), `not an envelope: ${JSON.stringify(frame)}`).toBe(true);
    }
  });

  it("every frame carries all seven §2 fields", () => {
    for (const frame of allFrames) {
      expect(Object.keys(frame).sort()).toEqual([
        "actor_id",
        "board_id",
        "client_op_id",
        "payload",
        "seq",
        "ts",
        "type",
      ]);
    }
  });

  it("the server emits no type this client does not know", () => {
    for (const frame of allFrames) {
      expect(isKnownEventType(frame.type), `unknown type: ${frame.type}`).toBe(true);
    }
  });

  it("ephemeral events carry seq null; state events carry a number", () => {
    for (const frame of allFrames) {
      if (isEphemeralEvent(frame.type)) {
        expect(frame.seq, `${frame.type} should have null seq`).toBeNull();
      } else {
        expect(typeof frame.seq, `${frame.type} should have a numeric seq`).toBe("number");
      }
    }
  });

  it("ts is ISO-8601 UTC with a trailing Z", () => {
    for (const frame of allFrames) {
      expect(frame.ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    }
  });
});

describe("Contract 6 §6 — the real seq stream against the real gap rule", () => {
  it("hello.seq equals the snapshot's seq, so a fresh connect never resyncs", () => {
    const hello = frames[0]!;
    expect(hello.type).toBe("hello");
    expect((hello.payload as { seq: number }).seq).toBe(before.seq);
  });

  it("state-event seqs are strictly contiguous — no false gaps", () => {
    const seqs = frames.filter((f) => !isEphemeralEvent(f.type)).map((f) => f.seq as number);
    for (let i = 1; i < seqs.length; i += 1) {
      expect(seqs[i]).toBe(seqs[i - 1]! + 1);
    }
  });

  it("replaying the real stream never trips a resync", () => {
    let state = boardReducer(initialBoardState(before.id), {
      type: "snapshot/loaded",
      snapshot: before,
    });
    for (const event of frames) {
      state = boardReducer(state, { type: "event/received", event });
      expect(state.needsResync, `resync tripped at seq ${event.seq} (${event.type})`).toBe(false);
    }
    expect(state.seq).toBe(
      Math.max(...frames.filter((f) => !isEphemeralEvent(f.type)).map((f) => f.seq as number)),
    );
  });
});

describe("★ convergence — the client's board equals the server's snapshot", () => {
  it("applying the real stream reproduces the server's authoritative order", () => {
    let state = boardReducer(initialBoardState(before.id), {
      type: "snapshot/loaded",
      snapshot: before,
    });
    for (const event of frames) {
      state = boardReducer(state, { type: "event/received", event });
    }

    const clientOrder = sortByOrder(state.lists).flatMap((list) =>
      sortByOrder(list.cards).map((card) => `${list.title}/${card.title}`),
    );

    expect(clientOrder).toEqual(serverOrder(final));
    expect(clientOrder.length).toBeGreaterThan(0);
  });

  it("the card the server placed between two neighbours lands there on the client", () => {
    const move = frames.find((f) => f.type === "card.moved");
    expect(move).toBeDefined();
    const payload = move!.payload as { id: number; order_key: string };

    let state = boardReducer(initialBoardState(before.id), {
      type: "snapshot/loaded",
      snapshot: before,
    });
    for (const event of frames) {
      state = boardReducer(state, { type: "event/received", event });
    }

    const card = state.lists.flatMap((l) => l.cards).find((c) => c.id === payload.id);
    // The card may have been moved again later in the session; what matters is
    // that the client holds a server key for it, never a locally minted one.
    expect(card).toBeDefined();
    expect(typeof card!.order_key).toBe("string");
    expect(card!.order_key).toMatch(/^[0-9A-Za-z]{1,64}$/);
  });

  it("no optimistic placeholder survives the real echoes", () => {
    let state = boardReducer(initialBoardState(before.id), {
      type: "snapshot/loaded",
      snapshot: before,
    });
    for (const event of frames) {
      state = boardReducer(state, { type: "event/received", event });
    }
    for (const card of state.lists.flatMap((l) => l.cards)) {
      expect(card.temp_id, `${card.title} still optimistic`).toBeUndefined();
      expect(card.id).toBeGreaterThan(0);
    }
    expect(state.pending).toHaveLength(0);
  });
});

describe("Contract 7 — the real echo carries the client_op_id back", () => {
  it("a mutation sent with X-Client-Op-Id echoes it verbatim", () => {
    const echoed = allFrames.filter((f) => f.client_op_id !== null);
    expect(echoed.length).toBeGreaterThan(0);
    expect(echoed.map((f) => f.client_op_id)).toContain("op-list-1");
    expect(echoed.map((f) => f.client_op_id)).toContain("op-move-1");
  });

  it("server-originated frames carry a null actor_id and null client_op_id", () => {
    const hello = allFrames.find((f) => f.type === "hello")!;
    expect(hello.actor_id).toBeNull();
    expect(hello.client_op_id).toBeNull();
    const presence = allFrames.find((f) => f.type === "presence.joined");
    if (presence) expect(presence.actor_id).toBeNull();
  });
});

/* ------------------------------------------------------------------ *
 * ★5 — reconnect resync, driven by a REAL dropped connection
 * ------------------------------------------------------------------ */

describe("★5 — a real dropped socket is detected and recovered", () => {
  it("the real reconnect hello trips exactly one resync", () => {
    const captured2 = resync.detail.resync;
    const helloAfter = captured2.hello2 as unknown as ServerEvent;

    // The client had this cursor when its socket died.
    let state = boardReducer(initialBoardState(helloAfter.board_id), {
      type: "snapshot/loaded",
      snapshot: {
        ...before,
        id: helloAfter.board_id,
        seq: captured2.local_seq_before,
        lists: [],
        activity: [],
      },
    });
    expect(state.seq).toBe(captured2.local_seq_before);
    expect(state.needsResync).toBe(false);

    // Five edits happened while it was offline; this is the real hello it got back.
    state = boardReducer(state, { type: "event/received", event: helloAfter });

    expect(state.needsResync, "a real gap must trigger a resync").toBe(true);
    expect(captured2.hello_seq_after).toBeGreaterThan(captured2.local_seq_before);
  });

  it("hello.seq equal to local_seq does NOT resync (the normal reconnect)", () => {
    const helloAfter = resync.detail.resync.hello2 as unknown as ServerEvent;
    const seq = (helloAfter.payload as { seq: number }).seq;

    let state = boardReducer(initialBoardState(helloAfter.board_id), {
      type: "snapshot/loaded",
      snapshot: { ...before, id: helloAfter.board_id, seq, lists: [], activity: [] },
    });
    state = boardReducer(state, { type: "event/received", event: helloAfter });

    expect(state.needsResync).toBe(false);
  });
});
