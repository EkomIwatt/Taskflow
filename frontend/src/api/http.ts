/**
 * The HTTP transport: access token in memory, single-flight refresh on 401,
 * and the Contract 8 error envelope surfaced as a typed exception.
 *
 * Carried over from LedgerLite unchanged in shape -- do not redesign it.
 */

import { isErrorEnvelope } from "../types/contracts";

/**
 * A non-2xx response. `message` is ALWAYS a complete, user-showable sentence
 * taken from the Contract 8 envelope -- render it as-is (Contract 7 §7 in
 * particular relies on this for the 409 stale-drag message).
 */
export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

/** Network failure / socket hang-up -- distinct from a server-sent error. */
export class NetworkError extends Error {
  constructor(message = "Could not reach the server. Check your connection.") {
    super(message);
    this.name = "NetworkError";
  }
}

/* ------------------------------------------------------------------ *
 * Access token: MEMORY ONLY. Never localStorage, never sessionStorage.
 * Session survival across a reload comes from the httpOnly refresh cookie,
 * which this JavaScript cannot read -- that is the point.
 * ------------------------------------------------------------------ */

let accessToken: string | null = null;

export const setAccessToken = (token: string | null): void => {
  accessToken = token;
};
export const getAccessToken = (): string | null => accessToken;

/** Called when refresh fails: the session is unrecoverable, show the login screen. */
type SessionExpiredHandler = () => void;
let onSessionExpired: SessionExpiredHandler = () => {};
export const setSessionExpiredHandler = (fn: SessionExpiredHandler): void => {
  onSessionExpired = fn;
};

/* ------------------------------------------------------------------ *
 * Single-flight refresh
 * ------------------------------------------------------------------ */

/**
 * Concurrent 401s share ONE in-flight refresh promise. This project fires more
 * concurrent requests than LedgerLite did (snapshot + ticket + comments all at
 * board open), so the single-flight is not optional -- without it three 401s
 * rotate the refresh cookie three times and two of them lose the race.
 */
let refreshInFlight: Promise<string | null> | null = null;

export function refreshAccessToken(): Promise<string | null> {
  if (refreshInFlight) return refreshInFlight;

  refreshInFlight = (async (): Promise<string | null> => {
    try {
      const res = await rawFetch("/api/auth/refresh", {
        method: "POST",
        credentials: "include",
      });
      if (!res.ok) {
        setAccessToken(null);
        onSessionExpired();
        return null;
      }
      const body = (await res.json()) as { access_token: string };
      setAccessToken(body.access_token);
      return body.access_token;
    } catch {
      // A network failure is NOT an expired session -- do not sign the user out.
      return null;
    } finally {
      refreshInFlight = null;
    }
  })();

  return refreshInFlight;
}

/** Test seam: drop any in-flight refresh between cases. */
export const __resetRefreshState = (): void => {
  refreshInFlight = null;
  accessToken = null;
};

/* ------------------------------------------------------------------ *
 * The request layer
 * ------------------------------------------------------------------ */

const apiBase = (): string => import.meta.env?.VITE_API_BASE ?? "";

/** Swappable at the very bottom so mocks.ts can stand in for the network. */
type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
let transport: FetchLike = (input, init) => fetch(input, init);
export const setTransport = (fn: FetchLike): void => {
  transport = fn;
};

const rawFetch: FetchLike = (input, init) => transport(apiBase() + input, init);

export interface RequestOptions {
  method?: "GET" | "POST" | "PATCH" | "DELETE";
  body?: unknown;
  /** Contract 7: echoed back verbatim in the resulting broadcast envelope. */
  clientOpId?: string;
  signal?: AbortSignal;
  /** Auth endpoints only -- suppresses the 401-refresh retry to avoid a loop. */
  skipRefresh?: boolean;
}

async function readError(res: Response): Promise<ApiError> {
  let message = "Something went wrong on our end.";
  try {
    const body: unknown = await res.json();
    // Contract 8: there is no `detail` key anywhere. If we ever see one, the
    // envelope is wrong -- but degrade gracefully rather than crash the UI.
    if (isErrorEnvelope(body)) message = body.error;
  } catch {
    /* empty or non-JSON body: keep the generic sentence */
  }
  return new ApiError(res.status, message);
}

async function send(path: string, options: RequestOptions): Promise<Response> {
  const { method = "GET", body, clientOpId, signal } = options;

  const headers: Record<string, string> = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (accessToken) headers["Authorization"] = `Bearer ${accessToken}`;
  if (clientOpId) headers["X-Client-Op-Id"] = clientOpId;

  const init: RequestInit = {
    method,
    headers,
    // The refresh cookie is scoped to /api/auth, but sending credentials on
    // every request keeps one code path and costs nothing.
    credentials: "include",
  };
  if (body !== undefined) init.body = JSON.stringify(body);
  if (signal) init.signal = signal;

  try {
    return await rawFetch(path, init);
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") throw err;
    throw new NetworkError();
  }
}

/**
 * One request, with at most ONE refresh retry. Never a loop:
 * a 401 on the retry is surfaced to the caller.
 */
export async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  let res = await send(path, options);

  if (res.status === 401 && !options.skipRefresh) {
    const token = await refreshAccessToken();
    if (token) res = await send(path, options);
  }

  if (!res.ok) throw await readError(res);
  if (res.status === 204) return undefined as T;

  return (await res.json()) as T;
}

/** For 204 endpoints, so callers do not pretend a body exists. */
export async function requestVoid(path: string, options: RequestOptions = {}): Promise<void> {
  await request<void>(path, options);
}

/** Contract 7: an opaque uuid4 the server echoes but never stores or validates. */
export function newClientOpId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `op-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
