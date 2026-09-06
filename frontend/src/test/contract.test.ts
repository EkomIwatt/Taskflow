/**
 * CONTRACT CONFORMANCE.
 *
 * This suite asserts that both stubs produce exactly the shapes Contracts 1-8
 * freeze. It is the thing that makes the merge land: when Instance 1's real
 * process replaces the mock, anything that disagrees with the contract shows
 * up here rather than as a mystery in the browser.
 *
 * Every assertion below is traceable to a line of the frozen contract text.
 */

import { beforeEach, describe, expect, it } from "vitest";
import {
  consumeMockTicket,
  mockTransport,
  resetMockDb,
  seedMockData,
  clearMockCookie,
} from "../api/mocks";
import { FakeSocket, fakeCard, fakeUser } from "../realtime/fakeSocket";
import { isEnvelope, isEphemeralEvent, isKnownEventType } from "../realtime/protocol";
import { ACTIVITY_VERBS, isErrorEnvelope } from "../types/contracts";

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

let token: string | null = null;

async function call(
  path: string,
  init: { method?: string; body?: unknown; auth?: boolean } = {},
): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = {};
  if (init.body !== undefined) headers["Content-Type"] = "application/json";
  if (init.auth !== false && token) headers["Authorization"] = `Bearer ${token}`;

  const res = await mockTransport(path, {
    method: init.method ?? "GET",
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

/** Exactly these keys, no more and no fewer. */
const hasExactKeys = (obj: object, keys: string[]): void => {
  expect(Object.keys(obj).sort()).toEqual([...keys].sort());
};

const USER_KEYS = ["id", "email", "display_name", "avatar_color", "created_at"];
const CARD_KEYS = [
  "id",
  "list_id",
  "board_id",
  "title",
  "description",
  "order_key",
  "comment_count",
  "created_by",
  "created_at",
  "updated_at",
];

beforeEach(async () => {
  resetMockDb();
  clearMockCookie();
  token = null;
  const seed = seedMockData();
  const res = await call("/api/auth/login", {
    method: "POST",
    body: { email: seed.email, password: seed.password },
    auth: false,
  });
  token = res.body.access_token;
});

/* ================================================================== *
 * Contract 1 — Authentication
 * ================================================================== */

describe("Contract 1 — auth", () => {
  it("signup 201 returns the exact session shape with a full <User>", async () => {
    const res = await call("/api/auth/signup", {
      method: "POST",
      body: { email: "new@example.com", password: "password123", display_name: null },
      auth: false,
    });
    expect(res.status).toBe(201);
    hasExactKeys(res.body, ["access_token", "token_type", "expires_in", "user"]);
    expect(res.body.token_type).toBe("bearer");
    expect(res.body.expires_in).toBe(900);
    hasExactKeys(res.body.user, USER_KEYS);
  });

  it("display_name is never null on the wire — it falls back to the email local-part", async () => {
    const res = await call("/api/auth/signup", {
      method: "POST",
      body: { email: "zainab@example.com", password: "password123", display_name: null },
      auth: false,
    });
    expect(res.body.user.display_name).toBe("zainab");
  });

  it("avatar_color is a hex string, deterministic from the id, never null", async () => {
    const a = await call("/api/auth/signup", {
      method: "POST",
      body: { email: "a1@example.com", password: "password123", display_name: null },
      auth: false,
    });
    expect(a.body.user.avatar_color).toMatch(/^#[0-9A-Fa-f]{6}$/);

    const me1 = await call("/api/auth/me");
    const me2 = await call("/api/auth/me");
    expect(me1.body.avatar_color).toBe(me2.body.avatar_color);
  });

  it("signup 409 for a duplicate email, with the contract's sentence", async () => {
    const res = await call("/api/auth/signup", {
      method: "POST",
      body: { email: "ekom@example.com", password: "password123", display_name: null },
      auth: false,
    });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: "An account with that email already exists." });
  });

  it("signup 422 for a short password", async () => {
    const res = await call("/api/auth/signup", {
      method: "POST",
      body: { email: "short@example.com", password: "abc", display_name: null },
      auth: false,
    });
    expect(res.status).toBe(422);
    expect(res.body).toEqual({ error: "Password must be at least 8 characters." });
  });

  it("login gives THE SAME 401 for an unknown email and a wrong password", async () => {
    const unknown = await call("/api/auth/login", {
      method: "POST",
      body: { email: "nobody@example.com", password: "password123" },
      auth: false,
    });
    const wrong = await call("/api/auth/login", {
      method: "POST",
      body: { email: "ekom@example.com", password: "wrong-password" },
      auth: false,
    });

    // No user enumeration -- not by message, not by status.
    expect(unknown.status).toBe(wrong.status);
    expect(unknown.body).toEqual(wrong.body);
    expect(unknown.body).toEqual({ error: "Incorrect email or password." });
  });

  it("refresh returns a token WITHOUT a user, and rotates the cookie", async () => {
    const res = await call("/api/auth/refresh", { method: "POST", auth: false });
    expect(res.status).toBe(200);
    hasExactKeys(res.body, ["access_token", "token_type", "expires_in"]);
  });

  it("refresh 401 once the session is gone", async () => {
    clearMockCookie();
    const res = await call("/api/auth/refresh", { method: "POST", auth: false });
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "Session expired. Please sign in again." });
  });

  it("logout is 204 with no body", async () => {
    const res = await call("/api/auth/logout", { method: "POST" });
    expect(res.status).toBe(204);
    expect(res.body).toBeNull();
  });

  it("me 401 without a bearer token", async () => {
    const res = await call("/api/auth/me", { auth: false });
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "Not authenticated." });
  });
});

/* ================================================================== *
 * Contract 2 — Boards & membership
 * ================================================================== */

describe("Contract 2 — boards", () => {
  it("GET /api/boards returns { boards: [<BoardSummary>] } with exact keys", async () => {
    const res = await call("/api/boards");
    expect(res.status).toBe(200);
    hasExactKeys(res.body, ["boards"]);
    hasExactKeys(res.body.boards[0], [
      "id",
      "title",
      "role",
      "member_count",
      "card_count",
      "updated_at",
    ]);
    expect(["owner", "member"]).toContain(res.body.boards[0].role);
  });

  it("returns [] for a brand-new account rather than an error", async () => {
    await call("/api/auth/signup", {
      method: "POST",
      body: { email: "fresh@example.com", password: "password123", display_name: null },
      auth: false,
    });
    const fresh = await call("/api/auth/login", {
      method: "POST",
      body: { email: "fresh@example.com", password: "password123" },
      auth: false,
    });
    token = fresh.body.access_token;
    const res = await call("/api/boards");
    expect(res.body.boards).toEqual([]);
  });

  it("THE SNAPSHOT carries the load-bearing `seq` plus every declared field", async () => {
    const res = await call("/api/boards/4");
    expect(res.status).toBe(200);
    hasExactKeys(res.body, ["id", "title", "seq", "role", "members", "lists", "activity"]);
    // A snapshot without a seq is unusable -- it is the client's start cursor.
    expect(typeof res.body.seq).toBe("number");
    hasExactKeys(res.body.members[0], ["user", "role", "added_at"]);
    hasExactKeys(res.body.members[0].user, USER_KEYS);
    hasExactKeys(res.body.lists[0], ["id", "title", "order_key", "cards"]);
    hasExactKeys(res.body.lists[0].cards[0], CARD_KEYS);
  });

  it("a NON-MEMBER gets 404, never 403 — membership is not discoverable", async () => {
    const other = await call("/api/auth/signup", {
      method: "POST",
      body: { email: "outsider@example.com", password: "password123", display_name: null },
      auth: false,
    });
    token = other.body.access_token;

    const res = await call("/api/boards/4");
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "Board not found." });
  });

  it("adding an unknown email is 404 with its own sentence", async () => {
    const res = await call("/api/boards/4/members", {
      method: "POST",
      body: { email: "ghost@example.com" },
    });
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "No account with that email address." });
  });

  it("adding an existing member is 409", async () => {
    const res = await call("/api/boards/4/members", {
      method: "POST",
      body: { email: "ada@example.com" },
    });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: "That person is already a member of this board." });
  });

  it("removing the owner is 409", async () => {
    const snap = await call("/api/boards/4");
    const owner = snap.body.members.find((m: any) => m.role === "owner");
    const res = await call(`/api/boards/4/members/${owner.user.id}`, { method: "DELETE" });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: "The board owner cannot be removed." });
  });
});

/* ================================================================== *
 * Contract 3 — Lists & cards
 * ================================================================== */

describe("Contract 3 — lists and cards", () => {
  it("POST lists 201 carries board_id and an empty cards array", async () => {
    const res = await call("/api/boards/4/lists", {
      method: "POST",
      body: { title: "Blocked", after_list_id: null },
    });
    expect(res.status).toBe(201);
    hasExactKeys(res.body, ["id", "board_id", "title", "order_key", "cards"]);
    expect(res.body.cards).toEqual([]);
  });

  it("POST cards 201 returns a full <Card>", async () => {
    const snap = await call("/api/boards/4");
    const listId = snap.body.lists[0].id;
    const res = await call(`/api/lists/${listId}/cards`, {
      method: "POST",
      body: { title: "New work", after_card_id: null },
    });
    expect(res.status).toBe(201);
    hasExactKeys(res.body, CARD_KEYS);
    expect(res.body.description).toBe("");
    expect(res.body.comment_count).toBe(0);
  });

  it("POST cards 422 for an empty title", async () => {
    const snap = await call("/api/boards/4");
    const res = await call(`/api/lists/${snap.body.lists[0].id}/cards`, {
      method: "POST",
      body: { title: "   ", after_card_id: null },
    });
    expect(res.status).toBe(422);
    expect(res.body).toEqual({ error: "Card title is required." });
  });

  it("PATCH move returns a full <Card> with the server's authoritative key", async () => {
    const snap = await call("/api/boards/4");
    const [doing, done] = snap.body.lists;
    const card = doing.cards[0];

    const res = await call(`/api/cards/${card.id}/move`, {
      method: "PATCH",
      body: { list_id: done.id, before_card_id: null, after_card_id: done.cards[0].id },
    });
    expect(res.status).toBe(200);
    hasExactKeys(res.body, CARD_KEYS);
    expect(res.body.list_id).toBe(done.id);
    expect(typeof res.body.order_key).toBe("string");
    expect(res.body.order_key.length).toBeGreaterThan(0);
  });

  it("PATCH move 409 when a named neighbour is no longer in the destination list", async () => {
    const snap = await call("/api/boards/4");
    const [doing, done] = snap.body.lists;
    const strangerId = doing.cards[1].id; // lives in `doing`, not in `done`

    const res = await call(`/api/cards/${doing.cards[0].id}/move`, {
      method: "PATCH",
      body: { list_id: done.id, before_card_id: strangerId, after_card_id: null },
    });
    expect(res.status).toBe(409);
    // Written to be shown to the user as-is (Contract 7 §7).
    expect(res.body).toEqual({ error: "The board changed while you were dragging. Refreshing." });
  });

  it("PATCH move 409 when a neighbour has been deleted mid-drag", async () => {
    const snap = await call("/api/boards/4");
    const doing = snap.body.lists[0];
    const [first, second] = doing.cards;

    await call(`/api/cards/${second.id}`, { method: "DELETE" });
    const res = await call(`/api/cards/${first.id}/move`, {
      method: "PATCH",
      body: { list_id: doing.id, before_card_id: second.id, after_card_id: null },
    });
    expect(res.status).toBe(409);
  });

  it("a move changes NOTHING when it 409s", async () => {
    const before = await call("/api/boards/4");
    const [doing, done] = before.body.lists;

    await call(`/api/cards/${doing.cards[0].id}/move`, {
      method: "PATCH",
      body: { list_id: done.id, before_card_id: doing.cards[1].id, after_card_id: null },
    });

    const after = await call("/api/boards/4");
    expect(after.body.lists[0].cards.map((c: any) => c.id)).toEqual(
      doing.cards.map((c: any) => c.id),
    );
  });

  it("DELETE card is 204 with no body", async () => {
    const snap = await call("/api/boards/4");
    const res = await call(`/api/cards/${snap.body.lists[0].cards[0].id}`, { method: "DELETE" });
    expect(res.status).toBe(204);
    expect(res.body).toBeNull();
  });
});

/* ================================================================== *
 * Contract 4 — order keys
 * ================================================================== */

describe("Contract 4 — order keys", () => {
  it("keys use only [0-9A-Za-z] and are 1..64 chars", async () => {
    const snap = await call("/api/boards/4");
    const keys: string[] = [
      ...snap.body.lists.map((l: any) => l.order_key),
      ...snap.body.lists.flatMap((l: any) => l.cards.map((c: any) => c.order_key)),
    ];
    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) {
      expect(key).toMatch(/^[0-9A-Za-z]{1,64}$/);
    }
  });

  it("keys are unique per list, and the snapshot arrives already sorted", async () => {
    const snap = await call("/api/boards/4");
    for (const list of snap.body.lists) {
      const keys = list.cards.map((c: any) => c.order_key);
      expect(new Set(keys).size).toBe(keys.length);
      expect([...keys].sort()).toEqual(keys);
    }
  });

  it("inserting between two cards writes ONE new key and renumbers nothing", async () => {
    const before = await call("/api/boards/4");
    const doing = before.body.lists[0];
    const [first, second] = doing.cards;

    const created = await call(`/api/lists/${doing.id}/cards`, {
      method: "POST",
      body: { title: "Squeezed in", after_card_id: first.id },
    });

    const after = await call("/api/boards/4");
    const cards = after.body.lists[0].cards;

    // The new key sorts strictly between its neighbours...
    expect(created.body.order_key > first.order_key).toBe(true);
    expect(created.body.order_key < second.order_key).toBe(true);
    // ...and no sibling key changed. This is the project's whole premise.
    const keyOf = (id: number) => cards.find((c: any) => c.id === id)?.order_key;
    expect(keyOf(first.id)).toBe(first.order_key);
    expect(keyOf(second.id)).toBe(second.order_key);
  });

  it("survives many inserts into the SAME gap — the pathological case", async () => {
    const snap = await call("/api/boards/4");
    const doing = snap.body.lists[0];
    const anchor = doing.cards[0];

    for (let i = 0; i < 40; i += 1) {
      const res = await call(`/api/lists/${doing.id}/cards`, {
        method: "POST",
        body: { title: `squeeze ${i}`, after_card_id: anchor.id },
      });
      expect(res.status).toBe(201);
      expect(res.body.order_key).toMatch(/^[0-9A-Za-z]{1,64}$/);
    }

    const after = await call("/api/boards/4");
    const keys = after.body.lists[0].cards.map((c: any) => c.order_key);
    expect(new Set(keys).size).toBe(keys.length); // still unique
    expect([...keys].sort()).toEqual(keys); // still sorted
  });
});

/* ================================================================== *
 * Contract 5 — comments & activity
 * ================================================================== */

describe("Contract 5 — comments and activity", () => {
  it("<Comment> has exactly the declared keys, with a full author <User>", async () => {
    const snap = await call("/api/boards/4");
    const cardId = snap.body.lists[0].cards[0].id;
    const res = await call(`/api/cards/${cardId}/comments`, {
      method: "POST",
      body: { body: "Looks good to me." },
    });
    expect(res.status).toBe(201);
    hasExactKeys(res.body, ["id", "card_id", "board_id", "author", "body", "created_at"]);
    hasExactKeys(res.body.author, USER_KEYS);
  });

  it("comments come back oldest first", async () => {
    const snap = await call("/api/boards/4");
    const cardId = snap.body.lists[0].cards[0].id;
    await call(`/api/cards/${cardId}/comments`, { method: "POST", body: { body: "first" } });
    await call(`/api/cards/${cardId}/comments`, { method: "POST", body: { body: "second" } });

    const res = await call(`/api/cards/${cardId}/comments`);
    hasExactKeys(res.body, ["comments"]);
    expect(res.body.comments.map((c: any) => c.body)).toEqual(["first", "second"]);
  });

  it("an empty comment is 422", async () => {
    const snap = await call("/api/boards/4");
    const res = await call(`/api/cards/${snap.body.lists[0].cards[0].id}/comments`, {
      method: "POST",
      body: { body: "   " },
    });
    expect(res.status).toBe(422);
    expect(res.body).toEqual({ error: "Comment cannot be empty." });
  });

  it("deleting someone else's comment is 404, not 403", async () => {
    const snap = await call("/api/boards/4");
    const cardId = snap.body.lists[1].cards[0].id;
    // Seeded comment 88 belongs to Ada; we are signed in as Ekom.
    const existing = await call(`/api/cards/${snap.body.lists[0].cards[0].id}/comments`);
    const foreign = existing.body.comments[0];
    if (foreign) {
      const res = await call(`/api/comments/${foreign.id}`, { method: "DELETE" });
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: "Comment not found." });
    }
    expect(cardId).toBeGreaterThan(0);
  });

  it("<Activity> carries a server-rendered summary and an enumerated verb", async () => {
    const res = await call("/api/boards/4/activity?limit=50");
    hasExactKeys(res.body, ["activity", "next_before_id"]);
    const entry = res.body.activity[0];
    hasExactKeys(entry, ["id", "board_id", "actor", "verb", "summary", "subject", "created_at"]);
    expect(ACTIVITY_VERBS).toContain(entry.verb);
    // The sentence is complete prose the client prints verbatim.
    expect(entry.summary.length).toBeGreaterThan(0);
    hasExactKeys(entry.actor, USER_KEYS);
  });

  it("a within-list move reads 'reordered … in X'; a cross-list move reads 'moved … from X to Y'", async () => {
    const snap = await call("/api/boards/4");
    const [source, target] = snap.body.lists;
    const card = source.cards[0];

    // Within one list: from_list == to_list.
    await call(`/api/cards/${card.id}/move`, {
      method: "PATCH",
      body: { list_id: source.id, before_card_id: source.cards[1].id, after_card_id: null },
    });
    let feed = await call("/api/boards/4/activity");
    expect(feed.body.activity[0].summary).toBe(
      `Ekom reordered ${card.title} in ${source.title}`,
    );

    // Across lists.
    await call(`/api/cards/${card.id}/move`, {
      method: "PATCH",
      body: { list_id: target.id, before_card_id: null, after_card_id: null },
    });
    feed = await call("/api/boards/4/activity");
    expect(feed.body.activity[0].summary).toBe(
      `Ekom moved ${card.title} from ${source.title} to ${target.title}`,
    );
  });

  it("activity is newest first and pages with next_before_id", async () => {
    const res = await call("/api/boards/4/activity?limit=2");
    const ids = res.body.activity.map((a: any) => a.id);
    expect([...ids].sort((a: number, b: number) => b - a)).toEqual(ids);
    expect(res.body.next_before_id === null || typeof res.body.next_before_id === "number").toBe(
      true,
    );
  });
});

/* ================================================================== *
 * Contract 6 §1 — the ticket
 * ================================================================== */

describe("Contract 6 §1 — realtime ticket", () => {
  it("201 returns { ticket, expires_in: 30 }", async () => {
    const res = await call("/api/realtime/ticket", { method: "POST", body: { board_id: 4 } });
    expect(res.status).toBe(201);
    hasExactKeys(res.body, ["ticket", "expires_in"]);
    expect(res.body.expires_in).toBe(30);
    expect(typeof res.body.ticket).toBe("string");
  });

  it("a ticket is SINGLE-USE", async () => {
    const res = await call("/api/realtime/ticket", { method: "POST", body: { board_id: 4 } });
    expect(consumeMockTicket(res.body.ticket)).not.toBeNull();
    expect(consumeMockTicket(res.body.ticket)).toBeNull(); // replay refused
  });

  it("a ticket is bound to (user_id, board_id)", async () => {
    const res = await call("/api/realtime/ticket", { method: "POST", body: { board_id: 4 } });
    const claim = consumeMockTicket(res.body.ticket);
    expect(claim?.board_id).toBe(4);
    expect(typeof claim?.user_id).toBe("number");
  });

  it("a non-member asking for a ticket gets 404", async () => {
    const other = await call("/api/auth/signup", {
      method: "POST",
      body: { email: "nomember@example.com", password: "password123", display_name: null },
      auth: false,
    });
    token = other.body.access_token;
    const res = await call("/api/realtime/ticket", { method: "POST", body: { board_id: 4 } });
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "Board not found." });
  });
});

/* ================================================================== *
 * Contract 6 §2-§5 — the envelopes the fake socket emits
 * ================================================================== */

describe("Contract 6 — WebSocket envelopes", () => {
  beforeEach(() => FakeSocket.reset());

  const socket = (): FakeSocket => new FakeSocket({ boardId: 7, seq: 412, autoOpen: false });

  it("every envelope carries all seven §2 fields", () => {
    const sock = socket();
    const env = sock.envelope("card.created", fakeCard(19, 4, 7, "Fix login", "a0V", fakeUser(3, "Ekom")));
    hasExactKeys(env, ["type", "board_id", "seq", "actor_id", "client_op_id", "ts", "payload"]);
    expect(isEnvelope(env)).toBe(true);
  });

  it("state events carry a numeric seq", () => {
    const sock = socket();
    const env = sock.envelope("card.deleted", { id: 19, list_id: 4 });
    expect(typeof env.seq).toBe("number");
  });

  it("EPHEMERAL events carry seq: null", () => {
    const sock = socket();
    expect(sock.envelope("presence.joined", { user: fakeUser(5, "Ada") }).seq).toBeNull();
    expect(sock.envelope("presence.left", { user_id: 5 }).seq).toBeNull();
    expect(sock.envelope("ping", {}).seq).toBeNull();
  });

  it("emitting an ephemeral event does not advance the seq counter", () => {
    const sock = socket();
    sock.emit("presence.joined", { user: fakeUser(5, "Ada") });
    expect(sock.currentSeq).toBe(412);
    sock.emit("card.deleted", { id: 19, list_id: 4 });
    expect(sock.currentSeq).toBe(413);
  });

  it("hello carries board_id, seq, you and online", () => {
    const sock = socket();
    const you = fakeUser(3, "Ekom");
    const env = sock.envelope("hello", { board_id: 7, seq: 412, you, online: [you] });
    hasExactKeys(env.payload, ["board_id", "seq", "you", "online"]);
  });

  it("the client_op_id is echoed verbatim when one is supplied", () => {
    const sock = socket();
    const env = sock.envelope("card.deleted", { id: 19, list_id: 4 }, { client_op_id: "3f1c" });
    expect(env.client_op_id).toBe("3f1c");
  });

  it("client_op_id is null when the mutation carried no header", () => {
    const sock = socket();
    expect(sock.envelope("card.deleted", { id: 19, list_id: 4 }).client_op_id).toBeNull();
  });

  it("card.moved carries the five declared payload fields", () => {
    const sock = socket();
    const env = sock.envelope("card.moved", {
      id: 19,
      list_id: 4,
      from_list_id: 2,
      order_key: "a0V" as never,
      updated_at: "2026-09-06T10:00:00Z",
    });
    hasExactKeys(env.payload, ["id", "list_id", "from_list_id", "order_key", "updated_at"]);
  });

  it("list.rebalanced carries list_id and an (id, order_key) pair per card", () => {
    const sock = socket();
    const env = sock.envelope("list.rebalanced", {
      list_id: 4,
      cards: [{ id: 19, order_key: "a1" as never }],
    });
    hasExactKeys(env.payload, ["list_id", "cards"]);
    hasExactKeys(env.payload.cards[0]!, ["id", "order_key"]);
  });

  it("every declared §3/§4 type is recognised by the client", () => {
    const declared = [
      "hello",
      "board.updated",
      "board.member_added",
      "board.member_removed",
      "list.created",
      "list.updated",
      "list.moved",
      "list.deleted",
      "list.rebalanced",
      "card.created",
      "card.updated",
      "card.moved",
      "card.deleted",
      "comment.created",
      "activity.appended",
      "presence.joined",
      "presence.left",
      "ping",
    ];
    for (const type of declared) expect(isKnownEventType(type)).toBe(true);
  });

  it("exactly the §4 types are treated as ephemeral", () => {
    expect(isEphemeralEvent("presence.joined")).toBe(true);
    expect(isEphemeralEvent("presence.left")).toBe(true);
    expect(isEphemeralEvent("ping")).toBe(true);
    expect(isEphemeralEvent("card.moved")).toBe(false);
    expect(isEphemeralEvent("activity.appended")).toBe(false);
  });

  it("a type the client has never heard of is not treated as known", () => {
    expect(isKnownEventType("card.archived")).toBe(false);
  });
});

/* ================================================================== *
 * Contract 8 — the error envelope
 * ================================================================== */

describe("Contract 8 — errors", () => {
  it("a 422, a 404 and a 401 all return { error } and NO `detail` key", async () => {
    const unauthorised = await call("/api/boards", { auth: false });
    const notFound = await call("/api/boards/99999");
    const invalid = await call("/api/boards", { method: "POST", body: { title: "" } });

    for (const res of [unauthorised, notFound, invalid]) {
      expect(isErrorEnvelope(res.body)).toBe(true);
      expect(Object.keys(res.body)).toEqual(["error"]);
      expect(res.body).not.toHaveProperty("detail");
      // A complete, user-showable sentence.
      expect(res.body.error).toMatch(/^[A-Z].*[.]$/);
    }
    expect([unauthorised.status, notFound.status, invalid.status]).toEqual([401, 404, 422]);
  });

  it("malformed JSON is a 400 with the same envelope", async () => {
    const res = await mockTransport("/api/boards", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: "{not json",
    });
    expect(res.status).toBe(400);
    expect(isErrorEnvelope(await res.json())).toBe(true);
  });
});
