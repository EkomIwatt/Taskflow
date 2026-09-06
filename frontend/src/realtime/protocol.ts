/**
 * Contract 6 — the WebSocket protocol, transcribed.
 *
 * Server -> client carries state changes. Client -> server carries NOTHING but
 * `pong` (project-wide convention). There is no client->server mutation message
 * and adding one is an escalation, not a patch.
 */

import type {
  Activity,
  BoardList,
  BoardRole,
  Card,
  Comment,
  OrderKey,
  User,
} from "../types/contracts";

/* ------------------------------------------------------------------ *
 * §2 — the envelope
 * ------------------------------------------------------------------ */

export interface Envelope<TType extends string = string, TPayload = unknown> {
  type: TType;
  /** Always present; the client drops frames for any other board. */
  board_id: number;
  /** Per-board monotonic int for state events; null for ephemeral events. */
  seq: number | null;
  /** The user who caused it; null for server-originated events. */
  actor_id: number | null;
  /** Echoed from X-Client-Op-Id, else null (Contract 7). */
  client_op_id: string | null;
  /** ISO-8601 UTC. Informational -- `seq` orders events, never `ts`. */
  ts: string;
  payload: TPayload;
}

/* ------------------------------------------------------------------ *
 * §3 — state events (carry a seq)
 * ------------------------------------------------------------------ */

export interface HelloPayload {
  board_id: number;
  seq: number;
  you: User;
  online: User[];
}

export interface BoardUpdatedPayload {
  id: number;
  title: string;
}

export interface MemberAddedPayload {
  user: User;
  role: BoardRole;
}

export interface MemberRemovedPayload {
  user_id: number;
}

export interface ListUpdatedPayload {
  id: number;
  title: string;
}

export interface ListMovedPayload {
  id: number;
  order_key: OrderKey;
}

export interface ListDeletedPayload {
  id: number;
}

/** Contract 4's escape hatch. Replace that list's keys wholesale and re-sort. */
export interface ListRebalancedPayload {
  list_id: number;
  cards: Array<{ id: number; order_key: OrderKey }>;
}

export interface CardMovedPayload {
  id: number;
  list_id: number;
  from_list_id: number;
  order_key: OrderKey;
  updated_at: string;
}

export interface CardDeletedPayload {
  id: number;
  list_id: number;
}

/* ------------------------------------------------------------------ *
 * §4 — ephemeral events (seq is null, never persisted, never replayed)
 * ------------------------------------------------------------------ */

export interface PresenceJoinedPayload {
  user: User;
}

export interface PresenceLeftPayload {
  user_id: number;
}

/* ------------------------------------------------------------------ *
 * The discriminated union
 * ------------------------------------------------------------------ */

export type ServerEvent =
  | Envelope<"hello", HelloPayload>
  | Envelope<"board.updated", BoardUpdatedPayload>
  | Envelope<"board.member_added", MemberAddedPayload>
  | Envelope<"board.member_removed", MemberRemovedPayload>
  | Envelope<"list.created", BoardList>
  | Envelope<"list.updated", ListUpdatedPayload>
  | Envelope<"list.moved", ListMovedPayload>
  | Envelope<"list.deleted", ListDeletedPayload>
  | Envelope<"list.rebalanced", ListRebalancedPayload>
  | Envelope<"card.created", Card>
  | Envelope<"card.updated", Card>
  | Envelope<"card.moved", CardMovedPayload>
  | Envelope<"card.deleted", CardDeletedPayload>
  | Envelope<"comment.created", Comment>
  | Envelope<"activity.appended", Activity>
  | Envelope<"presence.joined", PresenceJoinedPayload>
  | Envelope<"presence.left", PresenceLeftPayload>
  | Envelope<"ping", Record<string, never>>;

export type ServerEventType = ServerEvent["type"];

/**
 * Event types this client knows how to apply. An envelope whose `type` is NOT
 * in here MUST be ignored silently (§2): no throw, no user-visible log, no
 * refetch. That is what lets the server ship a new event type without breaking
 * deployed clients.
 */
const KNOWN_TYPES = new Set<string>([
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
]);

export const isKnownEventType = (type: string): type is ServerEventType =>
  KNOWN_TYPES.has(type);

/**
 * Ephemeral events must NOT advance the client's seq cursor (§4). They are
 * identified by type, not by a null seq -- a null seq on a state event would
 * be a server bug, and treating type as authoritative keeps the rule explicit.
 */
const EPHEMERAL_TYPES = new Set<string>([
  "presence.joined",
  "presence.left",
  "ping",
]);

export const isEphemeralEvent = (type: string): boolean =>
  EPHEMERAL_TYPES.has(type);

/** Structural check on an inbound frame before anything trusts it. */
export function isEnvelope(value: unknown): value is Envelope {
  if (typeof value !== "object" || value === null) return false;
  const e = value as Record<string, unknown>;
  return (
    typeof e.type === "string" &&
    typeof e.board_id === "number" &&
    (typeof e.seq === "number" || e.seq === null) &&
    (typeof e.actor_id === "number" || e.actor_id === null) &&
    (typeof e.client_op_id === "string" || e.client_op_id === null) &&
    typeof e.ts === "string" &&
    typeof e.payload === "object"
  );
}

/* ------------------------------------------------------------------ *
 * §5 — close codes
 * ------------------------------------------------------------------ */

export const CloseCode = {
  /** Client navigated away. Do not reconnect. */
  NORMAL: 1000,
  /** Server error. Reconnect with backoff. */
  SERVER_ERROR: 1011,
  /** Ticket missing/invalid/expired/already used. New ticket, retry once. */
  BAD_TICKET: 4001,
  /** Not (or no longer) a member. Do NOT reconnect; route to the board list. */
  NOT_A_MEMBER: 4003,
  /** Board not found. Do not reconnect. */
  BOARD_NOT_FOUND: 4004,
} as const;

export type CloseCodeValue = (typeof CloseCode)[keyof typeof CloseCode];

/* ------------------------------------------------------------------ *
 * §6 — timing constants
 * ------------------------------------------------------------------ */

/** The server pings every 25 s. */
export const SERVER_PING_INTERVAL_MS = 25_000;
/** No frame of ANY kind for 60 s => the socket is dead. Close and reconnect. */
export const DEAD_MAN_TIMEOUT_MS = 60_000;
/** 1s, 2s, 4s, 8s, 16s, then 30s capped. Reset on a successful `hello`. */
export const BACKOFF_SCHEDULE_MS = [1_000, 2_000, 4_000, 8_000, 16_000] as const;
export const BACKOFF_CAP_MS = 30_000;

/**
 * Backoff delay for attempt n (0-indexed), with jitter.
 * Jitter is +/-25% so a Render cold start does not become a stampede.
 */
export function backoffDelay(attempt: number, random: () => number = Math.random): number {
  const base = BACKOFF_SCHEDULE_MS[attempt] ?? BACKOFF_CAP_MS;
  const jitter = (random() * 0.5 - 0.25) * base;
  return Math.max(0, Math.round(base + jitter));
}

/** The ONLY message the client ever sends. */
export const PONG_FRAME = JSON.stringify({ type: "pong" });
