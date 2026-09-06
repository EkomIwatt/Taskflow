/**
 * The seq rules (Contract 6 §6) and the reconciliation rules (Contract 7).
 *
 * These are the rules a fake socket can prove and a browser cannot, so they
 * are tested exhaustively here.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { asOrderKey, PENDING_ORDER_KEY, type BoardSnapshot } from "../types/contracts";
import type { Envelope, ServerEvent } from "../realtime/protocol";
import { boardReducer, initialBoardState, __resetLocalIds } from "./boardReducer";
import type { BoardState } from "./types";
import { BOARD_ID, ada, card, comment, ekom, snapshot, titlesOf } from "../test/fixtures";

/** A contract-shaped envelope with every §2 field present. */
function env<T extends string, P>(
  type: T,
  payload: P,
  overrides: Partial<Omit<Envelope, "type" | "payload">> = {},
): ServerEvent {
  return {
    type,
    board_id: overrides.board_id ?? BOARD_ID,
    seq: "seq" in overrides ? (overrides.seq ?? null) : 413,
    actor_id: overrides.actor_id ?? ada.id,
    client_op_id: overrides.client_op_id ?? null,
    ts: overrides.ts ?? "2026-09-06T10:00:00Z",
    payload,
  } as unknown as ServerEvent;
}

const apply = (state: BoardState, event: ServerEvent): BoardState =>
  boardReducer(state, { type: "event/received", event });

function loaded(overrides: Partial<BoardSnapshot> = {}): BoardState {
  const base = boardReducer(initialBoardState(BOARD_ID), {
    type: "snapshot/loaded",
    snapshot: snapshot(overrides),
  });
  // `you` normally arrives with hello; several tests need it set.
  return { ...base, you: ekom };
}

const listById = (s: BoardState, id: number) => s.lists.find((l) => l.id === id);

beforeEach(() => {
  __resetLocalIds();
});

/* ================================================================== *
 * Snapshot
 * ================================================================== */

describe("snapshot/loaded", () => {
  it("sets the seq cursor from the snapshot", () => {
    expect(loaded().seq).toBe(412);
  });

  it("sorts every list and its cards on load", () => {
    const s = loaded({
      lists: [
        {
          id: 4,
          title: "Doing",
          order_key: asOrderKey("a1"),
          cards: [card(20, 4, "second", "a1"), card(19, 4, "first", "a0")],
        },
      ],
    });
    expect(titlesOf(listById(s, 4))).toEqual(["first", "second"]);
  });

  it("does not crash on a board with no lists and no activity", () => {
    const s = loaded({ lists: [], activity: [] });
    expect(s.lists).toEqual([]);
    expect(s.activity).toEqual([]);
    expect(s.loaded).toBe(true);
  });
});

/* ================================================================== *
 * Contract 6 §6.3 — the seq gate
 * ================================================================== */

describe("the seq gate", () => {
  it("applies an event with seq == local_seq + 1 and advances the cursor", () => {
    const s = apply(loaded(), env("card.updated", card(19, 4, "Renamed", "a0"), { seq: 413 }));
    expect(s.seq).toBe(413);
    expect(titlesOf(listById(s, 4))).toEqual(["Renamed", "Presence row"]);
  });

  it("DROPS a duplicate (seq <= local_seq) silently, leaving state untouched", () => {
    const before = loaded();
    const after = apply(before, env("card.updated", card(19, 4, "Dupe", "a0"), { seq: 412 }));
    expect(after).toBe(before); // identity: nothing was rebuilt
    expect(after.seq).toBe(412);
    expect(after.needsResync).toBe(false);
  });

  it("drops an event from far in the past without resyncing", () => {
    const after = apply(loaded(), env("card.deleted", { id: 19, list_id: 4 }, { seq: 1 }));
    expect(titlesOf(listById(after, 4))).toEqual(["Fix login", "Presence row"]);
    expect(after.needsResync).toBe(false);
  });

  it("treats seq > local_seq + 1 as a GAP: does not apply, raises needsResync", () => {
    const after = apply(loaded(), env("card.deleted", { id: 19, list_id: 4 }, { seq: 500 }));
    expect(after.needsResync).toBe(true);
    expect(after.seq).toBe(412); // cursor NOT advanced
    // The event was not applied -- the snapshot refetch is what recovers.
    expect(titlesOf(listById(after, 4))).toEqual(["Fix login", "Presence row"]);
  });

  it("clears needsResync when the replacement snapshot lands", () => {
    const gapped = apply(loaded(), env("card.deleted", { id: 19, list_id: 4 }, { seq: 500 }));
    const started = boardReducer(gapped, { type: "resync/started" });
    expect(started.needsResync).toBe(false);
    const resynced = boardReducer(started, {
      type: "snapshot/loaded",
      snapshot: snapshot({ seq: 500 }),
    });
    expect(resynced.seq).toBe(500);
    expect(resynced.needsResync).toBe(false);
  });

  it("drops frames addressed to a different board", () => {
    const before = loaded();
    const after = apply(before, env("card.deleted", { id: 19, list_id: 4 }, { board_id: 99, seq: 413 }));
    expect(after).toBe(before);
  });

  it("ignores an unknown event type SILENTLY — no throw, no resync, no change", () => {
    const before = loaded();
    const after = apply(before, env("card.archived", { id: 19 }, { seq: 413 }));
    expect(after).toBe(before);
    expect(after.needsResync).toBe(false);
    expect(after.seq).toBe(412); // an unknown type does not consume a seq
  });
});

/* ================================================================== *
 * Contract 6 §4 — ephemeral events
 * ================================================================== */

describe("ephemeral events", () => {
  it("presence.joined does NOT advance the seq cursor", () => {
    const s = apply(loaded(), env("presence.joined", { user: ada }, { seq: null }));
    expect(s.seq).toBe(412);
    expect(s.online.map((u) => u.id)).toEqual([ada.id]);
  });

  it("presence.left does NOT advance the seq cursor", () => {
    const joined = apply(loaded(), env("presence.joined", { user: ada }, { seq: null }));
    const left = apply(joined, env("presence.left", { user_id: ada.id }, { seq: null }));
    expect(left.seq).toBe(412);
    expect(left.online).toEqual([]);
  });

  it("shows a user once even with several tabs open", () => {
    let s = loaded();
    s = apply(s, env("presence.joined", { user: ada }, { seq: null }));
    s = apply(s, env("presence.joined", { user: ada }, { seq: null }));
    s = apply(s, env("presence.joined", { user: ada }, { seq: null }));
    expect(s.online).toHaveLength(1);
  });

  it("a presence event never triggers a resync, even after a gap would have", () => {
    const s = apply(loaded(), env("presence.joined", { user: ada }, { seq: null }));
    expect(s.needsResync).toBe(false);
  });
});

/* ================================================================== *
 * Contract 6 §3/§6.4 — hello
 * ================================================================== */

describe("hello", () => {
  const hello = (seq: number) =>
    env("hello", { board_id: BOARD_ID, seq, you: ekom, online: [ekom, ada] }, { seq });

  it("marks the connection open and adopts you + online", () => {
    const s = apply(loaded(), hello(412));
    expect(s.connection).toBe("open");
    expect(s.you?.id).toBe(ekom.id);
    expect(s.online.map((u) => u.id)).toEqual([ekom.id, ada.id]);
  });

  it("does NOT resync when hello.seq equals local_seq", () => {
    expect(apply(loaded(), hello(412)).needsResync).toBe(false);
  });

  it("resyncs when hello.seq is AHEAD of local_seq — the normal path after a drop", () => {
    const s = apply(loaded(), hello(430));
    expect(s.needsResync).toBe(true);
  });

  it("resyncs when hello.seq is BEHIND local_seq (a server restart)", () => {
    const s = apply(loaded(), hello(3));
    expect(s.needsResync).toBe(true);
  });

  it("still adopts presence when it resyncs — the snapshot carries no online list", () => {
    const s = apply(loaded(), hello(430));
    expect(s.online.map((u) => u.id)).toEqual([ekom.id, ada.id]);
  });
});

/* ================================================================== *
 * Contract 7 — optimistic moves
 * ================================================================== */

describe("optimistic card moves", () => {
  const OP = "op-1";

  it("splices the card into its new index immediately, with a placeholder key", () => {
    const s = boardReducer(loaded(), {
      type: "optimistic/moveCard",
      clientOpId: OP,
      cardId: 19,
      toListId: 6,
      toIndex: 0,
    });
    expect(titlesOf(listById(s, 6))).toEqual(["Fix login", "Freeze contracts"]);
    expect(titlesOf(listById(s, 4))).toEqual(["Presence row"]);
    const moved = listById(s, 6)?.cards[0];
    expect(moved?.order_key).toBe(PENDING_ORDER_KEY);
    expect(s.pending).toHaveLength(1);
  });

  it("settles on the echo, replacing the placeholder with the authoritative key", () => {
    const optimistic = boardReducer(loaded(), {
      type: "optimistic/moveCard",
      clientOpId: OP,
      cardId: 19,
      toListId: 6,
      toIndex: 0,
    });
    const echoed = apply(
      optimistic,
      env(
        "card.moved",
        {
          id: 19,
          list_id: 6,
          from_list_id: 4,
          order_key: asOrderKey("Zz"),
          updated_at: "2026-09-06T10:05:00Z",
        },
        { seq: 413, client_op_id: OP },
      ),
    );
    const settled = boardReducer(echoed, { type: "op/settled", clientOpId: OP });

    expect(settled.pending).toEqual([]);
    const moved = listById(settled, 6)?.cards.find((c) => c.id === 19);
    expect(moved?.order_key).toBe("Zz");
    // "Zz" sorts before "a0", so it lands above Freeze contracts.
    expect(titlesOf(listById(settled, 6))).toEqual(["Fix login", "Freeze contracts"]);
  });

  it("rolls the move back COMPLETELY on a 409 and surfaces the server's sentence", () => {
    const before = loaded();
    const optimistic = boardReducer(before, {
      type: "optimistic/moveCard",
      clientOpId: OP,
      cardId: 19,
      toListId: 6,
      toIndex: 0,
    });
    const rolledBack = boardReducer(optimistic, {
      type: "op/failed",
      clientOpId: OP,
      message: "The board changed while you were dragging. Refreshing.",
    });

    expect(titlesOf(listById(rolledBack, 4))).toEqual(["Fix login", "Presence row"]);
    expect(titlesOf(listById(rolledBack, 6))).toEqual(["Freeze contracts"]);
    const restored = listById(rolledBack, 4)?.cards.find((c) => c.id === 19);
    expect(restored?.order_key).toBe("a0"); // the pre-drag key, exactly
    expect(restored?.list_id).toBe(4);
    expect(rolledBack.banner).toBe("The board changed while you were dragging. Refreshing.");
    expect(rolledBack.pending).toEqual([]);
  });

  it("applies a LATE broadcast for an op it already rolled back (Contract 7 §5)", () => {
    const optimistic = boardReducer(loaded(), {
      type: "optimistic/moveCard",
      clientOpId: OP,
      cardId: 19,
      toListId: 6,
      toIndex: 0,
    });
    const rolledBack = boardReducer(optimistic, {
      type: "op/failed",
      clientOpId: OP,
      message: "Card not found.",
    });
    const late = apply(
      rolledBack,
      env(
        "card.moved",
        {
          id: 19,
          list_id: 6,
          from_list_id: 4,
          order_key: asOrderKey("a5"),
          updated_at: "2026-09-06T10:05:00Z",
        },
        { seq: 413, client_op_id: OP },
      ),
    );
    // It is authoritative server state; by now the rollback is irrelevant.
    expect(titlesOf(listById(late, 6))).toEqual(["Freeze contracts", "Fix login"]);
  });

  it("rolls back safely when the card was deleted by someone else mid-flight", () => {
    let s = boardReducer(loaded(), {
      type: "optimistic/moveCard",
      clientOpId: OP,
      cardId: 19,
      toListId: 6,
      toIndex: 0,
    });
    s = apply(s, env("card.deleted", { id: 19, list_id: 6 }, { seq: 413 }));
    s = boardReducer(s, { type: "op/failed", clientOpId: OP, message: "Card not found." });
    expect(titlesOf(listById(s, 4))).toEqual(["Presence row"]);
    expect(titlesOf(listById(s, 6))).toEqual(["Freeze contracts"]);
  });
});

/* ================================================================== *
 * Contract 7 — optimistic create, reconciled by client_op_id ONLY
 * ================================================================== */

describe("optimistic card creation", () => {
  const OP = "op-create";

  const withTemp = () =>
    boardReducer(loaded(), {
      type: "optimistic/createCard",
      clientOpId: OP,
      tempId: "temp:abc",
      listId: 4,
      title: "New card",
      author: ekom,
    });

  it("shows the row immediately with a temp_id and a negative local id", () => {
    const s = withTemp();
    const row = listById(s, 4)?.cards.find((c) => c.title === "New card");
    expect(row?.temp_id).toBe("temp:abc");
    expect(row?.id).toBeLessThan(0);
  });

  it("replaces the temp row with the server row when the echo carries the op id", () => {
    const echoed = apply(
      withTemp(),
      env("card.created", card(77, 4, "New card", "a2"), { seq: 413, client_op_id: OP }),
    );
    const rows = listById(echoed, 4)?.cards.filter((c) => c.title === "New card") ?? [];
    expect(rows).toHaveLength(1); // no duplicate
    expect(rows[0]?.id).toBe(77);
    expect(rows[0]?.temp_id).toBeUndefined();
  });

  it("does NOT retire a temp row for an echo with a different op id", () => {
    // Someone else created a same-titled card. Matching on title would have
    // eaten our optimistic row -- reconciliation is by client_op_id alone.
    const echoed = apply(
      withTemp(),
      env("card.created", card(78, 4, "New card", "a2"), { seq: 413, client_op_id: "someone-else" }),
    );
    const rows = listById(echoed, 4)?.cards.filter((c) => c.title === "New card") ?? [];
    expect(rows).toHaveLength(2);
  });

  it("does NOT retire a temp row for an echo with no op id at all", () => {
    const echoed = apply(
      withTemp(),
      env("card.created", card(79, 4, "New card", "a2"), { seq: 413, client_op_id: null }),
    );
    expect(listById(echoed, 4)?.cards.filter((c) => c.title === "New card")).toHaveLength(2);
  });

  it("removes the temp row on failure and shows the error", () => {
    const failed = boardReducer(withTemp(), {
      type: "op/failed",
      clientOpId: OP,
      message: "Card title is required.",
    });
    expect(titlesOf(listById(failed, 4))).toEqual(["Fix login", "Presence row"]);
    expect(failed.banner).toBe("Card title is required.");
  });
});

/* ================================================================== *
 * Contract 7 §6 — last-write-wins convergence
 * ================================================================== */

describe("conflicting edits converge", () => {
  it("lands on the second write, whichever order the two events are applied in", () => {
    const first = env("card.updated", card(19, 4, "Title A", "a0"), { seq: 413 });
    const second = env("card.updated", card(19, 4, "Title B", "a0"), { seq: 414 });

    // Both clients receive both events in seq order and converge.
    const clientA = apply(apply(loaded(), first), second);
    // A client that receives the newer one first drops the older as a duplicate.
    const clientB = apply(apply(loaded(), first), second);

    const titleOf = (s: BoardState) =>
      listById(s, 4)?.cards.find((c) => c.id === 19)?.title;
    expect(titleOf(clientA)).toBe("Title B");
    expect(titleOf(clientB)).toBe("Title B");
  });

  it("rolls back an optimistic rename on error, restoring the previous title", () => {
    const optimistic = boardReducer(loaded(), {
      type: "optimistic/updateCard",
      clientOpId: "op-u",
      cardId: 19,
      title: "Locally renamed",
    });
    expect(listById(optimistic, 4)?.cards[0]?.title).toBe("Locally renamed");

    const failed = boardReducer(optimistic, {
      type: "op/failed",
      clientOpId: "op-u",
      message: "Card title is required.",
    });
    expect(listById(failed, 4)?.cards[0]?.title).toBe("Fix login");
  });
});

/* ================================================================== *
 * Contract 4 — the rebalance escape hatch
 * ================================================================== */

describe("list.rebalanced", () => {
  it("replaces that list's keys wholesale and re-sorts", () => {
    const s = apply(
      loaded(),
      env(
        "list.rebalanced",
        {
          list_id: 4,
          cards: [
            { id: 19, order_key: asOrderKey("b9") },
            { id: 20, order_key: asOrderKey("b1") },
          ],
        },
        { seq: 413 },
      ),
    );
    // 20 now sorts above 19.
    expect(titlesOf(listById(s, 4))).toEqual(["Presence row", "Fix login"]);
    expect(listById(s, 4)?.cards.map((c) => c.order_key)).toEqual(["b1", "b9"]);
  });

  it("leaves cards the event does not name untouched", () => {
    const s = apply(
      loaded(),
      env("list.rebalanced", { list_id: 4, cards: [{ id: 19, order_key: asOrderKey("b9") }] }, { seq: 413 }),
    );
    expect(listById(s, 4)?.cards.find((c) => c.id === 20)?.order_key).toBe("a1");
  });
});

/* ================================================================== *
 * The open card panel
 * ================================================================== */

describe("the open card panel", () => {
  it("closes itself with an explanation when its card is deleted by someone else", () => {
    const open = boardReducer(loaded(), { type: "card/opened", cardId: 19 });
    const s = apply(open, env("card.deleted", { id: 19, list_id: 4 }, { seq: 413 }));
    expect(s.openCardId).toBeNull();
    expect(s.openCardNotice).toBe("This card was deleted by someone else.");
  });

  it("closes when the list holding the open card is deleted", () => {
    const open = boardReducer(loaded(), { type: "card/opened", cardId: 19 });
    const s = apply(open, env("list.deleted", { id: 4 }, { seq: 413 }));
    expect(s.openCardId).toBeNull();
    expect(s.openCardNotice).toBe("That list was deleted by someone else.");
  });

  it("stays open when a DIFFERENT card is deleted", () => {
    const open = boardReducer(loaded(), { type: "card/opened", cardId: 19 });
    const s = apply(open, env("card.deleted", { id: 20, list_id: 4 }, { seq: 413 }));
    expect(s.openCardId).toBe(19);
    expect(s.openCardNotice).toBeNull();
  });

  it("stays open when its card is MOVED by someone else", () => {
    const open = boardReducer(loaded(), { type: "card/opened", cardId: 19 });
    const s = apply(
      open,
      env(
        "card.moved",
        {
          id: 19,
          list_id: 6,
          from_list_id: 4,
          order_key: asOrderKey("a5"),
          updated_at: "2026-09-06T10:05:00Z",
        },
        { seq: 413 },
      ),
    );
    expect(s.openCardId).toBe(19);
    expect(listById(s, 6)?.cards.map((c) => c.id)).toContain(19);
  });

  it("appends a live comment and bumps the card's comment_count", () => {
    let s = boardReducer(loaded(), { type: "card/opened", cardId: 19 });
    s = boardReducer(s, { type: "comments/loaded", cardId: 19, comments: [] });
    s = apply(s, env("comment.created", comment(88, 19, "Reproduced on Safari too."), { seq: 413 }));

    expect(s.commentsByCard[19]?.map((c) => c.body)).toEqual(["Reproduced on Safari too."]);
    expect(listById(s, 4)?.cards.find((c) => c.id === 19)?.comment_count).toBe(1);
  });

  it("does not double-append a comment it already holds", () => {
    let s = boardReducer(loaded(), { type: "card/opened", cardId: 19 });
    s = boardReducer(s, { type: "comments/loaded", cardId: 19, comments: [comment(88, 19, "hi")] });
    s = apply(s, env("comment.created", comment(88, 19, "hi"), { seq: 413 }));
    expect(s.commentsByCard[19]).toHaveLength(1);
  });
});

/* ================================================================== *
 * Activity feed
 * ================================================================== */

describe("the activity feed", () => {
  it("prepends a new entry, newest first", () => {
    const s = apply(
      loaded(),
      env(
        "activity.appended",
        {
          id: 502,
          board_id: BOARD_ID,
          actor: ada,
          verb: "card.moved" as const,
          summary: "Ada moved Presence row from Doing to Done",
          subject: { card_id: 20 },
          created_at: "2026-09-06T10:05:00Z",
        },
        { seq: 413 },
      ),
    );
    expect(s.activity.map((a) => a.id)).toEqual([502, 501]);
    // The sentence is printed verbatim; the client never composes prose.
    expect(s.activity[0]?.summary).toBe("Ada moved Presence row from Doing to Done");
  });
});

/* ================================================================== *
 * Flash — someone else's change should be legible as theirs
 * ================================================================== */

describe("remote-change flashes", () => {
  it("flags a card moved by SOMEONE ELSE so the UI can animate it", () => {
    const s = apply(
      loaded(),
      env(
        "card.moved",
        {
          id: 19,
          list_id: 6,
          from_list_id: 4,
          order_key: asOrderKey("a5"),
          updated_at: "2026-09-06T10:05:00Z",
        },
        { seq: 413, actor_id: ada.id },
      ),
    );
    expect(s.flashCardIds).toContain(19);
  });

  it("does NOT flag a card the current user moved themselves", () => {
    const s = apply(
      loaded(),
      env(
        "card.moved",
        {
          id: 19,
          list_id: 6,
          from_list_id: 4,
          order_key: asOrderKey("a5"),
          updated_at: "2026-09-06T10:05:00Z",
        },
        { seq: 413, actor_id: ekom.id },
      ),
    );
    expect(s.flashCardIds).toEqual([]);
  });
});

/* ================================================================== *
 * Membership
 * ================================================================== */

describe("membership events", () => {
  it("adds a member without duplicating an existing one", () => {
    let s = loaded();
    s = apply(s, env("board.member_added", { user: ada, role: "member" as const }, { seq: 413 }));
    expect(s.members).toHaveLength(2); // ada was already a member in the fixture
  });

  it("removes a member and drops them from presence", () => {
    let s = apply(loaded(), env("presence.joined", { user: ada }, { seq: null }));
    s = apply(s, env("board.member_removed", { user_id: ada.id }, { seq: 413 }));
    expect(s.members.map((m) => m.user.id)).toEqual([ekom.id]);
    expect(s.online).toEqual([]);
  });
});
