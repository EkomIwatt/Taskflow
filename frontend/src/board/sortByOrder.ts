/**
 * Contract 4's binding sort. This is the ONE place in the app that orders a
 * list of cards or lists -- every render path goes through it.
 *
 *     cards.sort(by (order_key ASC, id ASC))
 *
 * Plain byte-wise string comparison. The `id` tie-break is MANDATORY, not
 * decorative: two concurrent inserts against the same neighbours can, in a
 * pathological interleaving, produce equal keys. The server treats that as
 * legal, so `(order_key, id)` is what keeps both clients deterministic.
 */

import { isPendingOrderKey, type OrderKey } from "../types/contracts";

export interface Ordered {
  id: number;
  order_key: OrderKey;
}

/**
 * Byte-wise comparison. NOT localeCompare -- that applies locale collation and
 * would order "a" vs "A" differently from the server's ASCII ordering, which is
 * exactly the kind of silent cross-language disagreement this contract exists
 * to prevent.
 */
function compareKeys(a: OrderKey, b: OrderKey): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

export function compareOrdered(a: Ordered, b: Ordered): number {
  return compareKeys(a.order_key, b.order_key) || a.id - b.id;
}

/** The contract sort. Pure, total, stable-by-construction (the id tie-break). */
export function sortByOrder<T extends Ordered>(items: readonly T[]): T[] {
  return [...items].sort(compareOrdered);
}

/**
 * The sort as the board actually applies it.
 *
 * A card moved optimistically carries PENDING_ORDER_KEY and has no meaningful
 * key yet (Contract 7 §8) -- it is pinned to the array index the drop put it
 * at, and everything else sorts around it. When the authoritative key arrives
 * with the echo, the placeholder is replaced and this collapses back to a plain
 * sortByOrder.
 *
 * Without the pinning, an optimistically moved card would jump to whichever end
 * the placeholder sorts to and snap back a moment later -- the "teleport" the
 * whole optimistic layer exists to avoid.
 */
export function sortByOrderPinningPending<T extends Ordered>(items: readonly T[]): T[] {
  const pinned = new Map<number, T>();
  const settled: T[] = [];

  items.forEach((item, index) => {
    if (isPendingOrderKey(item.order_key)) pinned.set(index, item);
    else settled.push(item);
  });

  if (pinned.size === 0) return sortByOrder(items);

  settled.sort(compareOrdered);

  const out: T[] = [];
  let next = 0;
  for (let slot = 0; slot < items.length; slot += 1) {
    const held = pinned.get(slot);
    if (held !== undefined) {
      out.push(held);
    } else {
      const item = settled[next];
      next += 1;
      if (item !== undefined) out.push(item);
    }
  }
  // Anything left over (possible only if pinned indices ran past the end).
  for (; next < settled.length; next += 1) {
    const item = settled[next];
    if (item !== undefined) out.push(item);
  }
  return out;
}
