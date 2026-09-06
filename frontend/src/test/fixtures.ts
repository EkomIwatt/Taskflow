/**
 * Contract-shaped fixtures shared across the suite.
 *
 * Every object here is built to the frozen contract, so a change to the
 * contract breaks these first -- which is the point.
 */

import {
  asOrderKey,
  type Activity,
  type BoardMember,
  type BoardSnapshot,
  type Card,
  type Comment,
  type User,
} from "../types/contracts";
import type { LocalCard, LocalList } from "../board/types";

export const ekom: User = {
  id: 3,
  email: "ekom@example.com",
  display_name: "Ekom",
  avatar_color: "#3B82F6",
  created_at: "2026-09-06T10:00:00Z",
};

export const ada: User = {
  id: 5,
  email: "ada@example.com",
  display_name: "Ada",
  avatar_color: "#EF4444",
  created_at: "2026-09-06T10:00:00Z",
};

export const BOARD_ID = 7;

export function card(
  id: number,
  listId: number,
  title: string,
  orderKey: string,
  overrides: Partial<Card> = {},
): Card {
  return {
    id,
    list_id: listId,
    board_id: BOARD_ID,
    title,
    description: "",
    order_key: asOrderKey(orderKey),
    comment_count: 0,
    created_by: ekom,
    created_at: "2026-09-06T10:00:00Z",
    updated_at: "2026-09-06T10:00:00Z",
    ...overrides,
  };
}

export function list(
  id: number,
  title: string,
  orderKey: string,
  cards: Card[] = [],
): LocalList {
  return { id, title, order_key: asOrderKey(orderKey), cards: cards as LocalCard[] };
}

export function comment(id: number, cardId: number, body: string, author: User = ada): Comment {
  return {
    id,
    card_id: cardId,
    board_id: BOARD_ID,
    author,
    body,
    created_at: "2026-09-06T10:00:00Z",
  };
}

export function activity(id: number, summary: string): Activity {
  return {
    id,
    board_id: BOARD_ID,
    actor: ekom,
    verb: "card.moved",
    summary,
    subject: { card_id: 19, card_title: "Fix login redirect" },
    created_at: "2026-09-06T10:00:00Z",
  };
}

export const members: BoardMember[] = [
  { user: ekom, role: "owner", added_at: "2026-09-06T10:00:00Z" },
  { user: ada, role: "member", added_at: "2026-09-06T10:00:00Z" },
];

/**
 * The standard board used across the suite:
 *   Doing (list 4): 19 "Fix login" a0, 20 "Presence row" a1
 *   Done  (list 6): 21 "Freeze contracts" a0
 */
export function snapshot(overrides: Partial<BoardSnapshot> = {}): BoardSnapshot {
  return {
    id: BOARD_ID,
    title: "Launch",
    seq: 412,
    role: "owner",
    members,
    lists: [
      {
        id: 4,
        title: "Doing",
        order_key: asOrderKey("a1"),
        cards: [card(19, 4, "Fix login", "a0"), card(20, 4, "Presence row", "a1")],
      },
      {
        id: 6,
        title: "Done",
        order_key: asOrderKey("a2"),
        cards: [card(21, 6, "Freeze contracts", "a0")],
      },
    ],
    activity: [activity(501, "Ekom moved Fix login from Doing to Done")],
    ...overrides,
  };
}

/** Card titles in render order, for readable order assertions. */
export const titlesOf = (l: LocalList | undefined): string[] =>
  (l?.cards ?? []).map((c) => c.title);
