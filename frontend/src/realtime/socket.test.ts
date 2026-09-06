/**
 * Contract 6 §5 and §6 against the scripted socket: heartbeat, the dead-man
 * timer, the backoff schedule, every close code, and ticket single-use.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../api/http";
import type { ConnectionStatus } from "../board/types";
import { BOARD_ID, ekom } from "../test/fixtures";
import { FakeSocket } from "./fakeSocket";
import {
  BACKOFF_CAP_MS,
  DEAD_MAN_TIMEOUT_MS,
  backoffDelay,
  type ServerEvent,
} from "./protocol";
import { RealtimeClient } from "./socket";

interface Harness {
  client: RealtimeClient;
  events: ServerEvent[];
  statuses: ConnectionStatus[];
  denials: string[];
  fetchTicket: ReturnType<typeof vi.fn>;
  refreshSession: ReturnType<typeof vi.fn>;
}

function harness(overrides: Partial<{ fetchTicket: () => Promise<unknown> }> = {}): Harness {
  const events: ServerEvent[] = [];
  const statuses: ConnectionStatus[] = [];
  const denials: string[] = [];

  const fetchTicket = vi.fn(
    overrides.fetchTicket ?? (async () => ({ ticket: "tk-1", expires_in: 30 })),
  );
  const refreshSession = vi.fn(async () => "new-access-token");

  const client = new RealtimeClient({
    boardId: BOARD_ID,
    wsBase: "ws://test",
    fetchTicket: fetchTicket as unknown as RealtimeClient["opts"]["fetchTicket"],
    refreshSession,
    onEvent: (e) => events.push(e),
    onStatus: (s) => statuses.push(s),
    onDenied: (r) => denials.push(r),
    socketFactory: FakeSocket.factory(),
    // Zero jitter, so the backoff schedule is exactly assertable.
    random: () => 0.5,
  });

  return { client, events, statuses, denials, fetchTicket, refreshSession };
}

/** Let the ticket fetch and the queued open() resolve. */
const settle = async (): Promise<void> => {
  await vi.advanceTimersByTimeAsync(0);
};

const helloFrame = (seq: number) => ({
  board_id: BOARD_ID,
  seq,
  you: ekom,
  online: [ekom],
});

beforeEach(() => {
  vi.useFakeTimers();
  FakeSocket.reset();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/* ================================================================== *
 * Connecting
 * ================================================================== */

describe("connecting", () => {
  it("fetches a ticket and opens the socket at the contract's URL", async () => {
    const h = harness();
    h.client.start();
    await settle();

    expect(h.fetchTicket).toHaveBeenCalledWith(BOARD_ID);
    expect(FakeSocket.instances).toHaveLength(1);
    expect(FakeSocket.latest.boardId).toBe(BOARD_ID);
    h.client.stop();
  });

  it("reports `open` only once hello arrives, not merely on socket open", async () => {
    const h = harness();
    h.client.start();
    await settle();

    expect(h.statuses).not.toContain("open");
    FakeSocket.latest.emitHello(helloFrame(412));
    expect(h.statuses).toContain("open");
    h.client.stop();
  });

  it("forwards hello to the reducer rather than swallowing it", async () => {
    const h = harness();
    h.client.start();
    await settle();
    FakeSocket.latest.emitHello(helloFrame(412));

    expect(h.events).toHaveLength(1);
    expect(h.events[0]?.type).toBe("hello");
    h.client.stop();
  });

  it("treats a 404 from the ticket endpoint as a denial and does not retry", async () => {
    const h = harness({
      fetchTicket: async () => {
        throw new ApiError(404, "Board not found.");
      },
    });
    h.client.start();
    await settle();

    expect(h.denials).toEqual(["Board not found."]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.fetchTicket).toHaveBeenCalledTimes(1);
  });

  it("retries with backoff when the ticket fetch fails for another reason", async () => {
    const h = harness({
      fetchTicket: async () => {
        throw new ApiError(500, "Something went wrong on our end.");
      },
    });
    h.client.start();
    await settle();

    expect(h.fetchTicket).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.fetchTicket).toHaveBeenCalledTimes(2);
    h.client.stop();
  });
});

/* ================================================================== *
 * §6.1 — heartbeat and the dead-man timer
 * ================================================================== */

describe("heartbeat", () => {
  it("replies to a server ping with exactly {\"type\":\"pong\"}", async () => {
    const h = harness();
    h.client.start();
    await settle();
    FakeSocket.latest.emitHello(helloFrame(412));

    FakeSocket.latest.ping();
    expect(FakeSocket.latest.sent).toEqual(['{"type":"pong"}']);
    h.client.stop();
  });

  it("does not forward the ping to the reducer as board state", async () => {
    const h = harness();
    h.client.start();
    await settle();
    FakeSocket.latest.emitHello(helloFrame(412));
    h.events.length = 0;

    FakeSocket.latest.ping();
    expect(h.events).toEqual([]);
    h.client.stop();
  });

  it("sends NOTHING but pongs — the socket is broadcast-only", async () => {
    const h = harness();
    h.client.start();
    await settle();
    const sock = FakeSocket.latest;
    sock.emitHello(helloFrame(412));
    sock.ping();
    sock.emit("card.updated", { id: 19 } as never);
    sock.ping();

    expect(new Set(sock.sent)).toEqual(new Set(['{"type":"pong"}']));
    expect(sock.pongs).toBe(2);
    h.client.stop();
  });

  it("treats 60 s of total silence as death and reconnects", async () => {
    const h = harness();
    h.client.start();
    await settle();
    FakeSocket.latest.emitHello(helloFrame(412));
    expect(FakeSocket.instances).toHaveLength(1);

    // The socket goes silent: no ping, no events, nothing at all.
    FakeSocket.latest.goSilent();
    await vi.advanceTimersByTimeAsync(DEAD_MAN_TIMEOUT_MS);
    expect(h.statuses).toContain("reconnecting");

    await vi.advanceTimersByTimeAsync(1_000);
    await settle();
    expect(FakeSocket.instances).toHaveLength(2);
    h.client.stop();
  });

  it("does NOT time out while any frame keeps arriving", async () => {
    const h = harness();
    h.client.start();
    await settle();
    FakeSocket.latest.emitHello(helloFrame(412));

    // A ping every 25 s, as the server sends them.
    for (let i = 0; i < 6; i += 1) {
      await vi.advanceTimersByTimeAsync(25_000);
      FakeSocket.latest.ping();
    }
    expect(FakeSocket.instances).toHaveLength(1);
    expect(h.statuses).not.toContain("reconnecting");
    h.client.stop();
  });
});

/* ================================================================== *
 * §6.2 — backoff
 * ================================================================== */

describe("reconnect backoff", () => {
  it("follows 1s, 2s, 4s, 8s, 16s then caps at 30s", () => {
    const noJitter = () => 0.5;
    expect([0, 1, 2, 3, 4, 5, 6, 20].map((n) => backoffDelay(n, noJitter))).toEqual([
      1_000, 2_000, 4_000, 8_000, 16_000, BACKOFF_CAP_MS, BACKOFF_CAP_MS, BACKOFF_CAP_MS,
    ]);
  });

  it("applies jitter within +/-25% so cold starts do not stampede", () => {
    expect(backoffDelay(0, () => 0)).toBe(750);
    expect(backoffDelay(0, () => 1)).toBe(1_250);
  });

  it("waits the scheduled delay before each retry, never looping tightly", async () => {
    const h = harness();
    h.client.start();
    await settle();
    FakeSocket.latest.emitHello(helloFrame(412));

    FakeSocket.latest.serverClose(1011);
    expect(FakeSocket.instances).toHaveLength(1);

    // Nothing at 999 ms.
    await vi.advanceTimersByTimeAsync(999);
    expect(FakeSocket.instances).toHaveLength(1);

    // Reconnects at 1 s.
    await vi.advanceTimersByTimeAsync(1);
    await settle();
    expect(FakeSocket.instances).toHaveLength(2);

    // Second failure waits 2 s.
    FakeSocket.latest.serverClose(1011);
    await vi.advanceTimersByTimeAsync(1_999);
    expect(FakeSocket.instances).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    await settle();
    expect(FakeSocket.instances).toHaveLength(3);
    h.client.stop();
  });

  it("resets the schedule after a successful hello", async () => {
    const h = harness();
    h.client.start();
    await settle();
    FakeSocket.latest.emitHello(helloFrame(412));

    // Fail once (1 s), then succeed.
    FakeSocket.latest.serverClose(1011);
    await vi.advanceTimersByTimeAsync(1_000);
    await settle();
    FakeSocket.latest.emitHello(helloFrame(412));

    // The next failure is back to 1 s, not 2 s.
    FakeSocket.latest.serverClose(1011);
    await vi.advanceTimersByTimeAsync(1_000);
    await settle();
    expect(FakeSocket.instances).toHaveLength(3);
    h.client.stop();
  });

  it("fetches a FRESH ticket on every reconnect — tickets are single-use", async () => {
    const h = harness();
    h.client.start();
    await settle();
    FakeSocket.latest.emitHello(helloFrame(412));

    FakeSocket.latest.serverClose(1011);
    await vi.advanceTimersByTimeAsync(1_000);
    await settle();

    expect(h.fetchTicket).toHaveBeenCalledTimes(2);
    h.client.stop();
  });
});

/* ================================================================== *
 * §5 — close codes
 * ================================================================== */

describe("close codes", () => {
  it("1000: does not reconnect", async () => {
    const h = harness();
    h.client.start();
    await settle();
    FakeSocket.latest.emitHello(helloFrame(412));

    FakeSocket.latest.serverClose(1000);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(FakeSocket.instances).toHaveLength(1);
    expect(h.statuses.at(-1)).toBe("closed");
  });

  it("1011: reconnects with backoff", async () => {
    const h = harness();
    h.client.start();
    await settle();
    FakeSocket.latest.emitHello(helloFrame(412));

    FakeSocket.latest.serverClose(1011);
    await vi.advanceTimersByTimeAsync(1_000);
    await settle();
    expect(FakeSocket.instances).toHaveLength(2);
    h.client.stop();
  });

  it("4001: fetches a new ticket and reconnects once, immediately", async () => {
    const h = harness();
    h.client.start();
    await settle();
    FakeSocket.latest.emitHello(helloFrame(412));
    expect(h.fetchTicket).toHaveBeenCalledTimes(1);

    FakeSocket.latest.serverClose(4001);
    await settle();

    expect(h.fetchTicket).toHaveBeenCalledTimes(2);
    expect(FakeSocket.instances).toHaveLength(2);
    expect(h.refreshSession).not.toHaveBeenCalled();
    h.client.stop();
  });

  it("4001 twice: runs the auth-refresh flow, then retries — no re-login prompt", async () => {
    const h = harness();
    h.client.start();
    await settle();
    FakeSocket.latest.emitHello(helloFrame(412));

    FakeSocket.latest.serverClose(4001);
    await settle();
    FakeSocket.latest.serverClose(4001);
    await settle();

    expect(h.refreshSession).toHaveBeenCalledTimes(1);
    expect(h.fetchTicket).toHaveBeenCalledTimes(3);
    expect(h.denials).toEqual([]); // never surfaced to the user as a denial
    h.client.stop();
  });

  it("4001 a third time: falls back to backoff rather than hot-looping", async () => {
    const h = harness();
    h.client.start();
    await settle();
    FakeSocket.latest.emitHello(helloFrame(412));

    FakeSocket.latest.serverClose(4001);
    await settle();
    FakeSocket.latest.serverClose(4001);
    await settle();
    const beforeThird = h.fetchTicket.mock.calls.length;

    FakeSocket.latest.serverClose(4001);
    await settle();
    expect(h.fetchTicket).toHaveBeenCalledTimes(beforeThird); // waits first

    await vi.advanceTimersByTimeAsync(1_000);
    await settle();
    expect(h.fetchTicket).toHaveBeenCalledTimes(beforeThird + 1);
    h.client.stop();
  });

  it("4003: routes away WITHOUT reconnecting", async () => {
    const h = harness();
    h.client.start();
    await settle();
    FakeSocket.latest.emitHello(helloFrame(412));

    FakeSocket.latest.serverClose(4003);
    await vi.advanceTimersByTimeAsync(60_000);

    expect(h.denials).toEqual(["You no longer have access to this board."]);
    expect(h.statuses.at(-1)).toBe("denied");
    expect(FakeSocket.instances).toHaveLength(1);
  });

  it("4004: routes away WITHOUT reconnecting", async () => {
    const h = harness();
    h.client.start();
    await settle();
    FakeSocket.latest.emitHello(helloFrame(412));

    FakeSocket.latest.serverClose(4004);
    await vi.advanceTimersByTimeAsync(60_000);

    expect(h.denials).toEqual(["Board not found."]);
    expect(FakeSocket.instances).toHaveLength(1);
  });
});

/* ================================================================== *
 * Frame handling
 * ================================================================== */

describe("frame handling", () => {
  it("forwards an unknown event type to the reducer rather than throwing", async () => {
    const h = harness();
    h.client.start();
    await settle();
    FakeSocket.latest.emitHello(helloFrame(412));
    h.events.length = 0;

    expect(() => FakeSocket.latest.emit("card.archived" as never, {} as never)).not.toThrow();
    // The client is not the silent-ignore point; the reducer is. It must reach it.
    expect(h.events.map((e) => e.type)).toEqual(["card.archived"]);
    h.client.stop();
  });

  it("ignores an unparseable frame without dropping the connection", async () => {
    const h = harness();
    h.client.start();
    await settle();
    FakeSocket.latest.emitHello(helloFrame(412));
    h.events.length = 0;

    FakeSocket.latest.deliverRaw("}{ not json");
    expect(h.events).toEqual([]);
    expect(FakeSocket.latest.closed).toBe(false);
    h.client.stop();
  });

  it("ignores a frame that is not a contract envelope", async () => {
    const h = harness();
    h.client.start();
    await settle();
    FakeSocket.latest.emitHello(helloFrame(412));
    h.events.length = 0;

    FakeSocket.latest.deliverRaw(JSON.stringify({ type: "card.updated" })); // no board_id/seq/ts
    expect(h.events).toEqual([]);
    h.client.stop();
  });

  it("a malformed frame still counts as liveness, resetting the dead-man timer", async () => {
    const h = harness();
    h.client.start();
    await settle();
    FakeSocket.latest.emitHello(helloFrame(412));

    await vi.advanceTimersByTimeAsync(50_000);
    FakeSocket.latest.deliverRaw("garbage");
    await vi.advanceTimersByTimeAsync(50_000);

    // 100 s elapsed, but never 60 s of silence.
    expect(FakeSocket.instances).toHaveLength(1);
    h.client.stop();
  });
});

/* ================================================================== *
 * Teardown
 * ================================================================== */

describe("stop()", () => {
  it("closes with 1000 and never reconnects afterwards", async () => {
    const h = harness();
    h.client.start();
    await settle();
    const sock = FakeSocket.latest;
    sock.emitHello(helloFrame(412));

    h.client.stop();
    expect(sock.closedWith).toBe(1000);

    await vi.advanceTimersByTimeAsync(120_000);
    expect(FakeSocket.instances).toHaveLength(1);
    expect(h.statuses.at(-1)).toBe("closed");
  });

  it("cancels a pending reconnect timer", async () => {
    const h = harness();
    h.client.start();
    await settle();
    FakeSocket.latest.emitHello(helloFrame(412));

    FakeSocket.latest.serverClose(1011); // schedules a 1 s reconnect
    h.client.stop();

    await vi.advanceTimersByTimeAsync(120_000);
    expect(FakeSocket.instances).toHaveLength(1);
  });
});
