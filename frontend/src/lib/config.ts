/**
 * Runtime configuration and stub wiring.
 *
 * Both stubs are toggled by env flags, so the same build runs against the
 * mocks or against Instance 1's real process without a code change.
 */

import { setTransport } from "../api/http";
import { mockTransport, seedMockData } from "../api/mocks";
import { FakeSocket } from "../realtime/fakeSocket";
import type { SocketFactory } from "../realtime/socket";

const flag = (value: string | undefined): boolean => value === "true";

export const config = {
  apiBase: import.meta.env.VITE_API_BASE ?? "",
  /**
   * Contract 6 §1. In production this is the Render origin DIRECTLY -- Vercel
   * does not proxy WebSockets, so it is not necessarily the origin the app was
   * served from.
   */
  wsBase: import.meta.env.VITE_WS_BASE ?? "ws://localhost:8000",
  useMocks: flag(import.meta.env.VITE_USE_MOCKS),
  useFakeSocket: flag(import.meta.env.VITE_USE_FAKE_SOCKET),
} as const;

/** Called once at boot, before React renders. */
export function installStubs(): void {
  if (config.useMocks) {
    const seed = seedMockData();
    setTransport(mockTransport);
    // eslint-disable-next-line no-console
    console.info(
      `[TaskFlow] Mock API active. Sign in as ${seed.email} / ${seed.password}`,
    );
  }
}

/**
 * The socket factory the board hook uses. Undefined means "the real
 * WebSocket", which is what RealtimeClient defaults to.
 */
export function socketFactory(): SocketFactory | undefined {
  // Read at call time rather than at module load, so a test can toggle the
  // flag without re-importing the module graph.
  return import.meta.env.VITE_USE_FAKE_SOCKET === "true" ? FakeSocket.factory() : undefined;
}
