/**
 * The card detail slide-over: description, live comments, and a compose box.
 *
 * It must survive its card being moved OR deleted by someone else while open.
 * Deletion is handled upstream — the reducer clears `openCardId` and sets a
 * notice, so this component simply stops rendering rather than showing a ghost.
 */

import { useEffect, useState, type ReactNode } from "react";
import type { Comment } from "../types/contracts";
import type { LocalCard, LocalList } from "../board/types";
import { Avatar } from "./Presence";

export function CardDetailPanel({
  card,
  list,
  comments,
  onClose,
  onRename,
  onDescribe,
  onComment,
  onDelete,
}: {
  card: LocalCard;
  list: LocalList | null;
  comments: Comment[] | undefined;
  onClose: () => void;
  onRename: (title: string) => void;
  onDescribe: (description: string) => void;
  onComment: (body: string) => Promise<void>;
  onDelete: () => void;
}): ReactNode {
  const [renaming, setRenaming] = useState(false);
  const [description, setDescription] = useState(card.description);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [commentError, setCommentError] = useState<string | null>(null);

  // If someone else edits the description while this is open, the server's
  // value wins — unless the box is currently focused, which would yank text
  // out from under whoever is typing.
  useEffect(() => {
    if (document.activeElement?.id !== "card-description") {
      setDescription(card.description);
    }
  }, [card.description]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const submitComment = async (): Promise<void> => {
    const body = draft.trim();
    if (!body || sending) return;
    setSending(true);
    setCommentError(null);
    try {
      await onComment(body);
      setDraft("");
    } catch (err) {
      setCommentError(err instanceof Error ? err.message : "Could not post that comment.");
    } finally {
      setSending(false);
    }
  };

  return (
    <>
      <div className="scrim" onClick={onClose} aria-hidden="true" />
      <aside className="panel" role="dialog" aria-modal="true" aria-label={card.title}>
        <header className="panel-head">
          <div style={{ flex: 1, minWidth: 0 }}>
            {renaming ? (
              <input
                className="input"
                autoFocus
                defaultValue={card.title}
                aria-label="Card title"
                onBlur={(e) => {
                  const next = e.target.value.trim();
                  if (next && next !== card.title) onRename(next);
                  setRenaming(false);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") e.currentTarget.blur();
                  if (e.key === "Escape") setRenaming(false);
                }}
              />
            ) : (
              <h2
                className="panel-title"
                tabIndex={0}
                role="button"
                title="Rename card"
                onClick={() => setRenaming(true)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") setRenaming(true);
                }}
              >
                {card.title}
              </h2>
            )}
            <p className="mono muted" style={{ marginTop: 6 }}>
              in {list?.title ?? "—"} · added by {card.created_by.display_name}
            </p>
          </div>
          <button type="button" className="btn btn-ghost" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </header>

        <div className="panel-body">
          <section className="panel-section">
            <h3>Description</h3>
            <textarea
              id="card-description"
              className="textarea"
              placeholder="Add more detail…"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              onBlur={() => {
                if (description !== card.description) onDescribe(description);
              }}
            />
          </section>

          <section className="panel-section">
            <h3>Comments</h3>

            {comments === undefined ? (
              <p className="empty-note">Loading comments…</p>
            ) : comments.length === 0 ? (
              <p className="empty-note">No comments yet. Start the thread.</p>
            ) : (
              <ul className="comments">
                {comments.map((c) => (
                  <li key={c.id} className="comment">
                    <Avatar user={c.author} small />
                    <div className="comment-body">
                      <div className="comment-head">
                        <span className="comment-author">{c.author.display_name}</span>
                        <span className="mono muted">
                          {new Date(c.created_at).toLocaleTimeString([], {
                            hour: "2-digit",
                            minute: "2-digit",
                          })}
                        </span>
                      </div>
                      <p className="comment-text">{c.body}</p>
                    </div>
                  </li>
                ))}
              </ul>
            )}

            <textarea
              className="textarea"
              placeholder="Write a comment…"
              value={draft}
              aria-label="New comment"
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void submitComment();
              }}
            />
            {commentError && <p className="form-error">{commentError}</p>}
            <button
              type="button"
              className="btn btn-primary"
              style={{ marginTop: 8 }}
              disabled={!draft.trim() || sending}
              onClick={() => void submitComment()}
            >
              {sending ? "Posting…" : "Comment"}
            </button>
          </section>
        </div>

        <footer className="panel-foot">
          <span className="mono muted">card #{card.id}</span>
          <button type="button" className="btn btn-ghost btn-danger" onClick={onDelete}>
            Delete card
          </button>
        </footer>
      </aside>
    </>
  );
}
