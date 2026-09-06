/**
 * The board list. Empty states are a real requirement here: a brand-new
 * account has [] and must land somewhere that tells it what to do next.
 */

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import * as api from "../api/endpoints";
import { useAuth } from "../auth/AuthContext";
import { Avatar } from "../components/Presence";
import type { BoardSummary } from "../types/contracts";

export function BoardsPage(): ReactNode {
  const { user, logout } = useAuth();
  const [boards, setBoards] = useState<BoardSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    try {
      const { boards: rows } = await api.listBoards();
      setBoards(rows);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load your boards.");
      setBoards([]);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const create = async (): Promise<void> => {
    const next = title.trim();
    if (!next || creating) return;
    setCreating(true);
    setError(null);
    try {
      const board = await api.createBoard(next);
      setBoards((prev) => [board, ...(prev ?? [])]);
      setTitle("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create that board.");
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="app">
      <header className="topbar">
        <h1 className="wordmark" style={{ fontSize: 20 }}>
          TaskFlow<span className="dot">.</span>
        </h1>
        <div className="topbar-spacer" />
        {user && <Avatar user={user} isYou />}
        <button type="button" className="btn btn-ghost" onClick={() => void logout()}>
          Sign out
        </button>
      </header>

      <div className="page">
        <div className="page-head">
          <h1>Your boards</h1>
          <form
            className="inline-form"
            onSubmit={(e) => {
              e.preventDefault();
              void create();
            }}
          >
            <input
              className="input"
              placeholder="New board name"
              aria-label="New board name"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
            <button type="submit" className="btn btn-primary" disabled={!title.trim() || creating}>
              Create
            </button>
          </form>
        </div>

        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}

        {boards === null ? (
          <p className="empty-note">Loading…</p>
        ) : boards.length === 0 ? (
          <div className="empty-state">
            <h2>No boards yet</h2>
            <p>
              A board holds your lists and cards, and everyone you invite sees changes live. Name
              your first one above to get started.
            </p>
          </div>
        ) : (
          <div className="board-grid">
            {boards.map((board, i) => (
              <Link
                key={board.id}
                to={`/boards/${board.id}`}
                className="board-tile"
                style={{ animationDelay: `${Math.min(i, 8) * 45}ms` }}
              >
                <h2>{board.title}</h2>
                <div className="tile-stats mono">
                  <span>
                    {board.card_count} card{board.card_count === 1 ? "" : "s"}
                  </span>
                  <span>
                    {board.member_count} member{board.member_count === 1 ? "" : "s"}
                  </span>
                  <span>{board.role}</span>
                </div>
              </Link>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
