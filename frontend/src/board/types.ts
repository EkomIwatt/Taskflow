import type { BoardMember, BoardRole, Card, OrderKey, User, Comment, Activity } from "../types/contracts";

/**
 * A card as the client holds it. Identical to the contract's <Card> except for
 * `temp_id`, which exists only on optimistic rows.
 *
 * Project convention: "The client never invents a server id. Optimistic rows
 * carry a local temp_id string ("temp:<uuid>") that is never sent to the
 * server; they are reconciled by client_op_id -- never by matching on title,
 * position or timestamp."
 *
 * `id` on an unconfirmed row is a NEGATIVE local sentinel. It is never sent
 * anywhere: it exists so the row has a React key and so Contract 4's numeric
 * `(order_key, id)` tie-break stays total. Server ids are positive, so the two
 * spaces cannot collide. Reconciliation is still by `client_op_id` alone.
 */
export interface LocalCard extends Card {
  temp_id?: string;
}

export interface LocalList {
  id: number;
  title: string;
  order_key: OrderKey;
  cards: LocalCard[];
  /** Present only on an optimistic list row. */
  temp_id?: string;
}

export const isOptimistic = (row: { temp_id?: string }): boolean => row.temp_id !== undefined;

export type ConnectionStatus =
  /** First connect for this board, or a reconnect in progress. */
  | "connecting"
  /** `hello` received; live. */
  | "open"
  /** Socket dropped, backoff timer running. The UI shows "Reconnecting...". */
  | "reconnecting"
  /** Deliberately closed (unmount / navigation). Do not reconnect. */
  | "closed"
  /** 4003 / 4004: do not reconnect, route away. */
  | "denied";

/**
 * A mutation applied locally before the server confirmed it (Contract 7).
 * Retired when `client_op_id` matches a broadcast OR when its HTTP response
 * resolves -- whichever arrives first. Never by title, position or timestamp.
 *
 * Each variant carries exactly what the inverse needs, so a rollback undoes
 * that op alone and cannot clobber an unrelated server event that landed in
 * the meantime.
 */
export type PendingOp =
  | {
      kind: "card.move";
      clientOpId: string;
      cardId: number;
      prevListId: number;
      prevOrderKey: OrderKey;
    }
  | {
      kind: "card.create";
      clientOpId: string;
      tempId: string;
      localId: number;
      listId: number;
    }
  | {
      kind: "card.update";
      clientOpId: string;
      cardId: number;
      prevTitle: string;
      prevDescription: string;
    }
  | {
      kind: "list.create";
      clientOpId: string;
      tempId: string;
      localId: number;
    };

export interface BoardState {
  boardId: number;
  /** False until the first snapshot lands. */
  loaded: boolean;
  title: string;
  role: BoardRole;

  /**
   * The staleness detector (Contract 6 §6.3). Initialised from the snapshot,
   * advanced by state events only -- ephemeral events must never touch it.
   */
  seq: number;

  members: BoardMember[];
  lists: LocalList[];
  /** Newest first. */
  activity: Activity[];
  /** Live connections only. Never persisted, never in the activity feed. */
  online: User[];
  you: User | null;

  pending: PendingOp[];
  /**
   * Set when a gap is detected or `hello.seq` disagrees. The owning hook
   * performs EXACTLY ONE snapshot refetch and clears it.
   */
  needsResync: boolean;
  connection: ConnectionStatus;

  /** A user-showable sentence from a rollback or a close code. Contract 8 text. */
  banner: string | null;
  /** Set on 4003/4004: the board view must route away. */
  evicted: string | null;

  openCardId: number | null;
  /** "This card was deleted by someone else." -- shown when the panel closes itself. */
  openCardNotice: string | null;
  commentsByCard: Record<number, Comment[]>;

  /** Card ids touched by SOMEONE ELSE, so the UI can animate rather than teleport. */
  flashCardIds: number[];
}
