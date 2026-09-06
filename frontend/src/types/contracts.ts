/**
 * Frozen interface contracts, transcribed to TypeScript.
 *
 * These types are a CONSUMER's transcription of Contracts 1-8 in the root
 * CLAUDE.md. Instance 1 produces them; this file must not drift from the
 * contract text. src/test/contract.test.ts asserts the stubs match these
 * shapes field-for-field.
 *
 * Nothing here is invented. If a shape looks wrong, that is an ESCALATION,
 * not an edit.
 */

/* ------------------------------------------------------------------ *
 * Contract 4 — order keys
 * ------------------------------------------------------------------ */

/**
 * An OPAQUE sortable string minted by the server. Contract 4:
 *
 *   The client MUST NOT generate a key, parse one, measure its length, or
 *   compute a midpoint; must not infer position from a key; must not assume
 *   keys are dense, contiguous, evenly spaced or of equal length.
 *
 * The brand exists to make that mechanical: you cannot produce an OrderKey
 * from a string literal anywhere in this codebase except by receiving one
 * from the server (`asOrderKey`, used only at the parse boundary) or by
 * asking for the optimistic placeholder (`PENDING_ORDER_KEY`).
 */
export type OrderKey = string & { readonly __brand: "OrderKey" };

/** Parse-boundary cast. Only api/ and realtime/ decoding may call this. */
export const asOrderKey = (raw: string): OrderKey => raw as OrderKey;

/**
 * The placeholder an optimistically-moved row carries until the server's
 * authoritative key arrives with the echo (Contract 7 §8). It is never sent
 * to the server and never compared for meaning -- rows holding it are pinned
 * by their local array position, not by this value.
 */
export const PENDING_ORDER_KEY = "\u0000pending" as OrderKey;

export const isPendingOrderKey = (k: OrderKey): boolean =>
  k === PENDING_ORDER_KEY;

/* ------------------------------------------------------------------ *
 * Contract 1 — Authentication
 * ------------------------------------------------------------------ */

export interface User {
  id: number;
  email: string;
  /** Never null on the wire; the server falls back to the email local-part. */
  display_name: string;
  /** Deterministic from id; never null. Hex string, e.g. "#3B82F6". */
  avatar_color: string;
  created_at: string;
}

export interface AuthSession {
  access_token: string;
  token_type: "bearer";
  expires_in: number;
  user: User;
}

export interface RefreshResponse {
  access_token: string;
  token_type: "bearer";
  expires_in: number;
}

export interface SignupRequest {
  email: string;
  password: string;
  display_name: string | null;
}

export interface LoginRequest {
  email: string;
  password: string;
}

/* ------------------------------------------------------------------ *
 * Contract 2 — Boards & membership
 * ------------------------------------------------------------------ */

export type BoardRole = "owner" | "member";

export interface BoardSummary {
  id: number;
  title: string;
  role: BoardRole;
  member_count: number;
  card_count: number;
  updated_at: string;
}

export interface BoardMember {
  user: User;
  role: BoardRole;
  added_at: string;
}

/** GET /api/boards/{id} — THE SNAPSHOT. `seq` is load-bearing (Contract 2). */
export interface BoardSnapshot {
  id: number;
  title: string;
  /** Last event applied to this board; the client's starting cursor. */
  seq: number;
  role: BoardRole;
  members: BoardMember[];
  lists: BoardList[];
  /** Most recent 50, newest first. */
  activity: Activity[];
}

/* ------------------------------------------------------------------ *
 * Contract 3 — Lists & cards
 * ------------------------------------------------------------------ */

export interface Card {
  id: number;
  list_id: number;
  board_id: number;
  title: string;
  /** Markdown-free plain text, may be "". */
  description: string;
  order_key: OrderKey;
  comment_count: number;
  created_by: User;
  created_at: string;
  updated_at: string;
}

export interface BoardList {
  id: number;
  title: string;
  order_key: OrderKey;
  cards: Card[];
}

/** POST /api/boards/{id}/lists response carries board_id; the snapshot's does not. */
export interface CreatedList extends BoardList {
  board_id: number;
}

export interface CreateListRequest {
  title: string;
  /** null = append to the end. */
  after_list_id: number | null;
}

export interface MoveListRequest {
  before_list_id: number | null;
  after_list_id: number | null;
}

export interface CreateCardRequest {
  title: string;
  /** null = append to the end. */
  after_card_id: number | null;
}

/** PATCH /api/cards/{id} — partial; an absent field is unchanged. */
export interface UpdateCardRequest {
  title?: string;
  description?: string;
}

/**
 * PATCH /api/cards/{id}/move.
 * The client sends NEIGHBOUR IDS, never keys. The server computes the key.
 */
export interface MoveCardRequest {
  /** Destination list; may equal the current one. */
  list_id: number;
  /** The card ABOVE the drop point; null = top of the list. */
  before_card_id: number | null;
  /** The card BELOW the drop point; null = bottom of the list. */
  after_card_id: number | null;
}

/* ------------------------------------------------------------------ *
 * Contract 5 — Comments & activity
 * ------------------------------------------------------------------ */

export interface Comment {
  id: number;
  card_id: number;
  board_id: number;
  author: User;
  /** 1..2000 chars, plain text. */
  body: string;
  created_at: string;
}

export const ACTIVITY_VERBS = [
  "board.created",
  "board.renamed",
  "member.added",
  "member.removed",
  "list.created",
  "list.renamed",
  "list.deleted",
  "card.created",
  "card.moved",
  "card.renamed",
  "card.described",
  "card.deleted",
  "comment.added",
] as const;

export type ActivityVerb = (typeof ACTIVITY_VERBS)[number];

export interface Activity {
  id: number;
  board_id: number;
  actor: User;
  verb: ActivityVerb;
  /**
   * SERVER-RENDERED on purpose. Print it verbatim. Contract 5 forbids
   * reconstructing a sentence from verb + subject.
   */
  summary: string;
  /** For linking the card and bolding a name -- not for composing prose. */
  subject: Record<string, unknown> & {
    card_id?: number;
    card_title?: string;
    from_list?: string;
    to_list?: string;
  };
  created_at: string;
}

export interface ActivityPage {
  activity: Activity[];
  next_before_id: number | null;
}

/* ------------------------------------------------------------------ *
 * Contract 6 §1 — realtime ticket
 * ------------------------------------------------------------------ */

export interface RealtimeTicket {
  ticket: string;
  expires_in: number;
}

/* ------------------------------------------------------------------ *
 * Contract 8 — the error envelope
 * ------------------------------------------------------------------ */

/** EVERY non-2xx body, from every endpoint, without exception. No `detail`. */
export interface ErrorEnvelope {
  error: string;
}

export function isErrorEnvelope(value: unknown): value is ErrorEnvelope {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { error?: unknown }).error === "string"
  );
}
