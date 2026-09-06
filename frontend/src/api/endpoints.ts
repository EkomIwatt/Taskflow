/**
 * The typed API surface. One function per contract endpoint, named for it,
 * with the contract's exact path, method, body and response type.
 *
 * This file is the consumer half of Contracts 1-5 and 6 §1. If a call here
 * disagrees with the contract text, this file is wrong.
 */

import { request, requestVoid } from "./http";
import type {
  Activity,
  ActivityPage,
  AuthSession,
  BoardMember,
  BoardSnapshot,
  BoardSummary,
  Card,
  Comment,
  CreateCardRequest,
  CreatedList,
  CreateListRequest,
  LoginRequest,
  MoveCardRequest,
  MoveListRequest,
  RealtimeTicket,
  RefreshResponse,
  SignupRequest,
  UpdateCardRequest,
  User,
} from "../types/contracts";

/* ---------------------------- Contract 1 ---------------------------- */

export const signup = (body: SignupRequest): Promise<AuthSession> =>
  request<AuthSession>("/api/auth/signup", { method: "POST", body, skipRefresh: true });

export const login = (body: LoginRequest): Promise<AuthSession> =>
  request<AuthSession>("/api/auth/login", { method: "POST", body, skipRefresh: true });

/** Cookie only -- no body, no Authorization header. */
export const refresh = (): Promise<RefreshResponse> =>
  request<RefreshResponse>("/api/auth/refresh", { method: "POST", skipRefresh: true });

export const logout = (): Promise<void> =>
  requestVoid("/api/auth/logout", { method: "POST", skipRefresh: true });

export const me = (): Promise<User> => request<User>("/api/auth/me");

/* ---------------------------- Contract 2 ---------------------------- */

export const listBoards = (): Promise<{ boards: BoardSummary[] }> =>
  request<{ boards: BoardSummary[] }>("/api/boards");

export const createBoard = (title: string, clientOpId?: string): Promise<BoardSummary> =>
  request<BoardSummary>("/api/boards", { method: "POST", body: { title }, clientOpId });

/** THE SNAPSHOT. Carries `seq` -- the client's starting cursor. */
export const getBoard = (boardId: number, signal?: AbortSignal): Promise<BoardSnapshot> =>
  request<BoardSnapshot>(`/api/boards/${boardId}`, { signal });

export const renameBoard = (
  boardId: number,
  title: string,
  clientOpId?: string,
): Promise<{ id: number; title: string }> =>
  request(`/api/boards/${boardId}`, { method: "PATCH", body: { title }, clientOpId });

export const deleteBoard = (boardId: number, clientOpId?: string): Promise<void> =>
  requestVoid(`/api/boards/${boardId}`, { method: "DELETE", clientOpId });

export const addMember = (
  boardId: number,
  email: string,
  clientOpId?: string,
): Promise<BoardMember> =>
  request(`/api/boards/${boardId}/members`, { method: "POST", body: { email }, clientOpId });

export const removeMember = (
  boardId: number,
  userId: number,
  clientOpId?: string,
): Promise<void> =>
  requestVoid(`/api/boards/${boardId}/members/${userId}`, { method: "DELETE", clientOpId });

/* ---------------------------- Contract 3 ---------------------------- */

export const createList = (
  boardId: number,
  body: CreateListRequest,
  clientOpId?: string,
): Promise<CreatedList> =>
  request(`/api/boards/${boardId}/lists`, { method: "POST", body, clientOpId });

export const renameList = (
  listId: number,
  title: string,
  clientOpId?: string,
): Promise<{ id: number; title: string }> =>
  request(`/api/lists/${listId}`, { method: "PATCH", body: { title }, clientOpId });

export const moveList = (
  listId: number,
  body: MoveListRequest,
  clientOpId?: string,
): Promise<{ id: number; order_key: string }> =>
  request(`/api/lists/${listId}/move`, { method: "PATCH", body, clientOpId });

export const deleteList = (listId: number, clientOpId?: string): Promise<void> =>
  requestVoid(`/api/lists/${listId}`, { method: "DELETE", clientOpId });

export const createCard = (
  listId: number,
  body: CreateCardRequest,
  clientOpId?: string,
): Promise<Card> =>
  request(`/api/lists/${listId}/cards`, { method: "POST", body, clientOpId });

export const updateCard = (
  cardId: number,
  body: UpdateCardRequest,
  clientOpId?: string,
): Promise<Card> => request(`/api/cards/${cardId}`, { method: "PATCH", body, clientOpId });

/**
 * THE INTERESTING ONE. We send neighbour IDS, never keys -- the server owns the
 * ordering algorithm (Contract 4) and returns the authoritative order_key.
 *
 * 404 -> the card was deleted mid-drag; roll back.
 * 409 -> a named neighbour left the destination list; roll back and refetch.
 */
export const moveCard = (
  cardId: number,
  body: MoveCardRequest,
  clientOpId?: string,
): Promise<Card> => request(`/api/cards/${cardId}/move`, { method: "PATCH", body, clientOpId });

export const deleteCard = (cardId: number, clientOpId?: string): Promise<void> =>
  requestVoid(`/api/cards/${cardId}`, { method: "DELETE", clientOpId });

/* ---------------------------- Contract 5 ---------------------------- */

export const listComments = (
  cardId: number,
  signal?: AbortSignal,
): Promise<{ comments: Comment[] }> => request(`/api/cards/${cardId}/comments`, { signal });

export const createComment = (
  cardId: number,
  body: string,
  clientOpId?: string,
): Promise<Comment> =>
  request(`/api/cards/${cardId}/comments`, { method: "POST", body: { body }, clientOpId });

export const deleteComment = (commentId: number, clientOpId?: string): Promise<void> =>
  requestVoid(`/api/comments/${commentId}`, { method: "DELETE", clientOpId });

export const listActivity = (
  boardId: number,
  opts: { limit?: number; beforeId?: number } = {},
): Promise<ActivityPage> => {
  const params = new URLSearchParams();
  params.set("limit", String(opts.limit ?? 50));
  if (opts.beforeId !== undefined) params.set("before_id", String(opts.beforeId));
  return request<ActivityPage>(`/api/boards/${boardId}/activity?${params.toString()}`);
};

export type { Activity };

/* -------------------------- Contract 6 §1 --------------------------- */

/**
 * An ordinary authenticated call -- it goes through the same 401-refresh path
 * as everything else. A socket that dies because the access token expired
 * recovers by refreshing and re-ticketing, never by prompting a re-login.
 */
export const fetchRealtimeTicket = (boardId: number): Promise<RealtimeTicket> =>
  request<RealtimeTicket>("/api/realtime/ticket", {
    method: "POST",
    body: { board_id: boardId },
  });
