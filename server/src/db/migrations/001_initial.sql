-- All timestamps are Unix epoch milliseconds (UTC).

CREATE TABLE staff_users (
  id             INTEGER PRIMARY KEY,
  email          TEXT    NOT NULL UNIQUE COLLATE NOCASE,
  name           TEXT    NOT NULL,
  password_hash  TEXT    NOT NULL,
  role           TEXT    NOT NULL CHECK (role IN ('admin', 'manager', 'staff')),
  disabled       INTEGER NOT NULL DEFAULT 0 CHECK (disabled IN (0, 1)),
  failed_logins  INTEGER NOT NULL DEFAULT 0,
  locked_until   INTEGER,
  created_at     INTEGER NOT NULL,
  last_login_at  INTEGER
) STRICT;

-- Only a SHA-256 hash of the session token is stored, so a leaked database
-- cannot be replayed as live sessions.
CREATE TABLE sessions (
  token_hash    TEXT    PRIMARY KEY,
  user_id       INTEGER NOT NULL REFERENCES staff_users (id) ON DELETE CASCADE,
  csrf_token    TEXT    NOT NULL,
  created_at    INTEGER NOT NULL,
  last_seen_at  INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL,
  ip_hash       TEXT,
  user_agent    TEXT
) STRICT;
CREATE INDEX idx_sessions_user ON sessions (user_id);
CREATE INDEX idx_sessions_expires ON sessions (expires_at);

CREATE TABLE short_links (
  id               INTEGER PRIMARY KEY,
  code             TEXT    NOT NULL UNIQUE,
  label            TEXT    NOT NULL,
  source           TEXT,
  disabled         INTEGER NOT NULL DEFAULT 0 CHECK (disabled IN (0, 1)),
  expires_at       INTEGER,
  click_count      INTEGER NOT NULL DEFAULT 0,
  last_clicked_at  INTEGER,
  created_by       INTEGER REFERENCES staff_users (id) ON DELETE SET NULL,
  created_at       INTEGER NOT NULL
) STRICT;

CREATE TABLE reviews (
  id                    INTEGER PRIMARY KEY,
  short_link_id         INTEGER REFERENCES short_links (id) ON DELETE SET NULL,
  rating                INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
  review_text           TEXT    NOT NULL,
  sentiment_status      TEXT    NOT NULL DEFAULT 'pending'
                        CHECK (sentiment_status IN ('pending', 'analyzed', 'skipped', 'failed')),
  sentiment_label       TEXT    CHECK (sentiment_label IN ('positive', 'negative', 'neutral')),
  sentiment_confidence  REAL,
  sentiment_p_positive  REAL,
  sentiment_latency_ms  REAL,
  sentiment_model       TEXT,
  sentiment_error       TEXT,
  sentiment_attempts    INTEGER NOT NULL DEFAULT 0,
  analyzed_at           INTEGER,
  consent_version       TEXT    NOT NULL,
  consented_at          INTEGER NOT NULL,
  ip_hash               TEXT,
  created_at            INTEGER NOT NULL
) STRICT;
CREATE INDEX idx_reviews_sentiment ON reviews (sentiment_label, id);
CREATE INDEX idx_reviews_rating ON reviews (rating, id);
CREATE INDEX idx_reviews_link ON reviews (short_link_id);
CREATE INDEX idx_reviews_created ON reviews (created_at);
CREATE INDEX idx_reviews_retry ON reviews (sentiment_status)
  WHERE sentiment_status IN ('pending', 'failed');

CREATE TABLE complaints (
  id               INTEGER PRIMARY KEY,
  reference        TEXT    NOT NULL UNIQUE,
  idempotency_key  TEXT    NOT NULL UNIQUE,
  first_name       TEXT    NOT NULL,
  last_name        TEXT    NOT NULL,
  email            TEXT    NOT NULL,
  phone            TEXT    NOT NULL,
  rating           INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
  details          TEXT    NOT NULL,
  status           TEXT    NOT NULL DEFAULT 'open'
                   CHECK (status IN ('open', 'in_progress', 'resolved')),
  consent_version  TEXT    NOT NULL,
  consented_at     INTEGER NOT NULL,
  ip_hash          TEXT,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
) STRICT;
CREATE INDEX idx_complaints_status ON complaints (status, id);
CREATE INDEX idx_complaints_created ON complaints (created_at);

-- Transactional outbox. Message bodies are rendered from the complaint at
-- send time so patient data is not duplicated here.
CREATE TABLE email_outbox (
  id                   INTEGER PRIMARY KEY,
  dedupe_key           TEXT    NOT NULL UNIQUE,
  kind                 TEXT    NOT NULL,
  complaint_id         INTEGER REFERENCES complaints (id) ON DELETE CASCADE,
  to_address           TEXT    NOT NULL,
  status               TEXT    NOT NULL DEFAULT 'pending'
                       CHECK (status IN ('pending', 'sending', 'sent', 'failed')),
  attempts             INTEGER NOT NULL DEFAULT 0,
  next_attempt_at      INTEGER NOT NULL,
  locked_until         INTEGER,
  last_error           TEXT,
  provider_message_id  TEXT,
  sent_at              INTEGER,
  created_at           INTEGER NOT NULL,
  updated_at           INTEGER NOT NULL
) STRICT;
CREATE INDEX idx_outbox_due ON email_outbox (status, next_attempt_at);
CREATE INDEX idx_outbox_complaint ON email_outbox (complaint_id);

CREATE TABLE audit_log (
  id          INTEGER PRIMARY KEY,
  user_id     INTEGER REFERENCES staff_users (id) ON DELETE SET NULL,
  action      TEXT    NOT NULL,
  entity      TEXT,
  entity_id   TEXT,
  ip_hash     TEXT,
  created_at  INTEGER NOT NULL
) STRICT;
CREATE INDEX idx_audit_created ON audit_log (created_at);
