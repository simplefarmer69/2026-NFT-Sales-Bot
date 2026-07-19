-- Track whether we successfully tweeted a sale. Previously we inserted into
-- the dedupe table BEFORE posting; a failed X call left the sale marked seen
-- forever (logs: posted=0 dedupe_skip=1 on every cycle).

ALTER TABLE nft_sale_alert_events
  ADD COLUMN IF NOT EXISTS posted BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS bot_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
