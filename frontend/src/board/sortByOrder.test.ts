import { describe, expect, it } from "vitest";
import { asOrderKey, PENDING_ORDER_KEY, type OrderKey } from "../types/contracts";
import { sortByOrder, sortByOrderPinningPending } from "./sortByOrder";

const row = (id: number, key: string): { id: number; order_key: OrderKey } => ({
  id,
  order_key: asOrderKey(key),
});

describe("sortByOrder — Contract 4's binding sort", () => {
  it("orders by order_key ascending", () => {
    const sorted = sortByOrder([row(1, "a2"), row(2, "a0"), row(3, "a1")]);
    expect(sorted.map((r) => r.id)).toEqual([2, 3, 1]);
  });

  it("breaks ties on id ascending when two rows SHARE an order_key", () => {
    // The mandatory case: two concurrent inserts against the same neighbours
    // can produce equal keys. The server treats that as legal, so both clients
    // must land on the same order regardless of arrival sequence.
    const asDelivered = sortByOrder([row(88, "a0V"), row(42, "a0V")]);
    const asReversed = sortByOrder([row(42, "a0V"), row(88, "a0V")]);

    expect(asDelivered.map((r) => r.id)).toEqual([42, 88]);
    expect(asReversed.map((r) => r.id)).toEqual([42, 88]);
  });

  it("uses byte-wise comparison, so digits sort before uppercase before lowercase", () => {
    // ASCII ordering: '0' < '9' < 'A' < 'Z' < 'a' < 'z'. localeCompare would
    // put "a" next to "A" and silently disagree with the server.
    const sorted = sortByOrder([row(1, "a"), row(2, "Z"), row(3, "9"), row(4, "A")]);
    expect(sorted.map((r) => r.order_key)).toEqual(["9", "A", "Z", "a"]);
  });

  it("does not assume keys are equal length or evenly spaced", () => {
    const sorted = sortByOrder([row(1, "a0V"), row(2, "a0"), row(3, "a0VVVVV")]);
    expect(sorted.map((r) => r.id)).toEqual([2, 1, 3]);
  });

  it("does not mutate its input", () => {
    const input = [row(1, "b"), row(2, "a")];
    const copy = [...input];
    sortByOrder(input);
    expect(input).toEqual(copy);
  });

  it("returns [] for an empty list", () => {
    expect(sortByOrder([])).toEqual([]);
  });
});

describe("sortByOrderPinningPending — optimistic rows hold their position", () => {
  const pending = (id: number): { id: number; order_key: OrderKey } => ({
    id,
    order_key: PENDING_ORDER_KEY,
  });

  it("keeps an optimistically moved row at the index the drop put it at", () => {
    // Card 99 was dropped between a0 and a1. Its placeholder key sorts before
    // everything, so a plain sort would fling it to the top and it would snap
    // back when the echo arrived -- the teleport the pin exists to prevent.
    const sorted = sortByOrderPinningPending([row(1, "a0"), pending(99), row(2, "a1")]);
    expect(sorted.map((r) => r.id)).toEqual([1, 99, 2]);
  });

  it("still sorts the settled rows around the pinned one", () => {
    const sorted = sortByOrderPinningPending([row(2, "a9"), pending(99), row(1, "a0")]);
    // Slot 1 is pinned; slots 0 and 2 are filled by the settled rows in key
    // order, so a0 lands above the pinned row and a9 below it.
    expect(sorted.map((r) => r.id)).toEqual([1, 99, 2]);
    expect([sorted[0]?.order_key, sorted[2]?.order_key]).toEqual(["a0", "a9"]);
  });

  it("collapses to a plain sortByOrder once no row is pending", () => {
    const rows = [row(1, "a2"), row(2, "a0")];
    expect(sortByOrderPinningPending(rows)).toEqual(sortByOrder(rows));
  });

  it("handles a pinned row at the end of the list", () => {
    const sorted = sortByOrderPinningPending([row(1, "a1"), row(2, "a0"), pending(99)]);
    expect(sorted.map((r) => r.id)).toEqual([2, 1, 99]);
  });

  it("handles every row being pending", () => {
    const sorted = sortByOrderPinningPending([pending(98), pending(99)]);
    expect(sorted.map((r) => r.id)).toEqual([98, 99]);
  });
});
