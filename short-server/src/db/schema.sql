-- Owned by short-server.
CREATE TABLE IF NOT EXISTS links (
    id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    code       TEXT        NOT NULL UNIQUE,
    target_url TEXT        NOT NULL,
    clicks     INTEGER     NOT NULL DEFAULT 0,
    user_id    UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS links_user_id_idx ON links (user_id);
