/**
 * Boot-gate regression tests.
 *
 * These exist because of a bug found at merge, by running `npm run dev`
 * against the real backend for the first time: the app hung forever on
 * "Restoring your session…".
 *
 * The cause was an interaction between two individually-sensible guards. The
 * `booted` ref allows exactly one boot refresh (so StrictMode's double-invoke
 * cannot rotate the refresh cookie twice), while a `cancelled` flag in the
 * effect's cleanup discarded late results. StrictMode runs the first
 * invocation's cleanup BEFORE the second invocation, and the ref makes that
 * second invocation a no-op — so the flag cancelled the only request that was
 * ever issued, and `status` never left "booting".
 *
 * It survived both test suites because StrictMode's double-invoke is dev-only:
 * a production build is unaffected, and no test rendered the provider inside
 * <StrictMode>. These tests do, which is the whole point.
 */
import { StrictMode } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AuthProvider, useAuth } from "./AuthContext";
import { setTransport, __resetRefreshState, setAccessToken } from "../api/http";

function Probe(): React.ReactNode {
  const { status, user } = useAuth();
  return <div data-testid="status">{user ? `${status}:${user.email}` : status}</div>;
}

/** A transport that answers the boot sequence however the test wants. */
function transportFor(handlers: Record<string, () => Response>) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    for (const [fragment, make] of Object.entries(handlers)) {
      if (url.includes(fragment)) return make();
    }
    return new Response(JSON.stringify({ error: "Not found." }), { status: 404 });
  });
}

const json = (body: unknown, status: number): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

afterEach(() => {
  __resetRefreshState();
  setAccessToken(null);
  vi.restoreAllMocks();
});

describe("the boot gate under StrictMode", () => {
  it("reaches `anonymous` when the boot refresh 401s", async () => {
    setTransport(
      transportFor({
        "/api/auth/refresh": () =>
          json({ error: "Session expired. Please sign in again." }, 401),
      }) as never,
    );

    render(
      <StrictMode>
        <AuthProvider>
          <Probe />
        </AuthProvider>
      </StrictMode>,
    );

    // The bug: this stayed on "booting" forever.
    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent("anonymous"));
  });

  it("reaches `authenticated` when the boot refresh succeeds", async () => {
    const user = {
      id: 1,
      email: "ekom@example.com",
      display_name: "ekom",
      avatar_color: "#3B82F6",
      created_at: "2026-09-06T10:00:00Z",
    };
    setTransport(
      transportFor({
        "/api/auth/refresh": () =>
          json({ access_token: "tok", token_type: "bearer", expires_in: 900 }, 200),
        "/api/auth/me": () => json(user, 200),
      }) as never,
    );

    render(
      <StrictMode>
        <AuthProvider>
          <Probe />
        </AuthProvider>
      </StrictMode>,
    );

    await waitFor(() =>
      expect(screen.getByTestId("status")).toHaveTextContent("authenticated:ekom@example.com"),
    );
  });

  it("issues exactly ONE boot refresh despite StrictMode double-invocation", async () => {
    // The reason the `booted` ref exists: refresh tokens rotate on every use,
    // so a second boot refresh would invalidate the token the first one minted.
    const transport = transportFor({
      "/api/auth/refresh": () =>
        json({ error: "Session expired. Please sign in again." }, 401),
    });
    setTransport(transport as never);

    render(
      <StrictMode>
        <AuthProvider>
          <Probe />
        </AuthProvider>
      </StrictMode>,
    );

    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent("anonymous"));

    const refreshCalls = transport.mock.calls.filter(([input]) =>
      (typeof input === "string" ? input : String(input)).includes("/api/auth/refresh"),
    );
    expect(refreshCalls).toHaveLength(1);
  });

  it("never renders the login screen while the boot refresh is still in flight", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    setTransport(
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.includes("/api/auth/refresh")) {
          await gate;
          return json({ error: "Session expired. Please sign in again." }, 401);
        }
        return json({ error: "Not found." }, 404);
      }) as never,
    );

    render(
      <StrictMode>
        <AuthProvider>
          <Probe />
        </AuthProvider>
      </StrictMode>,
    );

    // Still booting: an authenticated user must never be flashed the login page.
    expect(screen.getByTestId("status")).toHaveTextContent("booting");

    release();
    await waitFor(() => expect(screen.getByTestId("status")).toHaveTextContent("anonymous"));
  });
});
