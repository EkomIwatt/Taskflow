/**
 * The realtime client — Contract 6 §6 implemented literally.
 *
 *   fetch a ticket -> connect -> hello -> heartbeat with a 60 s dead-man timer
 *   -> exponential backoff with jitter on reconnect -> seq gap detection
 *   (delegated to the board reducer) -> snapshot refetch.
 *
 * ONE connection per open board, owned by this module. It does not touch React
 * state directly: it emits envelopes through `onEvent` into the single board
 * reducer.
 *
 * The transport is injected, so `fakeSocket.ts` drives every path in tests --
 * silence, duplicates, gaps, out-of-order frames and every close code.
 */

import type { RealtimeTicket } from "../types/contracts";
import type { ConnectionStatus } from "../board/types";
import {
  CloseCode,
  DEAD_MAN_TIMEOUT_MS,
  PONG_FRAME,
  backoffDelay,
  isEnvelope,
  type Envelope,
  type ServerEvent,
} from "./protocol";

/** The subset of the browser WebSocket surface this client uses. */
export interface SocketLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: (() => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code: number; reason?: string }) => void) | null;
  onerror: (() => void) | null;
}

export type SocketFactory = (url: string) => SocketLike;

export interface RealtimeClientOptions {
  boardId: number;
  /** e.g. "ws://localhost:8000". In prod this is the Render origin DIRECTLY. */
  wsBase: string;
  /** An ordinary authenticated call; it goes through the 401-refresh path. */
  fetchTicket: (boardId: number) => Promise<RealtimeTicket>;
  /** The auth-refresh flow, run after a second consecutive 4001. */
  refreshSession: () => Promise<string | null>;
  onEvent: (event: ServerEvent) => void;
  onStatus: (status: ConnectionStatus) => void;
  /** 4003 / 4004: do not reconnect, route away with this sentence. */
  onDenied: (reason: string) => void;
  socketFactory?: SocketFactory;
  /** Test seam for deterministic jitter. */
  random?: () => number;
}

const defaultFactory: SocketFactory = (url) => new WebSocket(url) as unknown as SocketLike;

export class RealtimeClient {
  private readonly opts: Required<Pick<RealtimeClientOptions, "socketFactory" | "random">> &
    RealtimeClientOptions;

  private socket: SocketLike | null = null;
  /** Backoff position. Reset to 0 on a successful `hello`. */
  private attempt = 0;
  /** Consecutive 4001s. 1 -> retry with a fresh ticket; 2 -> refresh auth first. */
  private ticketFailures = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private deadManTimer: ReturnType<typeof setTimeout> | null = null;
  /** True once stop() has been called: nothing may reconnect after that. */
  private stopped = false;
  /** True while this client is deliberately tearing a socket down. */
  private closingSelf = false;

  constructor(options: RealtimeClientOptions) {
    this.opts = {
      ...options,
      socketFactory: options.socketFactory ?? defaultFactory,
      random: options.random ?? Math.random,
    };
  }

  /** Begin. Safe to call once per mounted board. */
  start(): void {
    this.stopped = false;
    this.setStatus("connecting");
    void this.connect();
  }

  /**
   * Close deliberately with 1000 (Contract 6 §5: the peer must NOT reconnect).
   * Called on unmount and when navigating away from the board.
   */
  stop(): void {
    this.stopped = true;
    this.clearTimers();
    this.teardownSocket(CloseCode.NORMAL);
    this.setStatus("closed");
  }

  /* ---------------------------------------------------------------- */

  private setStatus(status: ConnectionStatus): void {
    this.opts.onStatus(status);
  }

  private clearTimers(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.deadManTimer !== null) {
      clearTimeout(this.deadManTimer);
      this.deadManTimer = null;
    }
  }

  private teardownSocket(code: number): void {
    const sock = this.socket;
    if (!sock) return;
    this.socket = null;
    this.closingSelf = true;
    sock.onopen = null;
    sock.onmessage = null;
    sock.onclose = null;
    sock.onerror = null;
    try {
      sock.close(code);
    } catch {
      /* already closed */
    }
    this.closingSelf = false;
  }

  /**
   * Any frame of any kind resets this. 60 s of silence means the socket is
   * dead even though the OS has not noticed: close it and reconnect (§6.1).
   */
  private armDeadMan(): void {
    if (this.deadManTimer !== null) clearTimeout(this.deadManTimer);
    this.deadManTimer = setTimeout(() => {
      this.teardownSocket(CloseCode.SERVER_ERROR);
      this.scheduleReconnect();
    }, DEAD_MAN_TIMEOUT_MS);
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;

    let ticket: RealtimeTicket;
    try {
      // A ticket is SINGLE-USE, so every reconnect fetches a fresh one.
      ticket = await this.opts.fetchTicket(this.opts.boardId);
    } catch (err) {
      // A 404 here means non-member (Contract 6 §1) -- same verdict as a 4003.
      if (typeof err === "object" && err !== null && (err as { status?: number }).status === 404) {
        this.opts.onDenied("Board not found.");
        this.stopped = true;
        this.setStatus("denied");
        return;
      }
      this.scheduleReconnect();
      return;
    }

    if (this.stopped) return;

    const url = `${this.opts.wsBase}/ws/boards/${this.opts.boardId}?ticket=${encodeURIComponent(
      ticket.ticket,
    )}`;

    let sock: SocketLike;
    try {
      sock = this.opts.socketFactory(url);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.socket = sock;

    sock.onopen = () => {
      // Not "open" yet -- the connection is only live once `hello` lands.
      this.armDeadMan();
    };

    sock.onmessage = (ev) => this.handleMessage(ev.data);

    sock.onerror = () => {
      /* onclose always follows; recovery lives there so there is one path. */
    };

    sock.onclose = (ev) => {
      if (this.closingSelf) return;
      this.socket = null;
      this.clearTimers();
      this.handleClose(ev.code);
    };
  }

  private handleMessage(raw: unknown): void {
    // A frame of ANY kind proves the socket is alive.
    this.armDeadMan();

    if (typeof raw !== "string") return;

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return; // unparseable frame: ignore silently
    }
    if (!isEnvelope(parsed)) return;

    const envelope = parsed as Envelope;

    // The heartbeat: reply immediately. This is the ONLY message the client
    // ever sends -- the socket is broadcast-only in the other direction.
    if (envelope.type === "ping") {
      try {
        this.socket?.send(PONG_FRAME);
      } catch {
        /* the close handler will deal with it */
      }
      return;
    }

    if (envelope.type === "hello") {
      // A successful hello resets both retry counters (§6.2).
      this.attempt = 0;
      this.ticketFailures = 0;
      this.setStatus("open");
    }

    // Everything else -- including unknown types -- is forwarded verbatim.
    // The reducer owns the seq rules and the silent-ignore rule.
    this.opts.onEvent(envelope as ServerEvent);
  }

  private handleClose(code: number): void {
    if (this.stopped) return;

    switch (code) {
      case CloseCode.NORMAL:
        // The peer closed cleanly; do not reconnect.
        this.setStatus("closed");
        return;

      case CloseCode.NOT_A_MEMBER:
        this.stopped = true;
        this.setStatus("denied");
        this.opts.onDenied("You no longer have access to this board.");
        return;

      case CloseCode.BOARD_NOT_FOUND:
        this.stopped = true;
        this.setStatus("denied");
        this.opts.onDenied("Board not found.");
        return;

      case CloseCode.BAD_TICKET: {
        // §5: fetch a NEW ticket and reconnect once. If that fails again, run
        // the auth-refresh flow, then retry -- the access token had expired,
        // which must not surface as a re-login prompt.
        this.ticketFailures += 1;
        this.setStatus("reconnecting");
        if (this.ticketFailures === 1) {
          void this.connect();
          return;
        }
        if (this.ticketFailures === 2) {
          void this.opts.refreshSession().then(() => {
            if (!this.stopped) void this.connect();
          });
          return;
        }
        // Still failing: fall back to ordinary backoff rather than hot-loop.
        this.scheduleReconnect();
        return;
      }

      default:
        // 1011 and every abnormal closure: reconnect with backoff.
        this.scheduleReconnect();
    }
  }

  /**
   * §6.2: 1 s, 2 s, 4 s, 8 s, 16 s, then 30 s capped, with jitter. Never a
   * tight loop -- a Render cold start can take 30 s and must not become a
   * stampede.
   */
  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer !== null) return;
    this.setStatus("reconnecting");
    const delay = backoffDelay(this.attempt, this.opts.random);
    this.attempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, delay);
  }
}
