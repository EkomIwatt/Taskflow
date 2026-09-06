-- TaskFlow schema (Postgres).
--
-- Applied automatically by docker-compose on first boot of the db service, and
-- by hand on Neon. SQLite (local runs and the test suite) creates its schema
-- from the SQLAlchemy models instead, so keep the two in step.
--
-- Two shapes here carry the project's authorization and ordering rules:
--   * board_members with UNIQUE (board_id, user_id) -- membership is the unit
--     of authorization, and the owner is a row here too.
--   * cards.board_id is DENORMALISED, so a card can be authorized and broadcast
--     without joining back through its list.

CREATE TABLE IF NOT EXISTS users (
    id              SERIAL PRIMARY KEY,
    email           VARCHAR(320)  NOT NULL UNIQUE,
    password_hash   VARCHAR(255)  NOT NULL,
    -- Nullable in storage; the wire always carries a value, falling back to the
    -- email local-part.
    display_name    VARCHAR(80),
    -- Bumped on logout, which invalidates every outstanding refresh token.
    token_version   INTEGER       NOT NULL DEFAULT 0,
    created_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ix_users_email ON users (email);

CREATE TABLE IF NOT EXISTS boards (
    id          SERIAL PRIMARY KEY,
    owner_id    INTEGER      NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    title       VARCHAR(80)  NOT NULL,
    -- Per-board monotonic event counter, incremented inside the same
    -- transaction as the mutation it describes (Contract 6).
    seq         BIGINT       NOT NULL DEFAULT 0,
    created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    -- Touched by every mutation anywhere in the board: GET /api/boards orders
    -- by "newest activity first".
    updated_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ix_boards_owner_id ON boards (owner_id);

CREATE TABLE IF NOT EXISTS board_members (
    id        SERIAL PRIMARY KEY,
    board_id  INTEGER      NOT NULL REFERENCES boards (id) ON DELETE CASCADE,
    user_id   INTEGER      NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    role      VARCHAR(16)  NOT NULL DEFAULT 'member',
    added_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_board_members_board_user UNIQUE (board_id, user_id)
);

CREATE INDEX IF NOT EXISTS ix_board_members_board_id ON board_members (board_id);
CREATE INDEX IF NOT EXISTS ix_board_members_user_id ON board_members (user_id);

CREATE TABLE IF NOT EXISTS lists (
    id          SERIAL PRIMARY KEY,
    board_id    INTEGER      NOT NULL REFERENCES boards (id) ON DELETE CASCADE,
    title       VARCHAR(80)  NOT NULL,
    -- Opaque fractional key. Sorted bytewise, ASCII order (Contract 4).
    order_key   VARCHAR(64)  NOT NULL,
    created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ix_lists_board_id ON lists (board_id);
CREATE INDEX IF NOT EXISTS ix_lists_board_order ON lists (board_id, order_key);

CREATE TABLE IF NOT EXISTS cards (
    id           SERIAL PRIMARY KEY,
    list_id      INTEGER       NOT NULL REFERENCES lists (id) ON DELETE CASCADE,
    -- Denormalised on purpose: board-scoped authorization and broadcast with
    -- no join to lists.
    board_id     INTEGER       NOT NULL REFERENCES boards (id) ON DELETE CASCADE,
    title        VARCHAR(255)  NOT NULL,
    description  TEXT          NOT NULL DEFAULT '',
    order_key    VARCHAR(64)   NOT NULL,
    created_by   INTEGER       REFERENCES users (id) ON DELETE SET NULL,
    created_at   TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
    updated_at   TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ix_cards_list_id ON cards (list_id);
CREATE INDEX IF NOT EXISTS ix_cards_board_id ON cards (board_id);
CREATE INDEX IF NOT EXISTS ix_cards_list_order ON cards (list_id, order_key);

CREATE TABLE IF NOT EXISTS comments (
    id          SERIAL PRIMARY KEY,
    card_id     INTEGER      NOT NULL REFERENCES cards (id) ON DELETE CASCADE,
    board_id    INTEGER      NOT NULL REFERENCES boards (id) ON DELETE CASCADE,
    author_id   INTEGER      REFERENCES users (id) ON DELETE SET NULL,
    body        TEXT         NOT NULL,
    created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ix_comments_board_id ON comments (board_id);
CREATE INDEX IF NOT EXISTS ix_comments_card_id ON comments (card_id, id);

CREATE TABLE IF NOT EXISTS activity (
    id          SERIAL PRIMARY KEY,
    board_id    INTEGER      NOT NULL REFERENCES boards (id) ON DELETE CASCADE,
    -- SET NULL, not CASCADE: deleting an account must not rewrite history.
    actor_id    INTEGER      REFERENCES users (id) ON DELETE SET NULL,
    verb        VARCHAR(32)  NOT NULL,
    -- Rendered on the server (Contract 5); the client prints it verbatim.
    summary     TEXT         NOT NULL,
    subject     JSON         NOT NULL DEFAULT '{}',
    created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ix_activity_board_id ON activity (board_id);
CREATE INDEX IF NOT EXISTS ix_activity_board_id_desc ON activity (board_id, id);
