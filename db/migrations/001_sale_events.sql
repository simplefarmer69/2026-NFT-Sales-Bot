-- Dedupe table for NFT sales we have already announced.
-- The UNIQUE constraint on (chain_id, tx_hash, log_index, contract, token_id)
-- is what guarantees a sale is posted exactly once, even if the bot restarts
-- mid-cycle or OpenSea returns the same event twice.

CREATE TABLE IF NOT EXISTS nft_sale_alert_events (
  id BIGSERIAL PRIMARY KEY,
  chain_id INTEGER NOT NULL DEFAULT 1,
  contract CHAR(42) NOT NULL CHECK (contract ~ '^0x[0-9a-fA-F]{40}$'),
  token_id TEXT NOT NULL,
  tx_hash CHAR(66) NOT NULL CHECK (tx_hash ~ '^0x[0-9a-fA-F]{64}$'),
  log_index INTEGER NOT NULL,
  block_number BIGINT NOT NULL,
  event_timestamp TIMESTAMPTZ,
  marketplace TEXT,
  buyer CHAR(42) CHECK (buyer ~ '^0x[0-9a-fA-F]{40}$'),
  seller CHAR(42) CHECK (seller ~ '^0x[0-9a-fA-F]{40}$'),
  price_eth NUMERIC(38, 18),
  price_usd NUMERIC(38, 10),
  asset_url TEXT,
  tx_url TEXT,
  collection_slug TEXT NOT NULL,
  event_id TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (chain_id, tx_hash, log_index, contract, token_id)
);

CREATE INDEX IF NOT EXISTS idx_nft_sale_alert_events_created_at
  ON nft_sale_alert_events (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_nft_sale_alert_events_collection_slug
  ON nft_sale_alert_events (collection_slug);
