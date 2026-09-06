/**
 * Presence and the connection lamp — between them, the visible proof that the
 * realtime layer is working.
 *
 * Identity is SERVER-COMPUTED (project convention): `display_name` and
 * `avatar_color` come off the wire, so the same person is the same colour in
 * the presence row, in comments and in the activity feed. The frontend invents
 * neither.
 */

import type { ReactNode } from "react";
import type { User } from "../types/contracts";
import type { ConnectionStatus } from "../board/types";

const initials = (name: string): string => {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const first = parts[0]?.[0] ?? "?";
  const second = parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? "") : "";
  return (first + second).toUpperCase();
};

export function Avatar({
  user,
  isYou = false,
  small = false,
  title,
}: {
  user: User;
  isYou?: boolean;
  small?: boolean;
  title?: string;
}): ReactNode {
  return (
    <span
      className={`avatar${isYou ? " is-you" : ""}${small ? " avatar-sm" : ""}`}
      style={{ background: user.avatar_color }}
      title={title ?? (isYou ? `${user.display_name} (you)` : user.display_name)}
      aria-hidden="true"
    >
      {initials(user.display_name)}
    </span>
  );
}

const MAX_SHOWN = 5;

export function PresenceRow({
  online,
  you,
}: {
  online: User[];
  you: User | null;
}): ReactNode {
  // "A board where you are the only one online" is a real empty state, and it
  // must not render as a blank gap.
  if (online.length === 0) {
    return (
      <div className="presence">
        <span className="mono muted">nobody online</span>
      </div>
    );
  }

  // You first, so the row reads as "me, and these others".
  const ordered = [...online].sort((a, b) => {
    if (you && a.id === you.id) return -1;
    if (you && b.id === you.id) return 1;
    return a.id - b.id;
  });
  const shown = ordered.slice(0, MAX_SHOWN);
  const overflow = ordered.length - shown.length;

  const label =
    ordered.length === 1
      ? `${ordered[0]?.display_name ?? "One person"} is on this board`
      : `${ordered.length} people are on this board`;

  return (
    <div className="presence">
      <div className="presence-stack" role="group" aria-label={label}>
        {shown.map((user) => (
          <Avatar key={user.id} user={user} isYou={you?.id === user.id} />
        ))}
        {overflow > 0 && (
          <span className="avatar avatar-overflow" title={`${overflow} more online`}>
            +{overflow}
          </span>
        )}
      </div>
      <span className="visually-hidden" aria-live="polite">
        {label}
      </span>
    </div>
  );
}

const LAMP_TEXT: Record<ConnectionStatus, string> = {
  connecting: "connecting",
  open: "live",
  // Contract 6 §6.6: the board stays editable while this shows — only the
  // notifications are down, not the app.
  reconnecting: "reconnecting…",
  closed: "offline",
  denied: "no access",
};

export function ConnectionLamp({ status }: { status: ConnectionStatus }): ReactNode {
  return (
    <span
      className={`lamp is-${status}`}
      role="status"
      aria-live="polite"
      title={
        status === "reconnecting"
          ? "The live connection dropped. Your edits still save — only updates from other people are paused."
          : undefined
      }
    >
      {LAMP_TEXT[status]}
    </span>
  );
}
