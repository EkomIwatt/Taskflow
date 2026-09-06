/**
 * The scripted socket — a controllable stand-in for Instance 1's WebSocket.
 *
 * It can emit any contract envelope on demand, deliver events out of order,
 * deliver duplicates, skip a `seq` to force a gap, go silent to trip the 60 s
 * dead-man timer, and close with any code from Contract 6 §5.
 *
 * Every rule in Contract 6 §6 and Contract 7 is testable against it, and the
 * conformance suite asserts the envelopes it emits match the frozen shapes --
 * so a merge-time disagreement with the real server shows up as a failing
 * test here, not as a mystery in the browser.
 *
 * Toggled in the app by VITE_USE_FAKE_SOCKET=true.
 */

import type {
  Activity,
  BoardList,
  Card,
  Comment,
  OrderKey,
  User,
} from "../types/contracts";
import type {
  BoardUpdatedPayload,
  CardDeletedPayload,
  CardMovedPayload,
  Envelope,
  HelloPayload,
  ListDeletedPayload,
  ListMovedPayload,
  ListRebalancedPayload,
  ListUpdatedPayload,
  MemberAddedPayload,
  MemberRemovedPayload,
  PresenceJoinedPayload,
  PresenceLeftPayload,
  ServerEventType,
} from "./protocol";
import type { SocketLike } from "./socket";

/** Payload type for each event type, so the emit helpers stay type-checked. */
interface PayloadFor {
  hello: HelloPayload;
  "board.updated": BoardUpdatedPayload;
  "board.member_added": MemberAddedPayload;
  "board.member_removed": MemberRemovedPayload;
  "list.created": BoardList;
  "list.updated": ListUpdatedPayload;
  "list.moved": ListMovedPayload;
  "list.deleted": ListDeletedPayload;
  "list.rebalanced": ListRebalancedPayload;
  "card.created": Card;
  "card.updated": Card;
  "card.moved": CardMovedPayload;
  "card.deleted": CardDeletedPayload;
  "comment.created": Comment;
  "activity.appended": Activity;
  "presence.joined": PresenceJoinedPayload;
  "presence.left": PresenceLeftPayload;
  ping: Record<string, never>;
}

export interface FakeSocketOptions {
  boardId: number;
  /** The seq the fake server believes it is at; `emit` increments from here. */
  seq?: number;
  /** Auto-run onopen on construction. Off lets a test observe the pre-open gap. */
  autoOpen?: boolean;
}

/**
 * A SocketLike whose every behaviour is driven by the test.
 *
 * Instances register themselves on `FakeSocket.instances` so a test can reach
 * the socket the client created without threading a reference through.
 */
export class FakeSocket implements SocketLike {
  static instances: FakeSocket[] = [];
  static reset(): void {
    FakeSocket.instances = [];
  }
  /** The socket most recently created by the client under test. */
  static get latest(): FakeSocket {
    const s = FakeSocket.instances[FakeSocket.instances.length - 1];
    if (!s) throw new Error("FakeSocket: no socket has been created yet.");
    return s;
  }

  /** A factory to hand to RealtimeClient. */
  static factory(options: Omit<FakeSocketOptions, "boardId"> = {}) {
    return (url: string): FakeSocket => {
      const boardId = Number(url.match(/\/ws\/boards\/(\d+)/)?.[1] ?? 0);
      return new FakeSocket({ ...options, boardId });
    };
  }

  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: { code: number; reason?: string }) => void) | null = null;
  onerror: (() => void) | null = null;

  /** Everything the client has sent. Per contract this may only ever be pongs. */
  readonly sent: string[] = [];
  readonly url: string;
  readonly boardId: number;
  closed = false;
  closedWith: number | null = null;

  private seq: number;

  constructor(options: FakeSocketOptions) {
    this.boardId = options.boardId;
    this.seq = options.seq ?? 0;
    this.url = `ws://fake/ws/boards/${options.boardId}`;
    FakeSocket.instances.push(this);
    if (options.autoOpen !== false) {
      // Microtask, so the client has finished wiring its handlers.
      queueMicrotask(() => this.open());
    }
  }

  /* ------------------------- SocketLike ------------------------- */

  send(data: string): void {
    this.sent.push(data);
  }

  close(code = 1000): void {
    if (this.closed) return;
    this.closed = true;
    this.closedWith = code;
  }

  /* --------------------- test-side controls --------------------- */

  open(): void {
    this.onopen?.();
  }

  /** Deliver a raw frame exactly as written -- for malformed-input tests. */
  deliverRaw(data: unknown): void {
    this.onmessage?.({ data });
  }

  /** Deliver a fully-formed envelope without touching the seq counter. */
  deliver(envelope: Envelope): void {
    this.deliverRaw(JSON.stringify(envelope));
  }

  /** Close from the server side with any Contract 6 §5 code. */
  serverClose(code: number, reason = ""): void {
    this.closed = true;
    this.closedWith = code;
    this.onclose?.({ code, reason });
  }

  /** Go silent: deliver nothing, so the 60 s dead-man timer trips. */
  goSilent(): void {
    /* deliberately empty -- silence IS the behaviour under test */
  }

  /** The server heartbeat. The client must reply with a pong. */
  ping(): void {
    this.deliver(this.envelope("ping", {}, { seq: null }));
  }

  /** True if the client has replied to every ping with exactly `{"type":"pong"}`. */
  get pongs(): number {
    return this.sent.filter((s) => s === JSON.stringify({ type: "pong" })).length;
  }

  /* ----------------------- envelope builders --------------------- */

  /**
   * Build a contract-shaped envelope. Every field of Contract 6 §2 is present,
   * so a test can never accidentally assert against a half-built frame.
   */
  envelope<T extends ServerEventType>(
    type: T,
    payload: T extends keyof PayloadFor ? PayloadFor[T] : unknown,
    overrides: Partial<Omit<Envelope, "type" | "payload">> = {},
  ): Envelope<T, typeof payload> {
    const ephemeral = type === "presence.joined" || type === "presence.left" || type === "ping";
    return {
      type,
      board_id: overrides.board_id ?? this.boardId,
      seq: "seq" in overrides ? (overrides.seq ?? null) : ephemeral ? null : this.seq,
      actor_id: overrides.actor_id ?? null,
      client_op_id: overrides.client_op_id ?? null,
      ts: overrides.ts ?? "2026-09-06T10:00:00Z",
      payload,
    };
  }

  /**
   * The normal path: advance seq by one and deliver. This is what a healthy
   * server does, so the happy path in tests reads as one line per event.
   */
  emit<T extends ServerEventType>(
    type: T,
    payload: T extends keyof PayloadFor ? PayloadFor[T] : unknown,
    overrides: Partial<Omit<Envelope, "type" | "payload">> = {},
  ): Envelope<T, typeof payload> {
    const ephemeral = type === "presence.joined" || type === "presence.left" || type === "ping";
    if (!ephemeral && !("seq" in overrides)) this.seq += 1;
    const env = this.envelope(type, payload, overrides);
    this.deliver(env);
    return env;
  }

  /** `hello` — always the first frame after accept. */
  emitHello(payload: HelloPayload): void {
    this.seq = payload.seq;
    this.deliver(this.envelope("hello", payload, { seq: payload.seq }));
  }

  /** Deliver the same envelope twice: the duplicate must be dropped silently. */
  emitDuplicate<T extends ServerEventType>(
    type: T,
    payload: T extends keyof PayloadFor ? PayloadFor[T] : unknown,
  ): void {
    const env = this.emit(type, payload);
    this.deliver(env);
  }

  /** Skip `count` sequence numbers, forcing a gap the client must resync from. */
  skipSeq(count = 1): void {
    this.seq += count;
  }

  /** Set the counter directly -- for replaying an older seq, or jumping ahead. */
  setSeq(seq: number): void {
    this.seq = seq;
  }

  get currentSeq(): number {
    return this.seq;
  }
}

/* ------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------ */

export const fakeUser = (id: number, name: string, color = "#3B82F6"): User => ({
  id,
  email: `${name.toLowerCase()}@example.com`,
  display_name: name,
  avatar_color: color,
  created_at: "2026-09-06T10:00:00Z",
});

export const fakeCard = (
  id: number,
  listId: number,
  boardId: number,
  title: string,
  orderKey: string,
  createdBy: User,
): Card => ({
  id,
  list_id: listId,
  board_id: boardId,
  title,
  description: "",
  order_key: orderKey as OrderKey,
  comment_count: 0,
  created_by: createdBy,
  created_at: "2026-09-06T10:00:00Z",
  updated_at: "2026-09-06T10:00:00Z",
});
