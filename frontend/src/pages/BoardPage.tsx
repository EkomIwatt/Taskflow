/**
 * The board view: canvas, presence, activity rail, card panel.
 *
 * This is the only place the realtime client is mounted (one connection per
 * open board), and the only place `useBoard` is called.
 */

import { useEffect, useState, type ReactNode } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";
import { selectListOf, selectOpenCard } from "../board/boardReducer";
import { useBoard } from "../board/useBoard";
import { ActivityFeed } from "../components/ActivityFeed";
import { BoardCanvas } from "../components/BoardCanvas";
import { CardDetailPanel } from "../components/CardDetailPanel";
import { ConnectionLamp, PresenceRow } from "../components/Presence";

export function BoardPage(): ReactNode {
  const params = useParams<{ boardId: string }>();
  const boardId = Number(params.boardId);
  const navigate = useNavigate();
  const { user } = useAuth();
  const board = useBoard(boardId, user);
  const { state } = board;

  const [renamingBoard, setRenamingBoard] = useState(false);
  const [inviting, setInviting] = useState(false);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteError, setInviteError] = useState<string | null>(null);

  // 4003/4004, or a 404 on the snapshot: route back with an explanation
  // rather than sitting on a board the user cannot see.
  useEffect(() => {
    if (state.evicted === null) return;
    const t = setTimeout(() => navigate("/boards", { replace: true }), 2200);
    return () => clearTimeout(t);
  }, [state.evicted, navigate]);

  // The remote-change highlight is a one-shot animation; clear the flags once
  // it has played so a later re-render does not replay it.
  useEffect(() => {
    if (state.flashCardIds.length === 0) return;
    const t = setTimeout(() => board.clearFlashes(), 1500);
    return () => clearTimeout(t);
  }, [state.flashCardIds, board]);

  if (state.evicted !== null) {
    return (
      <div className="centered-note">
        <div>
          <p>{state.evicted}</p>
          <p className="mono muted">Returning to your boards…</p>
        </div>
      </div>
    );
  }

  if (!state.loaded) {
    return (
      <div className="centered-note">
        <p className="mono">Loading board…</p>
      </div>
    );
  }

  const openCard = selectOpenCard(state);

  return (
    <div className="app">
      <header className="topbar">
        <button
          type="button"
          className="btn btn-ghost"
          onClick={() => navigate("/boards")}
          aria-label="Back to boards"
        >
          ←
        </button>

        {renamingBoard ? (
          <input
            className="title-edit"
            autoFocus
            defaultValue={state.title}
            aria-label="Board title"
            onBlur={(e) => {
              const next = e.target.value.trim();
              if (next && next !== state.title) board.renameBoard(next);
              setRenamingBoard(false);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") e.currentTarget.blur();
              if (e.key === "Escape") setRenamingBoard(false);
            }}
          />
        ) : (
          <h1
            className="topbar-title"
            role={state.role === "owner" ? "button" : undefined}
            tabIndex={state.role === "owner" ? 0 : undefined}
            title={state.role === "owner" ? "Rename board" : undefined}
            onClick={() => state.role === "owner" && setRenamingBoard(true)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && state.role === "owner") setRenamingBoard(true);
            }}
          >
            {state.title}
          </h1>
        )}

        <span className="mono muted" title="Last event applied to this board">
          seq {state.seq}
        </span>

        <div className="topbar-spacer" />

        <PresenceRow online={state.online} you={state.you} />
        <ConnectionLamp status={state.connection} />

        {state.role === "owner" &&
          (inviting ? (
            <form
              className="inline-form"
              onSubmit={(e) => {
                e.preventDefault();
                setInviteError(null);
                void board
                  .addMember(inviteEmail.trim())
                  .then(() => {
                    setInviteEmail("");
                    setInviting(false);
                  })
                  .catch((err: unknown) =>
                    setInviteError(
                      err instanceof Error ? err.message : "Could not add that person.",
                    ),
                  );
              }}
            >
              <input
                className="input"
                type="email"
                autoFocus
                placeholder="teammate@example.com"
                aria-label="Invite by email"
                value={inviteEmail}
                onChange={(e) => setInviteEmail(e.target.value)}
              />
              <button type="submit" className="btn">
                Invite
              </button>
            </form>
          ) : (
            <button type="button" className="btn btn-ghost" onClick={() => setInviting(true)}>
              + Invite
            </button>
          ))}
      </header>

      {(state.banner || inviteError || state.openCardNotice) && (
        <div className="banner" role="alert">
          <p>{state.banner ?? inviteError ?? state.openCardNotice}</p>
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => {
              board.dismissBanner();
              setInviteError(null);
            }}
          >
            Dismiss
          </button>
        </div>
      )}

      <div className="board-body">
        {state.lists.length === 0 ? (
          <div className="canvas">
            <div className="empty-state" style={{ margin: "auto", maxWidth: 460 }}>
              <h2>This board is empty</h2>
              <p>
                Lists are the columns your cards move between — “To do”, “Doing”, “Done” is a fine
                place to start.
              </p>
              <form
                className="inline-form"
                style={{ maxWidth: 320, margin: "0 auto" }}
                onSubmit={(e) => {
                  e.preventDefault();
                  const input = e.currentTarget.elements.namedItem("title");
                  if (input instanceof HTMLInputElement && input.value.trim()) {
                    board.createList(input.value.trim());
                    input.value = "";
                  }
                }}
              >
                <input className="input" name="title" placeholder="First list name" aria-label="First list name" />
                <button type="submit" className="btn btn-primary">
                  Add list
                </button>
              </form>
            </div>
          </div>
        ) : (
          <BoardCanvas
            lists={state.lists}
            flashIds={state.flashCardIds}
            onMoveCard={board.moveCard}
            onOpenCard={board.openCard}
            onAddCard={board.createCard}
            onRenameList={board.renameList}
            onDeleteList={board.deleteList}
            onAddList={board.createList}
          />
        )}

        <ActivityFeed activity={state.activity} onOpenCard={board.openCard} />
      </div>

      {openCard && (
        <CardDetailPanel
          card={openCard}
          list={selectListOf(state, openCard.id)}
          comments={state.commentsByCard[openCard.id]}
          onClose={board.closeCard}
          onRename={(title) => board.updateCard(openCard.id, { title })}
          onDescribe={(description) => board.updateCard(openCard.id, { description })}
          onComment={(body) => board.addComment(openCard.id, body)}
          onDelete={() => {
            board.deleteCard(openCard.id);
            board.closeCard();
          }}
        />
      )}
    </div>
  );
}
