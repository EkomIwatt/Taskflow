/**
 * The board state machine.
 *
 * Everything that can change the board goes through here: the snapshot, every
 * server event, every optimistic mutation and every rollback. One reducer, so
 * the seq rules (Contract 6 §6) and the reconciliation rules (Contract 7) are
 * each written down exactly once.
 *
 * The reducer is PURE. It never fetches. When it decides a resync is needed it
 * raises `needsResync` and the owning hook performs exactly one refetch.
 */

import {
  PENDING_ORDER_KEY,
  type BoardSnapshot,
  type Card,
  type Comment,
  type User,
} from "../types/contracts";
import { isEphemeralEvent, isKnownEventType, type ServerEvent } from "../realtime/protocol";
import { sortByOrderPinningPending } from "./sortByOrder";
import type { BoardState, ConnectionStatus, LocalCard, LocalList, PendingOp } from "./types";

/* ------------------------------------------------------------------ *
 * Actions
 * ------------------------------------------------------------------ */

export type BoardAction =
  | { type: "snapshot/loaded"; snapshot: BoardSnapshot }
  | { type: "event/received"; event: ServerEvent }
  | { type: "connection/changed"; status: ConnectionStatus }
  | { type: "connection/denied"; reason: string }
  | { type: "resync/started" }
  | {
      type: "optimistic/moveCard";
      clientOpId: string;
      cardId: number;
      toListId: number;
      toIndex: number;
    }
  | {
      type: "optimistic/createCard";
      clientOpId: string;
      tempId: string;
      listId: number;
      title: string;
      author: User;
    }
  | {
      type: "optimistic/updateCard";
      clientOpId: string;
      cardId: number;
      title?: string;
      description?: string;
    }
  | { type: "op/settled"; clientOpId: string }
  | { type: "server/cardApplied"; card: Card; clientOpId: string }
  | { type: "op/failed"; clientOpId: string; message: string }
  | { type: "card/opened"; cardId: number }
  | { type: "card/closed" }
  | { type: "comments/loaded"; cardId: number; comments: Comment[] }
  | { type: "banner/cleared" }
  | { type: "flash/cleared" };

/* ------------------------------------------------------------------ *
 * Initial state
 * ------------------------------------------------------------------ */

export function initialBoardState(boardId: number): BoardState {
  return {
    boardId,
    loaded: false,
    title: "",
    role: "member",
    seq: 0,
    members: [],
    lists: [],
    activity: [],
    online: [],
    you: null,
    pending: [],
    needsResync: false,
    connection: "connecting",
    banner: null,
    evicted: null,
    openCardId: null,
    openCardNotice: null,
    commentsByCard: {},
    flashCardIds: [],
  };
}

/* ------------------------------------------------------------------ *
 * Immutable helpers
 * ------------------------------------------------------------------ */

/** Local sentinel ids for optimistic rows: strictly negative, never sent anywhere. */
let localIdCounter = -1;
export const nextLocalId = (): number => localIdCounter--;
export const __resetLocalIds = (): void => {
  localIdCounter = -1;
};

export function locateCard(
  lists: readonly LocalList[],
  cardId: number,
): { listIndex: number; cardIndex: number; card: LocalCard } | null {
  for (let li = 0; li < lists.length; li += 1) {
    const list = lists[li];
    if (!list) continue;
    for (let ci = 0; ci < list.cards.length; ci += 1) {
      const card = list.cards[ci];
      if (card && card.id === cardId) return { listIndex: li, cardIndex: ci, card };
    }
  }
  return null;
}

function replaceListCards(
  lists: readonly LocalList[],
  listId: number,
  fn: (cards: LocalCard[]) => LocalCard[],
): LocalList[] {
  return lists.map((l) => (l.id === listId ? { ...l, cards: fn(l.cards) } : l));
}

/** Re-sort every list, honouring the pins optimistic rows hold (Contract 7 §8). */
function resort(lists: readonly LocalList[]): LocalList[] {
  return sortByOrderPinningPending(
    lists.map((l) => ({ ...l, cards: sortByOrderPinningPending(l.cards) })),
  );
}

/** Drop a card from wherever it currently sits. */
function withoutCard(lists: readonly LocalList[], cardId: number): LocalList[] {
  return lists.map((l) =>
    l.cards.some((c) => c.id === cardId)
      ? { ...l, cards: l.cards.filter((c) => c.id !== cardId) }
      : l,
  );
}

/**
 * Apply an authoritative card object by id: it REPLACES whatever is local,
 * moving lists if the server says so. Application is wholesale -- no merging,
 * no clever resolution (project convention: the server is authoritative).
 */
function upsertCard(lists: readonly LocalList[], card: LocalCard): LocalList[] {
  const stripped = withoutCard(lists, card.id);
  if (!stripped.some((l) => l.id === card.list_id)) return stripped; // list not loaded
  return replaceListCards(stripped, card.list_id, (cards) => [...cards, card]);
}

const remember = (ids: readonly number[], id: number): number[] =>
  ids.includes(id) ? [...ids] : [...ids, id];

/* ------------------------------------------------------------------ *
 * The reducer
 * ------------------------------------------------------------------ */

export function boardReducer(state: BoardState, action: BoardAction): BoardState {
  switch (action.type) {
    /* ---------------- snapshot ---------------- */

    case "snapshot/loaded": {
      const s = action.snapshot;
      // Replace local state WHOLESALE and reset the cursor. This is the only
      // recovery mechanism there is -- there is no server-side replay buffer,
      // so "missed 3 events" and "missed 3000" collapse into one code path.
      const lists: LocalList[] = s.lists.map((l) => ({
        id: l.id,
        title: l.title,
        order_key: l.order_key,
        cards: l.cards.map((c) => ({ ...c })),
      }));
      const openStillExists =
        state.openCardId !== null && locateCard(lists, state.openCardId) !== null;
      return {
        ...state,
        loaded: true,
        boardId: s.id,
        title: s.title,
        role: s.role,
        seq: s.seq,
        members: s.members,
        lists: resort(lists),
        activity: s.activity,
        needsResync: false,
        // In-flight optimistic ops are abandoned: the snapshot already reflects
        // whatever the server did with them, so their inverses are meaningless.
        pending: [],
        openCardId: openStillExists ? state.openCardId : null,
        openCardNotice:
          state.openCardId !== null && !openStillExists
            ? "That card is no longer on this board."
            : state.openCardNotice,
      };
    }

    case "resync/started":
      return { ...state, needsResync: false };

    /* ---------------- connection ---------------- */

    case "connection/changed":
      return { ...state, connection: action.status };

    case "connection/denied":
      return { ...state, connection: "denied", evicted: action.reason };

    /* ---------------- server events ---------------- */

    case "event/received":
      return applyEvent(state, action.event);

    /* ---------------- optimistic mutations ---------------- */

    case "optimistic/moveCard": {
      const found = locateCard(state.lists, action.cardId);
      if (!found) return state;
      const { card } = found;

      // Splice the card into its new index positionally, with a placeholder
      // key. We never compute an order_key -- Contract 4 forbids it and
      // Contract 7 §8 explains why we do not need one.
      const moved: LocalCard = {
        ...card,
        list_id: action.toListId,
        order_key: PENDING_ORDER_KEY,
      };
      const stripped = withoutCard(state.lists, action.cardId);
      const lists = replaceListCards(stripped, action.toListId, (cards) => {
        const next = [...cards];
        next.splice(Math.max(0, Math.min(action.toIndex, next.length)), 0, moved);
        return next;
      });

      const op: PendingOp = {
        kind: "card.move",
        clientOpId: action.clientOpId,
        cardId: action.cardId,
        prevListId: card.list_id,
        prevOrderKey: card.order_key,
      };
      return { ...state, lists, pending: [...state.pending, op] };
    }

    case "optimistic/createCard": {
      const localId = nextLocalId();
      const now = new Date().toISOString();
      const card: LocalCard = {
        id: localId,
        temp_id: action.tempId,
        list_id: action.listId,
        board_id: state.boardId,
        title: action.title,
        description: "",
        order_key: PENDING_ORDER_KEY,
        comment_count: 0,
        created_by: action.author,
        created_at: now,
        updated_at: now,
      };
      const lists = replaceListCards(state.lists, action.listId, (cards) => [...cards, card]);
      const op: PendingOp = {
        kind: "card.create",
        clientOpId: action.clientOpId,
        tempId: action.tempId,
        localId,
        listId: action.listId,
      };
      return { ...state, lists, pending: [...state.pending, op] };
    }

    case "optimistic/updateCard": {
      const found = locateCard(state.lists, action.cardId);
      if (!found) return state;
      const { card } = found;
      const next: LocalCard = {
        ...card,
        title: action.title ?? card.title,
        description: action.description ?? card.description,
      };
      const op: PendingOp = {
        kind: "card.update",
        clientOpId: action.clientOpId,
        cardId: action.cardId,
        prevTitle: card.title,
        prevDescription: card.description,
      };
      return {
        ...state,
        lists: replaceListCards(state.lists, card.list_id, (cards) =>
          cards.map((c) => (c.id === action.cardId ? next : c)),
        ),
        pending: [...state.pending, op],
      };
    }

    /* ---------------- settle / roll back ---------------- */

    case "op/settled":
      // Contract 7 §3: an op is retired when client_op_id matches OR when the
      // HTTP response for it resolves -- whichever arrives first. This only
      // forgets the inverse; the state change rides in with the authoritative
      // payload, via `server/cardApplied` or the broadcast.
      return retire(state, action.clientOpId);

    case "server/cardApplied": {
      // Contract 7 §2: the HTTP 2xx body and the broadcast carry the SAME
      // authoritative object, and the client settles on whichever arrives
      // first. Applying both is a no-op because application is by id.
      //
      // This path matters most when the socket is down: Contract 6 §6.6 keeps
      // the board editable while disconnected, and without this the card would
      // keep its placeholder key until the next snapshot.
      //
      // It does NOT touch `seq` -- only broadcasts advance the cursor.
      const cleared = dropSupersededRow(state, action.clientOpId);
      return { ...cleared, lists: resort(upsertCard(cleared.lists, { ...action.card })) };
    }

    case "op/failed": {
      const op = state.pending.find((p) => p.clientOpId === action.clientOpId);
      const cleared = retire(state, action.clientOpId);
      if (!op) return { ...cleared, banner: action.message };
      // Contract 7 §4: roll back that op's local mutation ENTIRELY. A
      // half-applied optimistic state on screen is worse than no optimism.
      return { ...rollback(cleared, op), banner: action.message };
    }

    /* ---------------- card panel / comments ---------------- */

    case "card/opened":
      return { ...state, openCardId: action.cardId, openCardNotice: null };

    case "card/closed":
      return { ...state, openCardId: null, openCardNotice: null };

    case "comments/loaded":
      return {
        ...state,
        commentsByCard: { ...state.commentsByCard, [action.cardId]: action.comments },
      };

    case "banner/cleared":
      return { ...state, banner: null };

    case "flash/cleared":
      return state.flashCardIds.length === 0 ? state : { ...state, flashCardIds: [] };

    default: {
      const _exhaustive: never = action;
      return _exhaustive;
    }
  }
}

/* ------------------------------------------------------------------ *
 * Pending-op bookkeeping
 * ------------------------------------------------------------------ */

function retire(state: BoardState, clientOpId: string): BoardState {
  if (!state.pending.some((p) => p.clientOpId === clientOpId)) return state;
  return { ...state, pending: state.pending.filter((p) => p.clientOpId !== clientOpId) };
}

/**
 * The targeted inverse of one op. Never a wholesale snapshot restore, so a
 * rollback cannot clobber an unrelated server event that landed meanwhile.
 */
function rollback(state: BoardState, op: PendingOp): BoardState {
  switch (op.kind) {
    case "card.move": {
      const found = locateCard(state.lists, op.cardId);
      // Already gone (someone deleted it): nothing to restore.
      if (!found) return state;
      const restored: LocalCard = {
        ...found.card,
        list_id: op.prevListId,
        order_key: op.prevOrderKey,
      };
      return { ...state, lists: resort(upsertCard(state.lists, restored)) };
    }
    case "card.create":
      return { ...state, lists: withoutCard(state.lists, op.localId) };
    case "card.update": {
      const found = locateCard(state.lists, op.cardId);
      if (!found) return state;
      const restored: LocalCard = {
        ...found.card,
        title: op.prevTitle,
        description: op.prevDescription,
      };
      return {
        ...state,
        lists: replaceListCards(state.lists, found.card.list_id, (cards) =>
          cards.map((c) => (c.id === op.cardId ? restored : c)),
        ),
      };
    }
    case "list.create":
      return { ...state, lists: state.lists.filter((l) => l.id !== op.localId) };
    default: {
      const _exhaustive: never = op;
      return _exhaustive;
    }
  }
}

/**
 * Drop the optimistic row an echo has just superseded.
 *
 * Reconciliation is by `client_op_id` ONLY -- never by matching on title,
 * position or timestamp (project convention). An echo carrying no op id is
 * someone else's change, and retires no local row.
 */
function dropSupersededRow(state: BoardState, clientOpId: string | null): BoardState {
  if (clientOpId === null) return state;
  const op = state.pending.find((p) => p.clientOpId === clientOpId);
  if (!op) return state;
  if (op.kind === "card.create") return { ...state, lists: withoutCard(state.lists, op.localId) };
  if (op.kind === "list.create") {
    return { ...state, lists: state.lists.filter((l) => l.id !== op.localId) };
  }
  return state;
}

/* ------------------------------------------------------------------ *
 * Event application — Contract 6 §6
 * ------------------------------------------------------------------ */

function applyEvent(state: BoardState, event: ServerEvent): BoardState {
  // Frames for any other board are dropped (§2).
  if (event.board_id !== state.boardId) return state;

  // Unknown types are ignored SILENTLY: no throw, no user-visible log, no
  // refetch. That is what lets the server add an event type without breaking
  // deployed clients (§2).
  if (!isKnownEventType(event.type)) return state;

  // The heartbeat is the socket client's business, not the board's.
  if (event.type === "ping") return state;

  /* ---- ephemeral: apply, do NOT touch local_seq (§4, §6.3) ---- */
  if (isEphemeralEvent(event.type)) {
    switch (event.type) {
      case "presence.joined": {
        const user = event.payload.user;
        // A user with three tabs open appears once.
        if (state.online.some((u) => u.id === user.id)) return state;
        return { ...state, online: [...state.online, user] };
      }
      case "presence.left":
        return {
          ...state,
          online: state.online.filter((u) => u.id !== event.payload.user_id),
        };
      default:
        return state;
    }
  }

  /* ---- hello: the only frame the client treats as special (§3) ---- */
  if (event.type === "hello") {
    const p = event.payload;
    // Presence exists ONLY on the socket -- the snapshot carries no `online`
    // field -- so `you`/`online` are applied regardless of the seq verdict.
    const withPresence: BoardState = {
      ...state,
      you: p.you,
      online: p.online,
      connection: "open",
    };
    // §6.4: if hello.seq != local_seq, refetch the snapshot before applying
    // anything else. Same rule as the gap rule, and the normal path after any
    // disconnect longer than a moment.
    if (p.seq !== state.seq) return { ...withPresence, needsResync: true };
    return withPresence;
  }

  /* ---- state events: the seq gate (§6.3) ---- */
  const seq = event.seq;
  // A state event without a seq is malformed; ignore it rather than corrupt
  // the cursor.
  if (typeof seq !== "number") return state;

  if (seq <= state.seq) return state; // duplicate -> drop SILENTLY
  if (seq > state.seq + 1) {
    // A gap: events were missed. Do NOT apply. Refetch the snapshot.
    return { ...state, needsResync: true };
  }

  // seq === local_seq + 1: apply and advance.
  return applyStateEvent({ ...state, seq }, event);
}

function applyStateEvent(state: BoardState, event: ServerEvent): BoardState {
  const byOther = state.you !== null && event.actor_id !== null && event.actor_id !== state.you.id;
  const flash = (s: BoardState, cardId: number): BoardState =>
    byOther ? { ...s, flashCardIds: remember(s.flashCardIds, cardId) } : s;

  switch (event.type) {
    case "board.updated":
      return { ...state, title: event.payload.title };

    case "board.member_added":
      return state.members.some((m) => m.user.id === event.payload.user.id)
        ? state
        : {
            ...state,
            members: [
              ...state.members,
              { user: event.payload.user, role: event.payload.role, added_at: event.ts },
            ],
          };

    case "board.member_removed":
      // If the removed user is us, the server closes with 4003 next and the
      // socket client raises the eviction. Here we only drop the row.
      return {
        ...state,
        members: state.members.filter((m) => m.user.id !== event.payload.user_id),
        online: state.online.filter((u) => u.id !== event.payload.user_id),
      };

    case "list.created": {
      const p = event.payload;
      if (state.lists.some((l) => l.id === p.id)) return state;
      const cleared = dropSupersededRow(state, event.client_op_id);
      const list: LocalList = {
        id: p.id,
        title: p.title,
        order_key: p.order_key,
        cards: (p.cards ?? []).map((c) => ({ ...c })),
      };
      return { ...cleared, lists: resort([...cleared.lists, list]) };
    }

    case "list.updated":
      return {
        ...state,
        lists: state.lists.map((l) =>
          l.id === event.payload.id ? { ...l, title: event.payload.title } : l,
        ),
      };

    case "list.moved":
      return {
        ...state,
        lists: resort(
          state.lists.map((l) =>
            l.id === event.payload.id ? { ...l, order_key: event.payload.order_key } : l,
          ),
        ),
      };

    case "list.deleted": {
      const gone = state.lists.find((l) => l.id === event.payload.id);
      const openWasHere =
        state.openCardId !== null && (gone?.cards.some((c) => c.id === state.openCardId) ?? false);
      return {
        ...state,
        lists: state.lists.filter((l) => l.id !== event.payload.id),
        openCardId: openWasHere ? null : state.openCardId,
        openCardNotice: openWasHere
          ? "That list was deleted by someone else."
          : state.openCardNotice,
      };
    }

    case "list.rebalanced": {
      // Contract 4's escape hatch. Replace that list's keys WHOLESALE and
      // re-sort. Rare -- but it has to work the first time it ever fires.
      const keys = new Map(event.payload.cards.map((c) => [c.id, c.order_key]));
      return {
        ...state,
        lists: resort(
          replaceListCards(state.lists, event.payload.list_id, (cards) =>
            cards.map((c) => {
              const key = keys.get(c.id);
              return key === undefined ? c : { ...c, order_key: key };
            }),
          ),
        ),
      };
    }

    case "card.created": {
      const cleared = dropSupersededRow(state, event.client_op_id);
      const card: LocalCard = { ...event.payload };
      return flash({ ...cleared, lists: resort(upsertCard(cleared.lists, card)) }, card.id);
    }

    case "card.updated": {
      const card: LocalCard = { ...event.payload };
      return flash({ ...state, lists: resort(upsertCard(state.lists, card)) }, card.id);
    }

    case "card.moved": {
      const p = event.payload;
      const found = locateCard(state.lists, p.id);
      if (!found) return state; // not loaded here; the next snapshot will carry it
      const moved: LocalCard = {
        ...found.card,
        list_id: p.list_id,
        order_key: p.order_key,
        updated_at: p.updated_at,
      };
      return flash({ ...state, lists: resort(upsertCard(state.lists, moved)) }, p.id);
    }

    case "card.deleted": {
      const wasOpen = state.openCardId === event.payload.id;
      return {
        ...state,
        lists: withoutCard(state.lists, event.payload.id),
        openCardId: wasOpen ? null : state.openCardId,
        openCardNotice: wasOpen ? "This card was deleted by someone else." : state.openCardNotice,
      };
    }

    case "comment.created": {
      const c = event.payload;
      const existing = state.commentsByCard[c.card_id];
      const commentsByCard =
        existing === undefined || existing.some((x) => x.id === c.id)
          ? state.commentsByCard
          : // Oldest first, matching GET /api/cards/{id}/comments.
            { ...state.commentsByCard, [c.card_id]: [...existing, c] };
      // ASSUMED: no event carries an updated `comment_count`, so the client
      // derives it. Self-healing -- the next snapshot restores the true value.
      // Raised as a non-blocking escalation in CLAUDE.md.
      const lists = state.lists.map((l) =>
        l.cards.some((card) => card.id === c.card_id)
          ? {
              ...l,
              cards: l.cards.map((card) =>
                card.id === c.card_id
                  ? { ...card, comment_count: card.comment_count + 1 }
                  : card,
              ),
            }
          : l,
      );
      return { ...state, commentsByCard, lists };
    }

    case "activity.appended":
      return state.activity.some((a) => a.id === event.payload.id)
        ? state
        : { ...state, activity: [event.payload, ...state.activity] };

    default:
      return state;
  }
}

/* ------------------------------------------------------------------ *
 * Selectors
 * ------------------------------------------------------------------ */

export const selectOpenCard = (state: BoardState): LocalCard | null => {
  if (state.openCardId === null) return null;
  return locateCard(state.lists, state.openCardId)?.card ?? null;
};

export const selectListOf = (state: BoardState, cardId: number): LocalList | null =>
  state.lists.find((l) => l.cards.some((c) => c.id === cardId)) ?? null;
