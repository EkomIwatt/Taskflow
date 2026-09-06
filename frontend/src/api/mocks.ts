/**
 * The mock HTTP layer — Contracts 1-5 and 8, implemented verbatim.
 *
 * It is an in-memory stand-in for Instance 1's API: same paths, same methods,
 * same status codes, same bodies, and the same `{ "error": "<sentence>" }`
 * envelope on every non-2xx. The whole app is built against it, so the merge
 * is a swap of one `setTransport` call.
 *
 * Toggled in the app by VITE_USE_MOCKS=true.
 *
 * ------------------------------------------------------------------------
 * A NOTE ON ORDER KEYS, because this is the trap the whole project plan was
 * shaped to avoid:
 *
 * This mock mints keys so the fixture data has *something* sortable in it. It
 * is a FIXTURE GENERATOR, not an implementation of Contract 4, and it is
 * confined to this file -- nothing in `src/board/`, `src/realtime/` or any
 * component imports it. The real algorithm lives in exactly one language in
 * exactly one codebase (Instance 1's `app/ordering.py`), and the client's only
 * contract with it is "sort these opaque strings byte-wise".
 *
 * If a midpoint function ever escapes this file into application code, that is
 * the coupling trap, and it is an escalation rather than a patch.
 * ------------------------------------------------------------------------
 */

import {
  asOrderKey,
  type Activity,
  type ActivityVerb,
  type BoardMember,
  type BoardSnapshot,
  type BoardSummary,
  type Card,
  type Comment,
  type OrderKey,
  type User,
} from "../types/contracts";

/* ------------------------------------------------------------------ *
 * Fixture-only key minting. NOT Contract 4. See the note above.
 * ------------------------------------------------------------------ */

const ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

function fixtureKeyBetween(a: string | null, b: string | null): string {
  const lo = a ?? "";
  const hi = b ?? "";
  let prefix = "";
  let i = 0;
  for (;;) {
    const ca = lo[i] ?? ALPHABET[0]!;
    const cb = hi[i] ?? undefined;
    if (cb !== undefined && ca === cb) {
      prefix += ca;
      i += 1;
      continue;
    }
    const loIdx = ALPHABET.indexOf(ca);
    const hiIdx = cb === undefined ? ALPHABET.length : ALPHABET.indexOf(cb);
    if (hiIdx - loIdx > 1) {
      return prefix + ALPHABET[Math.floor((loIdx + hiIdx) / 2)]!;
    }
    // No room at this position: descend, keeping the low digit.
    prefix += ca;
    i += 1;
    if (i > 40) return prefix + ALPHABET[1]!; // fixture safety valve
  }
}

/* ------------------------------------------------------------------ *
 * The in-memory database
 * ------------------------------------------------------------------ */

interface MockCard extends Omit<Card, "created_by"> {
  created_by_id: number;
}

interface MockList {
  id: number;
  board_id: number;
  title: string;
  order_key: OrderKey;
}

interface MockBoard {
  id: number;
  owner_id: number;
  title: string;
  seq: number;
  updated_at: string;
}

interface MockDb {
  users: Array<User & { password: string }>;
  boards: MockBoard[];
  members: Array<{ board_id: number; user_id: number; role: "owner" | "member"; added_at: string }>;
  lists: MockList[];
  cards: MockCard[];
  comments: Comment[];
  activity: Activity[];
  sessions: Map<string, number>;
  refreshTokens: Map<string, number>;
  tickets: Map<string, { user_id: number; board_id: number; used: boolean }>;
  nextId: number;
}

let db: MockDb;

const now = (): string => new Date().toISOString();
const nextId = (): number => db.nextId++;

/** Contract 1: deterministic from the user id; never null. */
const AVATAR_COLORS = [
  "#3B82F6",
  "#EF4444",
  "#10B981",
  "#F59E0B",
  "#8B5CF6",
  "#EC4899",
  "#14B8A6",
  "#F97316",
];
const avatarColorFor = (id: number): string =>
  AVATAR_COLORS[id % AVATAR_COLORS.length] ?? "#3B82F6";

/** Contract 1: never null on the wire; falls back to the email local-part. */
const displayNameFor = (email: string, given: string | null): string =>
  given && given.trim() ? given.trim() : (email.split("@")[0] ?? email);

export function resetMockDb(): void {
  db = {
    users: [],
    boards: [],
    members: [],
    lists: [],
    cards: [],
    comments: [],
    activity: [],
    sessions: new Map(),
    refreshTokens: new Map(),
    tickets: new Map(),
    nextId: 1,
  };
}
resetMockDb();

/* ------------------------------------------------------------------ *
 * Serialisation — every payload matches the contract field-for-field
 * ------------------------------------------------------------------ */

function userById(id: number): User {
  const u = db.users.find((x) => x.id === id);
  if (!u) {
    // A deleted actor: activity.actor_id is ON DELETE SET NULL server-side,
    // but the contract's <Activity> always carries an actor, so the fixture
    // keeps a placeholder rather than emitting a shape the client can't read.
    return {
      id,
      email: "deleted@example.com",
      display_name: "Deleted user",
      avatar_color: "#6B7280",
      created_at: "2026-01-01T00:00:00Z",
    };
  }
  return {
    id: u.id,
    email: u.email,
    display_name: u.display_name,
    avatar_color: u.avatar_color,
    created_at: u.created_at,
  };
}

const serializeCard = (c: MockCard): Card => ({
  id: c.id,
  list_id: c.list_id,
  board_id: c.board_id,
  title: c.title,
  description: c.description,
  order_key: c.order_key,
  comment_count: db.comments.filter((x) => x.card_id === c.id).length,
  created_by: userById(c.created_by_id),
  created_at: c.created_at,
  updated_at: c.updated_at,
});

const byOrder = <T extends { order_key: OrderKey; id: number }>(items: T[]): T[] =>
  [...items].sort((a, b) =>
    a.order_key < b.order_key ? -1 : a.order_key > b.order_key ? 1 : a.id - b.id,
  );

/* ------------------------------------------------------------------ *
 * Response helpers — Contract 8
 * ------------------------------------------------------------------ */

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

/** EVERY non-2xx body, without exception. There is no `detail` key anywhere. */
const fail = (status: number, error: string): Response => json(status, { error });

const noContent = (): Response => new Response(null, { status: 204 });

/** Non-member access returns 404, never 403. Membership must not be probeable. */
const NOT_FOUND = () => fail(404, "Board not found.");

/* ------------------------------------------------------------------ *
 * Auth helpers
 * ------------------------------------------------------------------ */

function currentUserId(init: RequestInit | undefined): number | null {
  const headers = (init?.headers ?? {}) as Record<string, string>;
  const auth = headers["Authorization"] ?? headers["authorization"];
  if (!auth?.startsWith("Bearer ")) return null;
  return db.sessions.get(auth.slice(7)) ?? null;
}

function issueSession(userId: number): {
  access_token: string;
  token_type: "bearer";
  expires_in: number;
} {
  const token = `access-${userId}-${Math.random().toString(36).slice(2)}`;
  db.sessions.set(token, userId);
  return { access_token: token, token_type: "bearer", expires_in: 900 };
}

/** The mock's stand-in for the httpOnly cookie the browser would hold. */
let mockRefreshCookie: string | null = null;

function issueRefresh(userId: number): void {
  // Rotated on every refresh, exactly as the contract says.
  if (mockRefreshCookie) db.refreshTokens.delete(mockRefreshCookie);
  const token = `refresh-${userId}-${Math.random().toString(36).slice(2)}`;
  db.refreshTokens.set(token, userId);
  mockRefreshCookie = token;
}

export const clearMockCookie = (): void => {
  mockRefreshCookie = null;
};

function membership(boardId: number, userId: number): "owner" | "member" | null {
  return db.members.find((m) => m.board_id === boardId && m.user_id === userId)?.role ?? null;
}

/* ------------------------------------------------------------------ *
 * Activity + seq — one mutation, one entry, one bumped seq
 * ------------------------------------------------------------------ */

function record(
  boardId: number,
  actorId: number,
  verb: ActivityVerb,
  summary: string,
  subject: Record<string, unknown>,
): Activity {
  const board = db.boards.find((b) => b.id === boardId);
  if (board) {
    board.seq += 1;
    board.updated_at = now();
  }
  const entry: Activity = {
    id: nextId(),
    board_id: boardId,
    actor: userById(actorId),
    verb,
    summary,
    subject,
    created_at: now(),
  };
  db.activity.push(entry);
  return entry;
}

/* ------------------------------------------------------------------ *
 * Seed data — enough to develop every screen without a backend
 * ------------------------------------------------------------------ */

export function seedMockData(): { email: string; password: string } {
  resetMockDb();
  clearMockCookie();

  const makeUser = (email: string, name: string, password: string): User & { password: string } => {
    const id = nextId();
    const u = {
      id,
      email,
      display_name: displayNameFor(email, name),
      avatar_color: avatarColorFor(id),
      created_at: now(),
      password,
    };
    db.users.push(u);
    return u;
  };

  const ekom = makeUser("ekom@example.com", "Ekom", "password123");
  const ada = makeUser("ada@example.com", "Ada", "password123");
  makeUser("chidi@example.com", "Chidi", "password123");

  const board: MockBoard = {
    id: nextId(),
    owner_id: ekom.id,
    title: "Launch",
    seq: 0,
    updated_at: now(),
  };
  db.boards.push(board);
  db.members.push({ board_id: board.id, user_id: ekom.id, role: "owner", added_at: now() });
  db.members.push({ board_id: board.id, user_id: ada.id, role: "member", added_at: now() });

  let listKey: string | null = null;
  const addList = (title: string): MockList => {
    listKey = fixtureKeyBetween(listKey, null);
    const l: MockList = {
      id: nextId(),
      board_id: board.id,
      title,
      order_key: asOrderKey(listKey),
    };
    db.lists.push(l);
    return l;
  };

  const todo = addList("To do");
  const doing = addList("Doing");
  const done = addList("Done");

  const addCard = (list: MockList, title: string, description = ""): MockCard => {
    const siblings = byOrder(db.cards.filter((c) => c.list_id === list.id));
    const last = siblings[siblings.length - 1]?.order_key ?? null;
    const c: MockCard = {
      id: nextId(),
      list_id: list.id,
      board_id: board.id,
      title,
      description,
      order_key: asOrderKey(fixtureKeyBetween(last, null)),
      comment_count: 0,
      created_by_id: ekom.id,
      created_at: now(),
      updated_at: now(),
    };
    db.cards.push(c);
    return c;
  };

  addCard(todo, "Write the deploy runbook");
  addCard(todo, "Pin Python 3.12.8 in the Dockerfile");
  const login = addCard(doing, "Fix login redirect", "Redirects to / instead of the board list.");
  addCard(doing, "Presence row overflow count");
  addCard(done, "Freeze the interface contracts");

  db.comments.push({
    id: nextId(),
    card_id: login.id,
    board_id: board.id,
    author: userById(ada.id),
    body: "Reproduced on Safari too.",
    created_at: now(),
  });

  record(board.id, ekom.id, "board.created", "Ekom created Launch", { board_id: board.id });
  record(board.id, ekom.id, "member.added", "Ekom added Ada to the board", { user_id: ada.id });
  record(board.id, ada.id, "comment.added", "Ada commented on Fix login redirect", {
    card_id: login.id,
    card_title: login.title,
  });

  return { email: ekom.email, password: "password123" };
}

/* ------------------------------------------------------------------ *
 * The router
 * ------------------------------------------------------------------ */

interface Ctx {
  userId: number | null;
  body: Record<string, unknown>;
  method: string;
  url: URL;
}

type Handler = (ctx: Ctx, params: string[]) => Response | Promise<Response>;

const routes: Array<{ method: string; pattern: RegExp; handler: Handler }> = [];
const route = (method: string, pattern: RegExp, handler: Handler): void => {
  routes.push({ method, pattern, handler });
};

/* ---------------------------- Contract 1 ---------------------------- */

route("POST", /^\/api\/auth\/signup$/, (ctx) => {
  const email = String(ctx.body.email ?? "").trim();
  const password = String(ctx.body.password ?? "");
  const displayName = ctx.body.display_name == null ? null : String(ctx.body.display_name);

  if (password.length < 8) return fail(422, "Password must be at least 8 characters.");
  if (db.users.some((u) => u.email.toLowerCase() === email.toLowerCase())) {
    return fail(409, "An account with that email already exists.");
  }
  const id = nextId();
  const user: User & { password: string } = {
    id,
    email,
    display_name: displayNameFor(email, displayName),
    avatar_color: avatarColorFor(id),
    created_at: now(),
    password,
  };
  db.users.push(user);
  issueRefresh(id);
  return json(201, { ...issueSession(id), user: userById(id) });
});

route("POST", /^\/api\/auth\/login$/, (ctx) => {
  const email = String(ctx.body.email ?? "").trim();
  const password = String(ctx.body.password ?? "");
  const user = db.users.find((u) => u.email.toLowerCase() === email.toLowerCase());
  // THE SAME message for an unknown email and a wrong password. No enumeration.
  if (!user || user.password !== password) return fail(401, "Incorrect email or password.");
  issueRefresh(user.id);
  return json(200, { ...issueSession(user.id), user: userById(user.id) });
});

route("POST", /^\/api\/auth\/refresh$/, () => {
  const userId = mockRefreshCookie ? db.refreshTokens.get(mockRefreshCookie) : undefined;
  if (userId === undefined) return fail(401, "Session expired. Please sign in again.");
  issueRefresh(userId); // rotated on every refresh
  return json(200, issueSession(userId));
});

route("POST", /^\/api\/auth\/logout$/, (ctx) => {
  if (ctx.userId === null) return fail(401, "Not authenticated.");
  if (mockRefreshCookie) db.refreshTokens.delete(mockRefreshCookie);
  mockRefreshCookie = null;
  db.sessions.clear();
  return noContent();
});

route("GET", /^\/api\/auth\/me$/, (ctx) => {
  if (ctx.userId === null) return fail(401, "Not authenticated.");
  return json(200, userById(ctx.userId));
});

/* ---------------------------- Contract 2 ---------------------------- */

route("GET", /^\/api\/boards$/, (ctx) => {
  if (ctx.userId === null) return fail(401, "Not authenticated.");
  const uid = ctx.userId;
  const boards: BoardSummary[] = db.members
    .filter((m) => m.user_id === uid)
    .map((m) => {
      const b = db.boards.find((x) => x.id === m.board_id);
      if (!b) return null;
      return {
        id: b.id,
        title: b.title,
        role: m.role,
        member_count: db.members.filter((x) => x.board_id === b.id).length,
        card_count: db.cards.filter((c) => c.board_id === b.id).length,
        updated_at: b.updated_at,
      };
    })
    .filter((b): b is BoardSummary => b !== null)
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at)); // newest activity first
  return json(200, { boards });
});

route("POST", /^\/api\/boards$/, (ctx) => {
  if (ctx.userId === null) return fail(401, "Not authenticated.");
  const title = String(ctx.body.title ?? "").trim();
  if (!title || title.length > 80) return fail(422, "Board title is required.");
  const board: MockBoard = {
    id: nextId(),
    owner_id: ctx.userId,
    title,
    seq: 0,
    updated_at: now(),
  };
  db.boards.push(board);
  db.members.push({
    board_id: board.id,
    user_id: ctx.userId,
    role: "owner",
    added_at: now(),
  });
  record(board.id, ctx.userId, "board.created", `${userById(ctx.userId).display_name} created ${title}`, {
    board_id: board.id,
  });
  return json(201, {
    id: board.id,
    title: board.title,
    role: "owner",
    member_count: 1,
    card_count: 0,
    updated_at: board.updated_at,
  });
});

route("GET", /^\/api\/boards\/(\d+)$/, (ctx, params) => {
  if (ctx.userId === null) return fail(401, "Not authenticated.");
  const boardId = Number(params[0]);
  const role = membership(boardId, ctx.userId);
  if (!role) return NOT_FOUND(); // also the answer for a non-member
  const board = db.boards.find((b) => b.id === boardId);
  if (!board) return NOT_FOUND();

  const members: BoardMember[] = db.members
    .filter((m) => m.board_id === boardId)
    .map((m) => ({ user: userById(m.user_id), role: m.role, added_at: m.added_at }));

  const snapshot: BoardSnapshot = {
    id: board.id,
    title: board.title,
    seq: board.seq,
    role,
    members,
    lists: byOrder(db.lists.filter((l) => l.board_id === boardId)).map((l) => ({
      id: l.id,
      title: l.title,
      order_key: l.order_key,
      cards: byOrder(db.cards.filter((c) => c.list_id === l.id)).map(serializeCard),
    })),
    activity: db.activity
      .filter((a) => a.board_id === boardId)
      .sort((a, b) => b.id - a.id)
      .slice(0, 50),
  };
  return json(200, snapshot);
});

route("PATCH", /^\/api\/boards\/(\d+)$/, (ctx, params) => {
  if (ctx.userId === null) return fail(401, "Not authenticated.");
  const boardId = Number(params[0]);
  if (membership(boardId, ctx.userId) !== "owner") return NOT_FOUND();
  const board = db.boards.find((b) => b.id === boardId);
  if (!board) return NOT_FOUND();
  const title = String(ctx.body.title ?? "").trim();
  if (!title) return fail(422, "Board title is required.");
  board.title = title;
  record(boardId, ctx.userId, "board.renamed", `${userById(ctx.userId).display_name} renamed the board to ${title}`, {
    board_id: boardId,
  });
  return json(200, { id: board.id, title: board.title });
});

route("DELETE", /^\/api\/boards\/(\d+)$/, (ctx, params) => {
  if (ctx.userId === null) return fail(401, "Not authenticated.");
  const boardId = Number(params[0]);
  if (membership(boardId, ctx.userId) !== "owner") return NOT_FOUND();
  const listIds = db.lists.filter((l) => l.board_id === boardId).map((l) => l.id);
  db.cards = db.cards.filter((c) => !listIds.includes(c.list_id));
  db.lists = db.lists.filter((l) => l.board_id !== boardId);
  db.comments = db.comments.filter((c) => c.board_id !== boardId);
  db.activity = db.activity.filter((a) => a.board_id !== boardId);
  db.members = db.members.filter((m) => m.board_id !== boardId);
  db.boards = db.boards.filter((b) => b.id !== boardId);
  return noContent();
});

route("POST", /^\/api\/boards\/(\d+)\/members$/, (ctx, params) => {
  if (ctx.userId === null) return fail(401, "Not authenticated.");
  const boardId = Number(params[0]);
  if (membership(boardId, ctx.userId) !== "owner") return NOT_FOUND();
  const email = String(ctx.body.email ?? "").trim();
  const user = db.users.find((u) => u.email.toLowerCase() === email.toLowerCase());
  if (!user) return fail(404, "No account with that email address.");
  if (membership(boardId, user.id)) {
    return fail(409, "That person is already a member of this board.");
  }
  const added_at = now();
  db.members.push({ board_id: boardId, user_id: user.id, role: "member", added_at });
  record(boardId, ctx.userId, "member.added", `${userById(ctx.userId).display_name} added ${user.display_name} to the board`, {
    user_id: user.id,
  });
  return json(201, { user: userById(user.id), role: "member", added_at });
});

route("DELETE", /^\/api\/boards\/(\d+)\/members\/(\d+)$/, (ctx, params) => {
  if (ctx.userId === null) return fail(401, "Not authenticated.");
  const boardId = Number(params[0]);
  const userId = Number(params[1]);
  if (membership(boardId, ctx.userId) !== "owner") return NOT_FOUND();
  if (membership(boardId, userId) === "owner") {
    return fail(409, "The board owner cannot be removed.");
  }
  const target = userById(userId);
  db.members = db.members.filter((m) => !(m.board_id === boardId && m.user_id === userId));
  record(boardId, ctx.userId, "member.removed", `${userById(ctx.userId).display_name} removed ${target.display_name} from the board`, {
    user_id: userId,
  });
  return noContent();
});

/* ---------------------------- Contract 3 ---------------------------- */

route("POST", /^\/api\/boards\/(\d+)\/lists$/, (ctx, params) => {
  if (ctx.userId === null) return fail(401, "Not authenticated.");
  const boardId = Number(params[0]);
  if (!membership(boardId, ctx.userId)) return NOT_FOUND();
  const title = String(ctx.body.title ?? "").trim();
  if (!title) return fail(422, "List title is required.");

  const siblings = byOrder(db.lists.filter((l) => l.board_id === boardId));
  const afterId = ctx.body.after_list_id == null ? null : Number(ctx.body.after_list_id);
  const idx = afterId === null ? siblings.length - 1 : siblings.findIndex((l) => l.id === afterId);
  const before = siblings[idx]?.order_key ?? null;
  const after = siblings[idx + 1]?.order_key ?? null;

  const list: MockList = {
    id: nextId(),
    board_id: boardId,
    title,
    order_key: asOrderKey(fixtureKeyBetween(before, after)),
  };
  db.lists.push(list);
  record(boardId, ctx.userId, "list.created", `${userById(ctx.userId).display_name} added list ${title}`, {
    list_id: list.id,
  });
  return json(201, { id: list.id, board_id: boardId, title, order_key: list.order_key, cards: [] });
});

route("PATCH", /^\/api\/lists\/(\d+)$/, (ctx, params) => {
  if (ctx.userId === null) return fail(401, "Not authenticated.");
  const list = db.lists.find((l) => l.id === Number(params[0]));
  if (!list || !membership(list.board_id, ctx.userId)) return fail(404, "List not found.");
  const title = String(ctx.body.title ?? "").trim();
  if (!title) return fail(422, "List title is required.");
  list.title = title;
  record(list.board_id, ctx.userId, "list.renamed", `${userById(ctx.userId).display_name} renamed a list to ${title}`, {
    list_id: list.id,
  });
  return json(200, { id: list.id, title: list.title });
});

route("PATCH", /^\/api\/lists\/(\d+)\/move$/, (ctx, params) => {
  if (ctx.userId === null) return fail(401, "Not authenticated.");
  const list = db.lists.find((l) => l.id === Number(params[0]));
  if (!list || !membership(list.board_id, ctx.userId)) return fail(404, "List not found.");
  const beforeId = ctx.body.before_list_id == null ? null : Number(ctx.body.before_list_id);
  const afterId = ctx.body.after_list_id == null ? null : Number(ctx.body.after_list_id);
  const before = beforeId === null ? null : (db.lists.find((l) => l.id === beforeId)?.order_key ?? null);
  const after = afterId === null ? null : (db.lists.find((l) => l.id === afterId)?.order_key ?? null);
  list.order_key = asOrderKey(fixtureKeyBetween(before, after));
  return json(200, { id: list.id, order_key: list.order_key });
});

route("DELETE", /^\/api\/lists\/(\d+)$/, (ctx, params) => {
  if (ctx.userId === null) return fail(401, "Not authenticated.");
  const list = db.lists.find((l) => l.id === Number(params[0]));
  if (!list || !membership(list.board_id, ctx.userId)) return fail(404, "List not found.");
  const cardIds = db.cards.filter((c) => c.list_id === list.id).map((c) => c.id);
  db.cards = db.cards.filter((c) => c.list_id !== list.id);
  db.comments = db.comments.filter((c) => !cardIds.includes(c.card_id));
  db.lists = db.lists.filter((l) => l.id !== list.id);
  record(list.board_id, ctx.userId, "list.deleted", `${userById(ctx.userId).display_name} deleted list ${list.title}`, {
    list_id: list.id,
  });
  return noContent();
});

route("POST", /^\/api\/lists\/(\d+)\/cards$/, (ctx, params) => {
  if (ctx.userId === null) return fail(401, "Not authenticated.");
  const list = db.lists.find((l) => l.id === Number(params[0]));
  if (!list || !membership(list.board_id, ctx.userId)) return fail(404, "List not found.");
  const title = String(ctx.body.title ?? "").trim();
  if (!title) return fail(422, "Card title is required.");

  const siblings = byOrder(db.cards.filter((c) => c.list_id === list.id));
  const afterId = ctx.body.after_card_id == null ? null : Number(ctx.body.after_card_id);
  const idx = afterId === null ? siblings.length - 1 : siblings.findIndex((c) => c.id === afterId);
  const before = siblings[idx]?.order_key ?? null;
  const after = siblings[idx + 1]?.order_key ?? null;

  const card: MockCard = {
    id: nextId(),
    list_id: list.id,
    board_id: list.board_id,
    title,
    description: "",
    order_key: asOrderKey(fixtureKeyBetween(before, after)),
    comment_count: 0,
    created_by_id: ctx.userId,
    created_at: now(),
    updated_at: now(),
  };
  db.cards.push(card);
  record(list.board_id, ctx.userId, "card.created", `${userById(ctx.userId).display_name} added ${title} to ${list.title}`, {
    card_id: card.id,
    card_title: title,
  });
  return json(201, serializeCard(card));
});

route("PATCH", /^\/api\/cards\/(\d+)$/, (ctx, params) => {
  if (ctx.userId === null) return fail(401, "Not authenticated.");
  const card = db.cards.find((c) => c.id === Number(params[0]));
  if (!card || !membership(card.board_id, ctx.userId)) return fail(404, "Card not found.");
  const actor = userById(ctx.userId).display_name;

  if ("title" in ctx.body) {
    const title = String(ctx.body.title ?? "").trim();
    if (!title) return fail(422, "Card title is required.");
    card.title = title;
    record(card.board_id, ctx.userId, "card.renamed", `${actor} renamed a card to ${title}`, {
      card_id: card.id,
      card_title: title,
    });
  }
  if ("description" in ctx.body) {
    card.description = String(ctx.body.description ?? "");
    record(card.board_id, ctx.userId, "card.described", `${actor} updated the description of ${card.title}`, {
      card_id: card.id,
      card_title: card.title,
    });
  }
  card.updated_at = now();
  return json(200, serializeCard(card));
});

/** THE INTERESTING ONE. Neighbour ids in, an authoritative order_key out. */
route("PATCH", /^\/api\/cards\/(\d+)\/move$/, (ctx, params) => {
  if (ctx.userId === null) return fail(401, "Not authenticated.");
  const card = db.cards.find((c) => c.id === Number(params[0]));
  if (!card || !membership(card.board_id, ctx.userId)) return fail(404, "Card not found.");

  const listId = Number(ctx.body.list_id);
  const dest = db.lists.find((l) => l.id === listId);
  if (!dest) return fail(404, "Card not found.");
  if (dest.board_id !== card.board_id) return fail(422, "Cards cannot be moved to another board.");

  const beforeId = ctx.body.before_card_id == null ? null : Number(ctx.body.before_card_id);
  const afterId = ctx.body.after_card_id == null ? null : Number(ctx.body.after_card_id);

  // Re-read both neighbours: if either no longer sits in the destination list,
  // 409 rather than guessing a position from stale input.
  const neighbour = (id: number | null): MockCard | null | "stale" => {
    if (id === null) return null;
    const c = db.cards.find((x) => x.id === id);
    if (!c || c.list_id !== listId) return "stale";
    return c;
  };
  const before = neighbour(beforeId);
  const after = neighbour(afterId);
  if (before === "stale" || after === "stale") {
    return fail(409, "The board changed while you were dragging. Refreshing.");
  }

  const fromList = db.lists.find((l) => l.id === card.list_id);
  const fromTitle = fromList?.title ?? "";
  card.list_id = listId;
  card.order_key = asOrderKey(fixtureKeyBetween(before?.order_key ?? null, after?.order_key ?? null));
  card.updated_at = now();

  const actor = userById(ctx.userId).display_name;
  const summary =
    fromTitle === dest.title
      ? `${actor} reordered ${card.title} in ${dest.title}`
      : `${actor} moved ${card.title} from ${fromTitle} to ${dest.title}`;
  record(card.board_id, ctx.userId, "card.moved", summary, {
    card_id: card.id,
    card_title: card.title,
    from_list: fromTitle,
    to_list: dest.title,
  });
  return json(200, serializeCard(card));
});

route("DELETE", /^\/api\/cards\/(\d+)$/, (ctx, params) => {
  if (ctx.userId === null) return fail(401, "Not authenticated.");
  const card = db.cards.find((c) => c.id === Number(params[0]));
  if (!card || !membership(card.board_id, ctx.userId)) return fail(404, "Card not found.");
  db.cards = db.cards.filter((c) => c.id !== card.id);
  db.comments = db.comments.filter((c) => c.card_id !== card.id);
  record(card.board_id, ctx.userId, "card.deleted", `${userById(ctx.userId).display_name} deleted ${card.title}`, {
    card_id: card.id,
    card_title: card.title,
  });
  return noContent();
});

/* ---------------------------- Contract 5 ---------------------------- */

route("GET", /^\/api\/cards\/(\d+)\/comments$/, (ctx, params) => {
  if (ctx.userId === null) return fail(401, "Not authenticated.");
  const card = db.cards.find((c) => c.id === Number(params[0]));
  if (!card || !membership(card.board_id, ctx.userId)) return fail(404, "Card not found.");
  const comments = db.comments
    .filter((c) => c.card_id === card.id)
    .sort((a, b) => a.id - b.id); // oldest first
  return json(200, { comments });
});

route("POST", /^\/api\/cards\/(\d+)\/comments$/, (ctx, params) => {
  if (ctx.userId === null) return fail(401, "Not authenticated.");
  const card = db.cards.find((c) => c.id === Number(params[0]));
  if (!card || !membership(card.board_id, ctx.userId)) return fail(404, "Card not found.");
  const body = String(ctx.body.body ?? "").trim();
  if (!body || body.length > 2000) return fail(422, "Comment cannot be empty.");
  const comment: Comment = {
    id: nextId(),
    card_id: card.id,
    board_id: card.board_id,
    author: userById(ctx.userId),
    body,
    created_at: now(),
  };
  db.comments.push(comment);
  record(card.board_id, ctx.userId, "comment.added", `${userById(ctx.userId).display_name} commented on ${card.title}`, {
    card_id: card.id,
    card_title: card.title,
  });
  return json(201, comment);
});

route("DELETE", /^\/api\/comments\/(\d+)$/, (ctx, params) => {
  if (ctx.userId === null) return fail(401, "Not authenticated.");
  const comment = db.comments.find((c) => c.id === Number(params[0]));
  // Also the answer for someone else's comment -- authorship is not probeable.
  if (!comment || comment.author.id !== ctx.userId) return fail(404, "Comment not found.");
  db.comments = db.comments.filter((c) => c.id !== comment.id);
  return noContent();
});

route("GET", /^\/api\/boards\/(\d+)\/activity$/, (ctx, params) => {
  if (ctx.userId === null) return fail(401, "Not authenticated.");
  const boardId = Number(params[0]);
  if (!membership(boardId, ctx.userId)) return NOT_FOUND();
  const limit = Number(ctx.url.searchParams.get("limit") ?? 50);
  const beforeIdRaw = ctx.url.searchParams.get("before_id");
  const beforeId = beforeIdRaw === null ? null : Number(beforeIdRaw);

  const all = db.activity
    .filter((a) => a.board_id === boardId)
    .sort((a, b) => b.id - a.id)
    .filter((a) => (beforeId === null ? true : a.id < beforeId));
  const page = all.slice(0, limit);
  const last = page[page.length - 1];
  const next_before_id = all.length > page.length && last ? last.id : null;
  return json(200, { activity: page, next_before_id });
});

/* -------------------------- Contract 6 §1 --------------------------- */

route("POST", /^\/api\/realtime\/ticket$/, (ctx) => {
  if (ctx.userId === null) return fail(401, "Not authenticated.");
  const boardId = Number(ctx.body.board_id);
  if (!membership(boardId, ctx.userId)) return NOT_FOUND();
  const ticket = `tk-${Math.random().toString(36).slice(2)}`;
  // Single-use, 30 s, bound to (user_id, board_id).
  db.tickets.set(ticket, { user_id: ctx.userId, board_id: boardId, used: false });
  return json(201, { ticket, expires_in: 30 });
});

/** Exposed so a test can assert single-use semantics without a real socket. */
export function consumeMockTicket(ticket: string): { user_id: number; board_id: number } | null {
  const entry = db.tickets.get(ticket);
  if (!entry || entry.used) return null;
  entry.used = true;
  return { user_id: entry.user_id, board_id: entry.board_id };
}

/* ------------------------------------------------------------------ *
 * The transport
 * ------------------------------------------------------------------ */

/** Artificial latency, so optimistic UI is visible in dev rather than instant. */
let latencyMs = 0;
export const setMockLatency = (ms: number): void => {
  latencyMs = ms;
};

/** Force the next matching request to fail — for exercising rollback by hand. */
let failNext: { pattern: RegExp; status: number; error: string } | null = null;
export const failNextRequest = (pattern: RegExp, status: number, error: string): void => {
  failNext = { pattern, status, error };
};

export async function mockTransport(input: string, init?: RequestInit): Promise<Response> {
  const url = new URL(input, "http://mock.local");
  const method = (init?.method ?? "GET").toUpperCase();
  const path = url.pathname;

  if (latencyMs > 0) await new Promise((r) => setTimeout(r, latencyMs));

  if (failNext && failNext.pattern.test(path)) {
    const { status, error } = failNext;
    failNext = null;
    return fail(status, error);
  }

  let body: Record<string, unknown> = {};
  if (typeof init?.body === "string") {
    try {
      body = JSON.parse(init.body) as Record<string, unknown>;
    } catch {
      return fail(400, "The request body was not valid JSON.");
    }
  }

  const ctx: Ctx = { userId: currentUserId(init), body, method, url };

  for (const r of routes) {
    if (r.method !== method) continue;
    const match = r.pattern.exec(path);
    if (!match) continue;
    return r.handler(ctx, match.slice(1));
  }
  return fail(404, "Not found.");
}
