-- 24h floor-change tracking.
-- Each polling cycle the bot records the current floor (in ETH) per tracked
-- collection. The "24h baseline" is the most recent snapshot taken at least
-- 24 hours ago, which lets the bot survive redeploys without resetting the
-- delta clock.

CREATE TABLE IF NOT EXISTS nft_alert_floor_snapshots (
  id BIGSERIAL PRIMARY KEY,
  collection_slug TEXT NOT NULL,
  floor_price_eth NUMERIC(40, 18) NOT NULL CHECK (floor_price_eth >= 0),
  taken_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_nft_alert_floor_snapshots_slug_taken_at
  ON nft_alert_floor_snapshots (collection_slug, taken_at DESC);
