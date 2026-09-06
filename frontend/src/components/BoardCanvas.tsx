/**
 * The board canvas: drag-and-drop lists and cards.
 *
 * @dnd-kit, pointer AND keyboard. A board that only responds to a mouse is an
 * unfinished board, so the keyboard sensor is wired and stays wired.
 *
 * On drop this computes a DESTINATION LIST and an INDEX and hands them to
 * `moveCard`. It never computes an order_key — Contract 4 forbids it and
 * Contract 7 §8 explains why it is unnecessary: the card renders between its
 * new neighbours by array position, and the authoritative key arrives with the
 * echo.
 */

import { useMemo, useState, type ReactNode } from "react";
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  closestCorners,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { isPendingOrderKey } from "../types/contracts";
import type { LocalCard, LocalList } from "../board/types";

/* ------------------------------------------------------------------ *
 * Drop-target resolution
 * ------------------------------------------------------------------ */

const listDroppableId = (listId: number): string => `list:${listId}`;
const parseListDroppable = (id: string): number | null =>
  id.startsWith("list:") ? Number(id.slice(5)) : null;

/**
 * Where does this drop land?
 *
 * `toIndex` is an index into the destination list AFTER the moving card is
 * removed from it — the same basis the reducer and `neighboursAt` use, so all
 * three agree without any of them knowing about keys.
 */
export function resolveDrop(
  lists: readonly LocalList[],
  activeCardId: number,
  overId: string,
): { toListId: number; toIndex: number } | null {
  const sourceList = lists.find((l) => l.cards.some((c) => c.id === activeCardId));
  if (!sourceList) return null;

  // Dropped on a column body (including an empty one): append.
  const overListId = parseListDroppable(overId);
  if (overListId !== null) {
    const dest = lists.find((l) => l.id === overListId);
    if (!dest) return null;
    const others = dest.cards.filter((c) => c.id !== activeCardId);
    return { toListId: dest.id, toIndex: others.length };
  }

  // Dropped on another card.
  const overCardId = Number(overId);
  const destList = lists.find((l) => l.cards.some((c) => c.id === overCardId));
  if (!destList) return null;

  const others = destList.cards.filter((c) => c.id !== activeCardId);
  const overIndex = others.findIndex((c) => c.id === overCardId);
  if (overIndex === -1) return null;

  if (destList.id !== sourceList.id) {
    // Cross-list: land where the hovered card currently sits.
    return { toListId: destList.id, toIndex: overIndex };
  }

  // Same list: dragging DOWN lands below the hovered card, dragging UP lands
  // above it — which is what the pointer position already implies on screen.
  const fromIndex = sourceList.cards.findIndex((c) => c.id === activeCardId);
  const overIndexBefore = sourceList.cards.findIndex((c) => c.id === overCardId);
  const movingDown = fromIndex < overIndexBefore;
  return { toListId: destList.id, toIndex: movingDown ? overIndex + 1 : overIndex };
}

/* ------------------------------------------------------------------ *
 * Card
 * ------------------------------------------------------------------ */

function CardView({
  card,
  isRemote,
  onOpen,
}: {
  card: LocalCard;
  isRemote: boolean;
  onOpen: (cardId: number) => void;
}): ReactNode {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: String(card.id),
  });

  const pending = isPendingOrderKey(card.order_key) || card.id < 0;

  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={[
        "card",
        isDragging ? "is-dragging" : "",
        pending ? "is-pending" : "",
        // Someone else's change animates rather than teleporting.
        isRemote && !isDragging ? "is-remote" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      {...attributes}
      {...listeners}
      onClick={() => {
        if (card.id > 0) onOpen(card.id);
      }}
      onKeyDown={(e) => {
        // Enter opens; Space is reserved by dnd-kit for picking the card up.
        if (e.key === "Enter" && card.id > 0) {
          e.preventDefault();
          onOpen(card.id);
        }
      }}
    >
      <p className="card-title">{card.title}</p>
      <div className="card-meta">
        {card.comment_count > 0 && (
          <span className="card-chip" title={`${card.comment_count} comments`}>
            ‹›&nbsp;{card.comment_count}
          </span>
        )}
        {card.description !== "" && (
          <span className="card-chip" title="Has a description">
            ≡
          </span>
        )}
        {pending && <span className="card-chip">saving…</span>}
      </div>
    </li>
  );
}

/* ------------------------------------------------------------------ *
 * Column
 * ------------------------------------------------------------------ */

function Column({
  list,
  flashIds,
  onOpenCard,
  onAddCard,
  onRenameList,
  onDeleteList,
}: {
  list: LocalList;
  flashIds: number[];
  onOpenCard: (cardId: number) => void;
  onAddCard: (listId: number, title: string) => void;
  onRenameList: (listId: number, title: string) => void;
  onDeleteList: (listId: number) => void;
}): ReactNode {
  const { setNodeRef, isOver } = useDroppable({ id: listDroppableId(list.id) });
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState("");
  const [renaming, setRenaming] = useState(false);

  const ids = useMemo(() => list.cards.map((c) => String(c.id)), [list.cards]);

  const submitCard = (): void => {
    const title = draft.trim();
    if (title) onAddCard(list.id, title);
    setDraft("");
    setAdding(false);
  };

  return (
    <section className="column" aria-label={list.title}>
      <header className="column-head">
        {renaming ? (
          <input
            className="input"
            autoFocus
            defaultValue={list.title}
            aria-label="List title"
            onBlur={(e) => {
              const next = e.target.value.trim();
              if (next && next !== list.title) onRenameList(list.id, next);
              setRenaming(false);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") e.currentTarget.blur();
              if (e.key === "Escape") setRenaming(false);
            }}
          />
        ) : (
          <h2
            className="column-title"
            tabIndex={0}
            role="button"
            title="Rename list"
            onClick={() => setRenaming(true)}
            onKeyDown={(e) => {
              if (e.key === "Enter") setRenaming(true);
            }}
          >
            {list.title}
          </h2>
        )}
        <span className="column-count">{list.cards.length}</span>
        <button
          type="button"
          className="btn btn-ghost btn-danger"
          title={`Delete ${list.title}`}
          onClick={() => onDeleteList(list.id)}
        >
          ✕
        </button>
      </header>

      <SortableContext items={ids} strategy={verticalListSortingStrategy}>
        <ul ref={setNodeRef} className={`column-cards${isOver ? " is-over" : ""}`}>
          {list.cards.length === 0 ? (
            <li className="column-empty">Drop a card here</li>
          ) : (
            list.cards.map((card) => (
              <CardView
                key={card.temp_id ?? card.id}
                card={card}
                isRemote={flashIds.includes(card.id)}
                onOpen={onOpenCard}
              />
            ))
          )}
        </ul>
      </SortableContext>

      <div className="column-foot">
        {adding ? (
          <div>
            <textarea
              className="textarea"
              autoFocus
              placeholder="What needs doing?"
              value={draft}
              aria-label="New card title"
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  submitCard();
                }
                if (e.key === "Escape") {
                  setDraft("");
                  setAdding(false);
                }
              }}
            />
            <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
              <button type="button" className="btn btn-primary" onClick={submitCard}>
                Add card
              </button>
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => {
                  setDraft("");
                  setAdding(false);
                }}
              >
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <button type="button" className="btn btn-ghost" onClick={() => setAdding(true)}>
            + Add a card
          </button>
        )}
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ *
 * Canvas
 * ------------------------------------------------------------------ */

export function BoardCanvas({
  lists,
  flashIds,
  onMoveCard,
  onOpenCard,
  onAddCard,
  onRenameList,
  onDeleteList,
  onAddList,
}: {
  lists: LocalList[];
  flashIds: number[];
  onMoveCard: (cardId: number, toListId: number, toIndex: number) => void;
  onOpenCard: (cardId: number) => void;
  onAddCard: (listId: number, title: string) => void;
  onRenameList: (listId: number, title: string) => void;
  onDeleteList: (listId: number) => void;
  onAddList: (title: string) => void;
}): ReactNode {
  const [activeId, setActiveId] = useState<number | null>(null);
  const [newListTitle, setNewListTitle] = useState("");

  const sensors = useSensors(
    // A small distance threshold, so a click to open a card is not read as a
    // drag that never moved.
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const activeCard = useMemo(() => {
    if (activeId === null) return null;
    for (const l of lists) {
      const c = l.cards.find((x) => x.id === activeId);
      if (c) return c;
    }
    return null;
  }, [activeId, lists]);

  const handleDragStart = (e: DragStartEvent): void => {
    setActiveId(Number(e.active.id));
  };

  const handleDragEnd = (e: DragEndEvent): void => {
    setActiveId(null);
    const { active, over } = e;
    if (!over) return;

    const cardId = Number(active.id);
    const target = resolveDrop(lists, cardId, String(over.id));
    if (!target) return;

    // A drop that changes nothing is not a move: do not burn a request or an
    // activity entry on it.
    const source = lists.find((l) => l.cards.some((c) => c.id === cardId));
    if (source && source.id === target.toListId) {
      const others = source.cards.filter((c) => c.id !== cardId);
      const currentIndex = source.cards.findIndex((c) => c.id === cardId);
      const settledIndex = Math.min(currentIndex, others.length);
      if (settledIndex === target.toIndex) return;
    }

    onMoveCard(cardId, target.toListId, target.toIndex);
  };

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCorners}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      onDragCancel={() => setActiveId(null)}
      accessibility={{
        announcements: {
          onDragStart: ({ active }) => `Picked up card ${active.id}.`,
          onDragOver: ({ over }) =>
            over ? `Card is over ${String(over.id)}.` : "Card is no longer over a drop target.",
          onDragEnd: ({ over }) =>
            over ? `Card dropped on ${String(over.id)}.` : "Card dropped.",
          onDragCancel: () => "Move cancelled; the card returned to where it started.",
        },
      }}
    >
      <div className="canvas">
        {lists.map((list) => (
          <Column
            key={list.temp_id ?? list.id}
            list={list}
            flashIds={flashIds}
            onOpenCard={onOpenCard}
            onAddCard={onAddCard}
            onRenameList={onRenameList}
            onDeleteList={onDeleteList}
          />
        ))}

        <section className="column" style={{ background: "transparent", borderStyle: "dashed" }}>
          <div className="column-foot" style={{ borderTop: 0 }}>
            <form
              className="inline-form"
              onSubmit={(e) => {
                e.preventDefault();
                const title = newListTitle.trim();
                if (!title) return;
                onAddList(title);
                setNewListTitle("");
              }}
            >
              <input
                className="input"
                placeholder="Add a list"
                aria-label="New list title"
                value={newListTitle}
                onChange={(e) => setNewListTitle(e.target.value)}
              />
              <button type="submit" className="btn" disabled={!newListTitle.trim()}>
                Add
              </button>
            </form>
          </div>
        </section>
      </div>

      {/* The lifted card follows the pointer; the original stays dimmed in
          place so the gap it will leave is legible. */}
      <DragOverlay>
        {activeCard ? (
          <div className="card card-overlay">
            <p className="card-title">{activeCard.title}</p>
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}
