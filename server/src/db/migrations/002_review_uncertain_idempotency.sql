-- Adds the 'uncertain' sentiment label and an idempotency key for review
-- submissions. SQLite cannot alter CHECK constraints, so the table is rebuilt.

CREATE TABLE reviews_v2 (
  id                    INTEGER PRIMARY KEY,
  short_link_id         INTEGER REFERENCES short_links (id) ON DELETE SET NULL,
  idempotency_key       TEXT    UNIQUE,
  rating                INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
  review_text           TEXT    NOT NULL,
  sentiment_status      TEXT    NOT NULL DEFAULT 'pending'
                        CHECK (sentiment_status IN ('pending', 'analyzed', 'skipped', 'failed')),
  sentiment_label       TEXT    CHECK (sentiment_label IN ('positive', 'negative', 'neutral', 'uncertain')),
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

INSERT INTO reviews_v2 (
  id, short_link_id, rating, review_text, sentiment_status, sentiment_label, sentiment_confidence,
  sentiment_p_positive, sentiment_latency_ms, sentiment_model, sentiment_error, sentiment_attempts,
  analyzed_at, consent_version, consented_at, ip_hash, created_at)
SELECT
  id, short_link_id, rating, review_text, sentiment_status, sentiment_label, sentiment_confidence,
  sentiment_p_positive, sentiment_latency_ms, sentiment_model, sentiment_error, sentiment_attempts,
  analyzed_at, consent_version, consented_at, ip_hash, created_at
FROM reviews;

DROP TABLE reviews;
ALTER TABLE reviews_v2 RENAME TO reviews;

CREATE INDEX idx_reviews_sentiment ON reviews (sentiment_label, id);
CREATE INDEX idx_reviews_rating ON reviews (rating, id);
CREATE INDEX idx_reviews_link ON reviews (short_link_id);
CREATE INDEX idx_reviews_created ON reviews (created_at);
CREATE INDEX idx_reviews_retry ON reviews (sentiment_status)
  WHERE sentiment_status IN ('pending', 'failed');
