/**
 * The board hook: one reducer, one socket, one place mutations are issued.
 *
 * This is the join Contract 7 describes -- the optimistic local mutation, the
 * HTTP call that carries its `X-Client-Op-Id`, and the broadcast echo that
 * settles it, all reconciled in one module rather than scattered across
 * components.
 */

import { useCallback, useEffect, useMemo, useReducer, useRef } from "react";
import * as api from "../api/endpoints";
import { ApiError, newClientOpId, refreshAccessToken } from "../api/http";
import { config, socketFactory } from "../lib/config";
import { RealtimeClient } from "../realtime/socket";
import type { ServerEvent } from "../realtime/protocol";
import { boardReducer, initialBoardState, locateCard } from "./boardReducer";
import type { BoardState, LocalCard, LocalList } from "./types";
import type { User } from "../types/contracts";

/** An optimistic row has a negative local id and is not a valid neighbour. */
const isConfirmed = (card: LocalCard): boolean => card.id > 0;

/**
 * Derive the neighbour IDS the server needs from the card's new position
 * (Contract 3). We send ids, never keys -- the server owns the algorithm.
 *
 * Unconfirmed rows are skipped: an optimistic neighbour has no server id yet,
 * and naming one would be naming a card the server has never heard of.
 */
export function neighboursAt(
  cards: readonly LocalCard[],
  index: number,
  movingCardId: number,
): { before_card_id: number | null; after_card_id: number | null } {
  const others = cards.filter((c) => c.id !== movingCardId);
  const clamped = Math.max(0, Math.min(index, others.length));

  let before: number | null = null;
  for (let i = clamped - 1; i >= 0; i -= 1) {
    const c = others[i];
    if (c && isConfirmed(c)) {
      before = c.id;
      break;
    }
  }

  let after: number | null = null;
  for (let i = clamped; i < others.length; i += 1) {
    const c = others[i];
    if (c && isConfirmed(c)) {
      after = c.id;
      break;
    }
  }

  return { before_card_id: before, after_card_id: after };
}

export interface BoardApi {
  state: BoardState;
  moveCard: (cardId: number, toListId: number, toIndex: number) => void;
  createCard: (listId: number, title: string) => void;
  updateCard: (cardId: number, patch: { title?: string; description?: string }) => void;
  deleteCard: (cardId: number) => void;
  createList: (title: string) => void;
  renameList: (listId: number, title: string) => void;
  deleteList: (listId: number) => void;
  renameBoard: (title: string) => void;
  addMember: (email: string) => Promise<void>;
  openCard: (cardId: number) => void;
  closeCard: () => void;
  addComment: (cardId: number, body: string) => Promise<void>;
  dismissBanner: () => void;
  clearFlashes: () => void;
}

export function useBoard(boardId: number, me: User | null): BoardApi {
  const [state, dispatch] = useReducer(boardReducer, boardId, initialBoardState);

  /** Latest state, for callbacks that must not re-subscribe on every render. */
  const stateRef = useRef(state);
  stateRef.current = state;

  /* ---------------- the snapshot ---------------- */

  const loadSnapshot = useCallback(async () => {
    try {
      const snapshot = await api.getBoard(boardId);
      dispatch({ type: "snapshot/loaded", snapshot });
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        dispatch({ type: "connection/denied", reason: err.message });
        return;
      }
      dispatch({
        type: "op/failed",
        clientOpId: "",
        message: err instanceof Error ? err.message : "Could not load this board.",
      });
    }
  }, [boardId]);

  useEffect(() => {
    void loadSnapshot();
  }, [loadSnapshot]);

  /* ---------------- the socket ---------------- */

  useEffect(() => {
    const client = new RealtimeClient({
      boardId,
      wsBase: config.wsBase,
      fetchTicket: api.fetchRealtimeTicket,
      refreshSession: refreshAccessToken,
      onEvent: (event: ServerEvent) => dispatch({ type: "event/received", event }),
      onStatus: (status) => dispatch({ type: "connection/changed", status }),
      onDenied: (reason) => dispatch({ type: "connection/denied", reason }),
      socketFactory: socketFactory(),
    });
    client.start();
    // Close with 1000 on unmount and on navigating away (Contract 6 §5: the
    // peer must not treat that as a reason to reconnect).
    return () => client.stop();
  }, [boardId]);

  /* ---------------- resync: EXACTLY ONE refetch per gap ---------------- */

  const resyncing = useRef(false);
  useEffect(() => {
    if (!state.needsResync || resyncing.current) return;
    resyncing.current = true;
    // Clear the flag first, so a burst of gapped events cannot queue a second
    // refetch behind this one. Snapshot-refetch is the only recovery there is,
    // and doing it twice is a bug, not belt-and-braces.
    dispatch({ type: "resync/started" });
    void loadSnapshot().finally(() => {
      resyncing.current = false;
    });
  }, [state.needsResync, loadSnapshot]);

  /* ---------------- mutations ---------------- */

  /**
   * Run one optimistic op: apply locally, fire the HTTP call carrying its
   * op id, then settle or roll back. The broadcast echo may settle it first --
   * both paths are idempotent because application is by id.
   */
  const run = useCallback(
    async <T,>(clientOpId: string, call: () => Promise<T>, apply?: (result: T) => void) => {
      try {
        const result = await call();
        // Contract 7 §2: the 2xx body is authoritative too. Apply it rather
        // than waiting for the echo -- otherwise an edit made while the socket
        // is down (which §6.6 explicitly allows) never settles.
        apply?.(result);
        dispatch({ type: "op/settled", clientOpId });
      } catch (err) {
        const message =
          err instanceof ApiError
            ? err.message
            : err instanceof Error
              ? err.message
              : "Something went wrong on our end.";
        // Contract 7 §4: roll back that op's local mutation entirely and show
        // body.error -- the 409 sentence in particular is written to be shown
        // to the user as-is.
        dispatch({ type: "op/failed", clientOpId, message });
        if (err instanceof ApiError && err.status === 409) {
          // §7: the board changed under the drag. Refetch the snapshot.
          void loadSnapshot();
        }
      }
    },
    [loadSnapshot],
  );

  const moveCard = useCallback(
    (cardId: number, toListId: number, toIndex: number) => {
      const current = stateRef.current;
      const found = locateCard(current.lists, cardId);
      if (!found) return;

      const destination = current.lists.find((l) => l.id === toListId);
      if (!destination) return;

      // Neighbours are derived from where the card LANDS, computed against the
      // destination list as it stands after the splice.
      const withMoved: LocalCard[] =
        found.card.list_id === toListId
          ? destination.cards
          : [...destination.cards, found.card];
      const { before_card_id, after_card_id } = neighboursAt(withMoved, toIndex, cardId);

      const clientOpId = newClientOpId();
      dispatch({ type: "optimistic/moveCard", clientOpId, cardId, toListId, toIndex });
      void run(
        clientOpId,
        () => api.moveCard(cardId, { list_id: toListId, before_card_id, after_card_id }, clientOpId),
        (card) => dispatch({ type: "server/cardApplied", card, clientOpId }),
      );
    },
    [run],
  );

  const createCard = useCallback(
    (listId: number, title: string) => {
      const author = me;
      if (!author || !title.trim()) return;
      const clientOpId = newClientOpId();
      // Project convention: "temp:<uuid>", never sent to the server.
      const tempId = `temp:${newClientOpId()}`;
      dispatch({
        type: "optimistic/createCard",
        clientOpId,
        tempId,
        listId,
        title: title.trim(),
        author,
      });
      void run(
        clientOpId,
        () => api.createCard(listId, { title: title.trim(), after_card_id: null }, clientOpId),
        (card) => dispatch({ type: "server/cardApplied", card, clientOpId }),
      );
    },
    [me, run],
  );

  const updateCard = useCallback(
    (cardId: number, patch: { title?: string; description?: string }) => {
      const clientOpId = newClientOpId();
      dispatch({ type: "optimistic/updateCard", clientOpId, cardId, ...patch });
      void run(
        clientOpId,
        () => api.updateCard(cardId, patch, clientOpId),
        (card) => dispatch({ type: "server/cardApplied", card, clientOpId }),
      );
    },
    [run],
  );

  // Deletions are NOT optimistic: removing a row and putting it back is far
  // more jarring than a moment's wait, and the echo arrives in well under a
  // second on a healthy socket.
  const deleteCard = useCallback(
    (cardId: number) => {
      const clientOpId = newClientOpId();
      void run(clientOpId, () => api.deleteCard(cardId, clientOpId));
    },
    [run],
  );

  const createList = useCallback(
    (title: string) => {
      if (!title.trim()) return;
      const clientOpId = newClientOpId();
      void run(clientOpId, () =>
        api.createList(boardId, { title: title.trim(), after_list_id: null }, clientOpId),
      );
    },
    [boardId, run],
  );

  const renameList = useCallback(
    (listId: number, title: string) => {
      if (!title.trim()) return;
      const clientOpId = newClientOpId();
      void run(clientOpId, () => api.renameList(listId, title.trim(), clientOpId));
    },
    [run],
  );

  const deleteList = useCallback(
    (listId: number) => {
      const clientOpId = newClientOpId();
      void run(clientOpId, () => api.deleteList(listId, clientOpId));
    },
    [run],
  );

  const renameBoard = useCallback(
    (title: string) => {
      if (!title.trim()) return;
      const clientOpId = newClientOpId();
      void run(clientOpId, () => api.renameBoard(boardId, title.trim(), clientOpId));
    },
    [boardId, run],
  );

  const addMember = useCallback(
    async (email: string) => {
      const clientOpId = newClientOpId();
      await api.addMember(boardId, email, clientOpId);
    },
    [boardId],
  );

  /* ---------------- card panel + comments ---------------- */

  const openCard = useCallback((cardId: number) => {
    dispatch({ type: "card/opened", cardId });
  }, []);

  const closeCard = useCallback(() => dispatch({ type: "card/closed" }), []);

  useEffect(() => {
    const cardId = state.openCardId;
    if (cardId === null || cardId < 0) return;
    if (state.commentsByCard[cardId] !== undefined) return;
    const controller = new AbortController();
    void (async () => {
      try {
        const { comments } = await api.listComments(cardId, controller.signal);
        dispatch({ type: "comments/loaded", cardId, comments });
      } catch {
        /* the panel shows its own empty state; a failed load is not fatal */
      }
    })();
    return () => controller.abort();
  }, [state.openCardId, state.commentsByCard]);

  const addComment = useCallback(async (cardId: number, body: string) => {
    if (!body.trim()) return;
    // Not optimistic: the echo carries the server's id and timestamp, and a
    // comment appearing ~100ms late reads as normal rather than as a glitch.
    await api.createComment(cardId, body.trim(), newClientOpId());
  }, []);

  const dismissBanner = useCallback(() => dispatch({ type: "banner/cleared" }), []);
  const clearFlashes = useCallback(() => dispatch({ type: "flash/cleared" }), []);

  return useMemo<BoardApi>(
    () => ({
      state,
      moveCard,
      createCard,
      updateCard,
      deleteCard,
      createList,
      renameList,
      deleteList,
      renameBoard,
      addMember,
      openCard,
      closeCard,
      addComment,
      dismissBanner,
      clearFlashes,
    }),
    [
      state,
      moveCard,
      createCard,
      updateCard,
      deleteCard,
      createList,
      renameList,
      deleteList,
      renameBoard,
      addMember,
      openCard,
      closeCard,
      addComment,
      dismissBanner,
      clearFlashes,
    ],
  );
}

export type { BoardState, LocalCard, LocalList };
