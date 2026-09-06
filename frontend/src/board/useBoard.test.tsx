/**
 * The join, end to end: the reducer, the real socket client, the scripted
 * socket and the mock HTTP layer wired together exactly as the app wires them.
 *
 * This is where the two rules that decide the merge get proven:
 *   - a gap in `seq` triggers EXACTLY ONE snapshot refetch;
 *   - an optimistic move settles on the echo, or rolls back completely.
 */

import { renderHook, waitFor, act } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearMockCookie,
  failNextRequest,
  mockTransport,
  resetMockDb,
  seedMockData,
  setMockLatency,
} from "../api/mocks";
import { setAccessToken, setTransport, __resetRefreshState } from "../api/http";
import { FakeSocket } from "../realtime/fakeSocket";
import type { User } from "../types/contracts";
import { neighboursAt, useBoard } from "./useBoard";
import type { LocalCard } from "./types";

const BOARD_ID = 4;

let transportSpy: ReturnType<typeof vi.fn>;
let me: User;

/** How many times the snapshot has been fetched. */
const snapshotFetches = (): number =>
  transportSpy.mock.calls.filter((call) => {
    const url = String(call[0]);
    const init = call[1] as RequestInit | undefined;
    return url === `/api/boards/${BOARD_ID}` && (init?.method ?? "GET") === "GET";
  }).length;

beforeEach(async () => {
  vi.stubEnv("VITE_USE_FAKE_SOCKET", "true");
  FakeSocket.reset();
  resetMockDb();
  clearMockCookie();
  __resetRefreshState();

  const seed = seedMockData();
  transportSpy = vi.fn(mockTransport);
  setTransport(transportSpy as never);

  const res = await mockTransport("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: seed.email, password: seed.password }),
  });
  const session = (await res.json()) as { access_token: string; user: User };
  setAccessToken(session.access_token);
  me = session.user;
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

/** Mount the hook and wait for the snapshot + hello handshake. */
async function mountBoard() {
  const view = renderHook(() => useBoard(BOARD_ID, me));
  await waitFor(() => expect(view.result.current.state.loaded).toBe(true));
  await waitFor(() => expect(FakeSocket.instances.length).toBeGreaterThan(0));

  const sock = FakeSocket.latest;
  await act(async () => {
    sock.emitHello({
      board_id: BOARD_ID,
      seq: view.result.current.state.seq,
      you: me,
      online: [me],
    });
  });
  return { ...view, sock };
}

const listOf = (state: { lists: { id: number; cards: LocalCard[] }[] }, id: number) =>
  state.lists.find((l) => l.id === id);

/* ================================================================== *
 * Boot
 * ================================================================== */

describe("board boot", () => {
  it("fetches the snapshot, a ticket, and opens exactly one socket", async () => {
    const { result, sock } = await mountBoard();

    expect(snapshotFetches()).toBe(1);
    expect(
      transportSpy.mock.calls.filter(([url]) => url === "/api/realtime/ticket"),
    ).toHaveLength(1);
    expect(FakeSocket.instances).toHaveLength(1);
    expect(result.current.state.connection).toBe("open");
    expect(sock.boardId).toBe(BOARD_ID);
  });

  it("adopts presence from hello", async () => {
    const { result } = await mountBoard();
    expect(result.current.state.online.map((u) => u.id)).toEqual([me.id]);
  });

  it("does not resync when hello.seq matches the snapshot", async () => {
    await mountBoard();
    expect(snapshotFetches()).toBe(1);
  });
});

/* ================================================================== *
 * Contract 6 §6.3 — the gap rule
 * ================================================================== */

describe("seq gap recovery", () => {
  it("refetches the snapshot EXACTLY ONCE when a gap appears", async () => {
    const { result, sock } = await mountBoard();
    expect(snapshotFetches()).toBe(1);

    await act(async () => {
      sock.skipSeq(5); // five events were missed
      sock.emit("card.deleted", { id: 999, list_id: 4 });
    });

    await waitFor(() => expect(snapshotFetches()).toBe(2));
    // Settle any queued effects: still exactly two, never three.
    await act(async () => {
      await Promise.resolve();
    });
    expect(snapshotFetches()).toBe(2);
    expect(result.current.state.needsResync).toBe(false);
  });

  it("collapses a BURST of gapped events into one refetch", async () => {
    const { sock } = await mountBoard();

    await act(async () => {
      sock.skipSeq(10);
      sock.emit("card.deleted", { id: 901, list_id: 4 });
      sock.emit("card.deleted", { id: 902, list_id: 4 });
      sock.emit("card.deleted", { id: 903, list_id: 4 });
    });

    await waitFor(() => expect(snapshotFetches()).toBe(2));
    expect(snapshotFetches()).toBe(2);
  });

  it("does NOT refetch for an in-order event", async () => {
    const { result, sock } = await mountBoard();
    const before = result.current.state.seq;

    await act(async () => {
      sock.emit("board.updated", { id: BOARD_ID, title: "Launch v2" });
    });

    expect(snapshotFetches()).toBe(1);
    expect(result.current.state.title).toBe("Launch v2");
    expect(result.current.state.seq).toBe(before + 1);
  });

  it("does NOT refetch for a duplicate", async () => {
    const { result, sock } = await mountBoard();

    await act(async () => {
      sock.emitDuplicate("board.updated", { id: BOARD_ID, title: "Launch v2" });
    });

    expect(snapshotFetches()).toBe(1);
    expect(result.current.state.title).toBe("Launch v2");
  });

  it("does NOT refetch for a presence event, and does not advance seq", async () => {
    const { result, sock } = await mountBoard();
    const before = result.current.state.seq;

    await act(async () => {
      sock.emit("presence.joined", {
        user: { ...me, id: 999, display_name: "Ada" },
      });
    });

    expect(snapshotFetches()).toBe(1);
    expect(result.current.state.seq).toBe(before);
    expect(result.current.state.online).toHaveLength(2);
  });

  it("ignores an unknown event type without refetching or throwing", async () => {
    const { result, sock } = await mountBoard();
    const before = result.current.state.seq;

    await act(async () => {
      sock.emit("card.archived" as never, { id: 19 } as never);
    });

    expect(snapshotFetches()).toBe(1);
    expect(result.current.state.seq).toBe(before);
  });
});

/* ================================================================== *
 * Contract 7 — optimistic moves against the real mock server
 * ================================================================== */

describe("optimistic card moves", () => {
  it("applies the move immediately, then settles on the server's key", async () => {
    const { result } = await mountBoard();
    const [source, target] = result.current.state.lists;
    const card = source!.cards[0]!;

    act(() => {
      result.current.moveCard(card.id, target!.id, 0);
    });

    // Optimistic: already in the destination, at the dropped index.
    expect(listOf(result.current.state, target!.id)?.cards[0]?.id).toBe(card.id);
    expect(result.current.state.pending).toHaveLength(1);

    await waitFor(() => expect(result.current.state.pending).toHaveLength(0));

    const settled = listOf(result.current.state, target!.id)?.cards.find((c) => c.id === card.id);
    expect(settled?.list_id).toBe(target!.id);
    // The authoritative key replaced the placeholder.
    expect(settled?.order_key).toMatch(/^[0-9A-Za-z]+$/);
  });

  it("sends neighbour IDS and never an order_key", async () => {
    const { result } = await mountBoard();
    const [source, target] = result.current.state.lists;
    const card = source!.cards[0]!;

    act(() => {
      result.current.moveCard(card.id, target!.id, 1);
    });
    await waitFor(() => expect(result.current.state.pending).toHaveLength(0));

    const moveCall = transportSpy.mock.calls.find(([url]) =>
      String(url).endsWith(`/api/cards/${card.id}/move`),
    );
    const body = JSON.parse(String((moveCall?.[1] as RequestInit).body));

    expect(Object.keys(body).sort()).toEqual(
      ["after_card_id", "before_card_id", "list_id"].sort(),
    );
    expect(body).not.toHaveProperty("order_key");
    expect(body.list_id).toBe(target!.id);
  });

  it("carries an X-Client-Op-Id on the move request", async () => {
    const { result } = await mountBoard();
    const [source, target] = result.current.state.lists;
    const card = source!.cards[0]!;

    act(() => {
      result.current.moveCard(card.id, target!.id, 0);
    });
    await waitFor(() => expect(result.current.state.pending).toHaveLength(0));

    const moveCall = transportSpy.mock.calls.find(([url]) =>
      String(url).endsWith(`/api/cards/${card.id}/move`),
    );
    const headers = (moveCall?.[1] as RequestInit).headers as Record<string, string>;
    expect(headers["X-Client-Op-Id"]).toMatch(/.+/);
  });

  it("settles on the ECHO when the broadcast beats the HTTP response", async () => {
    // Contract 7 §2: the client settles on whichever arrives first. Slowing the
    // HTTP layer makes the broadcast genuinely win the race, which is the
    // common case in production — the fan-out does not wait for the response
    // to reach the originator.
    setMockLatency(60);
    try {
      const { result, sock } = await mountBoard();
      const [source, target] = result.current.state.lists;
      const card = source!.cards[0]!;

      act(() => {
        result.current.moveCard(card.id, target!.id, 0);
      });
      const opId = result.current.state.pending[0]?.clientOpId;
      expect(opId).toBeDefined();

      await act(async () => {
        sock.emit(
          "card.moved",
          {
            id: card.id,
            list_id: target!.id,
            from_list_id: source!.id,
            order_key: "zz" as never,
            updated_at: "2026-09-06T11:00:00Z",
          },
          { client_op_id: opId, actor_id: me.id },
        );
      });

      // The echo settled it: the placeholder is gone before the response lands.
      const moved = listOf(result.current.state, target!.id)?.cards.find((c) => c.id === card.id);
      expect(moved?.order_key).toBe("zz");
      expect(moved?.list_id).toBe(target!.id);

      // And the late HTTP response is applied harmlessly on top — same row,
      // replaced by id, no duplicate.
      await waitFor(() => expect(result.current.state.pending).toHaveLength(0));
      const rows =
        listOf(result.current.state, target!.id)?.cards.filter((c) => c.id === card.id) ?? [];
      expect(rows).toHaveLength(1);
    } finally {
      setMockLatency(0);
    }
  });

  it("rolls back COMPLETELY on a 409 and shows the server's sentence", async () => {
    const { result } = await mountBoard();
    const [source, target] = result.current.state.lists;
    const card = source!.cards[0]!;
    const originalOrder = source!.cards.map((c) => c.id);

    failNextRequest(/\/move$/, 409, "The board changed while you were dragging. Refreshing.");

    act(() => {
      result.current.moveCard(card.id, target!.id, 0);
    });
    await waitFor(() => expect(result.current.state.banner).not.toBeNull());

    expect(result.current.state.banner).toBe(
      "The board changed while you were dragging. Refreshing.",
    );
    // Pre-drag state restored exactly.
    expect(listOf(result.current.state, source!.id)?.cards.map((c) => c.id)).toEqual(originalOrder);
    expect(listOf(result.current.state, target!.id)?.cards.map((c) => c.id)).not.toContain(card.id);
    expect(result.current.state.pending).toHaveLength(0);
  });

  it("refetches the snapshot after a 409, as Contract 7 §7 requires", async () => {
    const { result } = await mountBoard();
    const [source, target] = result.current.state.lists;

    failNextRequest(/\/move$/, 409, "The board changed while you were dragging. Refreshing.");
    act(() => {
      result.current.moveCard(source!.cards[0]!.id, target!.id, 0);
    });

    await waitFor(() => expect(snapshotFetches()).toBe(2));
  });

  it("rolls back on a 404 — the card was deleted mid-drag", async () => {
    const { result } = await mountBoard();
    const [source, target] = result.current.state.lists;
    const card = source!.cards[0]!;

    failNextRequest(/\/move$/, 404, "Card not found.");
    act(() => {
      result.current.moveCard(card.id, target!.id, 0);
    });

    await waitFor(() => expect(result.current.state.banner).toBe("Card not found."));
    expect(listOf(result.current.state, source!.id)?.cards.map((c) => c.id)).toContain(card.id);
  });
});

/* ================================================================== *
 * Optimistic creation
 * ================================================================== */

describe("optimistic card creation", () => {
  it("shows the card instantly and reconciles it to the server row", async () => {
    const { result } = await mountBoard();
    const list = result.current.state.lists[0]!;

    act(() => {
      result.current.createCard(list.id, "Brand new card");
    });

    const optimistic = listOf(result.current.state, list.id)?.cards.find(
      (c) => c.title === "Brand new card",
    );
    expect(optimistic?.temp_id).toMatch(/^temp:/);
    expect(optimistic?.id).toBeLessThan(0);

    await waitFor(() => expect(result.current.state.pending).toHaveLength(0));

    const rows =
      listOf(result.current.state, list.id)?.cards.filter((c) => c.title === "Brand new card") ?? [];
    expect(rows).toHaveLength(1); // no duplicate left behind
  });

  it("never sends the temp_id to the server", async () => {
    const { result } = await mountBoard();
    const list = result.current.state.lists[0]!;

    act(() => {
      result.current.createCard(list.id, "Another card");
    });
    await waitFor(() => expect(result.current.state.pending).toHaveLength(0));

    const createCall = transportSpy.mock.calls.find(([url]) =>
      String(url).endsWith(`/api/lists/${list.id}/cards`),
    );
    const body = String((createCall?.[1] as RequestInit).body);
    expect(body).not.toContain("temp:");
    expect(JSON.parse(body)).toEqual({ title: "Another card", after_card_id: null });
  });

  it("removes the optimistic row when the create fails", async () => {
    const { result } = await mountBoard();
    const list = result.current.state.lists[0]!;

    failNextRequest(/\/cards$/, 422, "Card title is required.");
    act(() => {
      result.current.createCard(list.id, "Doomed card");
    });

    await waitFor(() => expect(result.current.state.banner).toBe("Card title is required."));
    expect(
      listOf(result.current.state, list.id)?.cards.some((c) => c.title === "Doomed card"),
    ).toBe(false);
  });
});

/* ================================================================== *
 * Teardown
 * ================================================================== */

describe("teardown", () => {
  it("closes the socket with 1000 on unmount", async () => {
    const { unmount, sock } = await mountBoard();
    unmount();
    expect(sock.closedWith).toBe(1000);
  });
});

/* ================================================================== *
 * neighboursAt — the ids the server is given
 * ================================================================== */

describe("neighboursAt", () => {
  const c = (id: number): LocalCard => ({ id }) as LocalCard;

  it("reports nulls for an empty destination list", () => {
    expect(neighboursAt([], 0, 19)).toEqual({ before_card_id: null, after_card_id: null });
  });

  it("reports a null `before` when dropping at the top", () => {
    expect(neighboursAt([c(1), c(2)], 0, 19)).toEqual({
      before_card_id: null,
      after_card_id: 1,
    });
  });

  it("reports a null `after` when dropping at the bottom", () => {
    expect(neighboursAt([c(1), c(2)], 2, 19)).toEqual({
      before_card_id: 2,
      after_card_id: null,
    });
  });

  it("reports both neighbours when dropping into a gap", () => {
    expect(neighboursAt([c(1), c(2), c(3)], 1, 19)).toEqual({
      before_card_id: 1,
      after_card_id: 2,
    });
  });

  it("excludes the moving card from its own neighbours", () => {
    expect(neighboursAt([c(1), c(19), c(3)], 1, 19)).toEqual({
      before_card_id: 1,
      after_card_id: 3,
    });
  });

  it("SKIPS unconfirmed rows — the server has never heard of them", () => {
    // -7 is an optimistic row awaiting its echo; naming it would be naming a
    // card that does not exist server-side.
    expect(neighboursAt([c(1), c(-7), c(3)], 2, 19)).toEqual({
      before_card_id: 1,
      after_card_id: 3,
    });
  });

  it("clamps an index past the end", () => {
    expect(neighboursAt([c(1)], 99, 19)).toEqual({ before_card_id: 1, after_card_id: null });
  });
});
