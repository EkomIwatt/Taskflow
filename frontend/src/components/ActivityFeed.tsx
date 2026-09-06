/**
 * The activity feed.
 *
 * Contract 5: `summary` is SERVER-RENDERED on purpose. This component prints
 * it verbatim and never reconstructs a sentence from `verb` + `subject`.
 * `subject` is used only to link the card. That is what lets Instance 1 ship
 * a new verb without a frontend change.
 */

import { useEffect, useRef, useState, type ReactNode } from "react";
import type { Activity } from "../types/contracts";
import { Avatar } from "./Presence";

/** Short relative time, refreshed lazily — informational only, never ordering. */
function relativeTime(iso: string, now: number): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "";
  const secs = Math.max(0, Math.round((now - then) / 1000));
  if (secs < 45) return "just now";
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

export function ActivityFeed({
  activity,
  onOpenCard,
}: {
  activity: Activity[];
  onOpenCard: (cardId: number) => void;
}): ReactNode {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);

  // Entries that arrived after mount get the highlight; the ones already there
  // on load do not, so opening a board is not a wall of flashing rows.
  const seen = useRef<Set<number> | null>(null);
  if (seen.current === null) seen.current = new Set(activity.map((a) => a.id));
  const known = seen.current;

  return (
    <aside className="rail" aria-label="Activity">
      <div className="rail-head">
        <h2>Activity</h2>
        <span className="mono muted">{activity.length}</span>
      </div>

      {activity.length === 0 ? (
        <p className="empty-note">Nothing has happened on this board yet.</p>
      ) : (
        <ul className="feed">
          {activity.map((entry) => {
            const isNew = !known.has(entry.id);
            if (isNew) known.add(entry.id);
            const cardId = entry.subject.card_id;
            return (
              <li key={entry.id} className={`feed-item${isNew ? " is-new" : ""}`}>
                <Avatar user={entry.actor} small />
                <div className="feed-body">
                  {/* Printed verbatim. The client never composes this prose. */}
                  <p className="feed-summary">{entry.summary}</p>
                  <span className="feed-time mono">
                    {relativeTime(entry.created_at, now)}
                    {typeof cardId === "number" && (
                      <>
                        {" · "}
                        <button
                          type="button"
                          className="linkish"
                          onClick={() => onOpenCard(cardId)}
                        >
                          open card
                        </button>
                      </>
                    )}
                  </span>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </aside>
  );
}
