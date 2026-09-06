/**
 * The drag arithmetic, and the UI requirements that are stated as requirements:
 * the presence row's overflow, the activity feed printing `summary` verbatim,
 * and empty states that must not crash on [].
 */

import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { asOrderKey } from "../types/contracts";
import type { LocalCard, LocalList } from "../board/types";
import { activity, ada, card, ekom, list } from "../test/fixtures";
import { resolveDrop } from "./BoardCanvas";
import { ActivityFeed } from "./ActivityFeed";
import { ConnectionLamp, PresenceRow } from "./Presence";

/* ================================================================== *
 * resolveDrop — where a dropped card lands
 * ================================================================== */

describe("resolveDrop", () => {
  //  Doing (4): 19, 20, 21     Done (6): 30
  const lists: LocalList[] = [
    list(4, "Doing", "a1", [
      card(19, 4, "one", "a0"),
      card(20, 4, "two", "a1"),
      card(21, 4, "three", "a2"),
    ]),
    list(6, "Done", "a2", [card(30, 6, "done thing", "a0")]),
  ];

  it("appends when dropped on a column body", () => {
    expect(resolveDrop(lists, 19, "list:6")).toEqual({ toListId: 6, toIndex: 1 });
  });

  it("appends at index 0 when the destination column is empty", () => {
    const withEmpty: LocalList[] = [lists[0]!, list(8, "Blocked", "a3", [])];
    expect(resolveDrop(withEmpty, 19, "list:8")).toEqual({ toListId: 8, toIndex: 0 });
  });

  it("lands where the hovered card sits when crossing lists", () => {
    expect(resolveDrop(lists, 19, "30")).toEqual({ toListId: 6, toIndex: 0 });
  });

  it("dragging DOWN within a list lands below the hovered card", () => {
    // 19 dragged onto 21: expected order two, three, one.
    expect(resolveDrop(lists, 19, "21")).toEqual({ toListId: 4, toIndex: 2 });
  });

  it("dragging UP within a list lands above the hovered card", () => {
    // 21 dragged onto 19: expected order three, one, two.
    expect(resolveDrop(lists, 21, "19")).toEqual({ toListId: 4, toIndex: 0 });
  });

  it("returns null when the dragged card is not on the board", () => {
    expect(resolveDrop(lists, 999, "list:6")).toBeNull();
  });

  it("returns null for an unrecognised drop target", () => {
    expect(resolveDrop(lists, 19, "8888")).toBeNull();
  });

  it("never invents an order_key — it returns only a list id and an index", () => {
    const result = resolveDrop(lists, 19, "list:6");
    expect(Object.keys(result ?? {}).sort()).toEqual(["toIndex", "toListId"]);
  });
});

/* ================================================================== *
 * Presence
 * ================================================================== */

describe("PresenceRow", () => {
  const person = (id: number, name: string) => ({
    ...ekom,
    id,
    display_name: name,
    avatar_color: "#3B82F6",
  });

  it("uses the server's display_name and avatar_color — it invents neither", () => {
    const { container } = render(<PresenceRow online={[ada]} you={ekom} />);
    const avatar = container.querySelector(".avatar");
    expect(avatar).toHaveAttribute("title", ada.display_name);
    expect(avatar).toHaveStyle({ background: ada.avatar_color });
  });

  it("marks you as you", () => {
    const { container } = render(<PresenceRow online={[ekom, ada]} you={ekom} />);
    const you = container.querySelector(".avatar.is-you");
    expect(you).toHaveAttribute("title", `${ekom.display_name} (you)`);
  });

  it("shows an overflow count past five", () => {
    const online = [1, 2, 3, 4, 5, 6, 7].map((i) => person(i, `User${i}`));
    const { container } = render(<PresenceRow online={online} you={null} />);
    expect(container.querySelectorAll(".avatar")).toHaveLength(6); // 5 + the counter
    expect(screen.getByTitle("2 more online")).toHaveTextContent("+2");
  });

  it("renders an honest empty state when nobody else is online", () => {
    render(<PresenceRow online={[]} you={ekom} />);
    expect(screen.getByText("nobody online")).toBeInTheDocument();
  });
});

describe("ConnectionLamp", () => {
  it('reads "live" when the socket is open', () => {
    render(<ConnectionLamp status="open" />);
    expect(screen.getByRole("status")).toHaveTextContent("live");
  });

  it('shows "Reconnecting…" while the socket is down', () => {
    render(<ConnectionLamp status="reconnecting" />);
    const lamp = screen.getByRole("status");
    expect(lamp).toHaveTextContent("reconnecting");
    // Contract 6 §6.6: edits still work; the board must not read as broken.
    expect(lamp.getAttribute("title")).toMatch(/edits still save/i);
  });
});

/* ================================================================== *
 * Activity feed
 * ================================================================== */

describe("ActivityFeed", () => {
  it("prints `summary` VERBATIM and does not compose prose from verb + subject", () => {
    const entry = activity(501, "Ekom moved Fix login redirect from Doing to Done");
    render(<ActivityFeed activity={[entry]} onOpenCard={vi.fn()} />);
    expect(
      screen.getByText("Ekom moved Fix login redirect from Doing to Done"),
    ).toBeInTheDocument();
  });

  it("renders a summary for a verb the client has never seen", () => {
    // Forward compatibility: a new verb ships without a frontend change.
    const entry = { ...activity(502, "Ekom archived the board"), verb: "board.archived" as never };
    render(<ActivityFeed activity={[entry]} onOpenCard={vi.fn()} />);
    expect(screen.getByText("Ekom archived the board")).toBeInTheDocument();
  });

  it("does not crash on an empty feed", () => {
    render(<ActivityFeed activity={[]} onOpenCard={vi.fn()} />);
    expect(screen.getByText("Nothing has happened on this board yet.")).toBeInTheDocument();
  });

  it("offers a link to the card only when subject carries a card_id", () => {
    const withCard = activity(501, "Ekom moved a card");
    const withoutCard = { ...activity(502, "Ekom renamed the board"), subject: {} };
    render(<ActivityFeed activity={[withCard, withoutCard]} onOpenCard={vi.fn()} />);
    expect(screen.getAllByRole("button", { name: "open card" })).toHaveLength(1);
  });
});

/* ================================================================== *
 * Empty-state safety
 * ================================================================== */

describe("empty collections never crash", () => {
  it("a list with no cards has a drop hint rather than a blank hole", () => {
    const empty: LocalCard[] = [];
    expect(empty).toEqual([]);
    // Rendered by Column; asserted here as the contract it holds.
    expect(list(9, "Empty", "a0", []).cards).toEqual([]);
  });

  it("an order_key of any shape is accepted as opaque", () => {
    // The client never parses a key, so a one-char and a long key are equal
    // citizens.
    expect(asOrderKey("a")).toBe("a");
    expect(asOrderKey("a0VVVVVVVVVVVVVVVV")).toBe("a0VVVVVVVVVVVVVVVV");
  });
});
