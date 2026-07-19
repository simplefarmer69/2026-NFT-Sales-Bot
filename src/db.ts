import { Pool } from "pg";
import type { CanonicalSaleEvent } from "./types.js";

/**
 * Postgres-backed store for two things only:
 *   1. Dedupe — a UNIQUE constraint on (chain_id, tx_hash, log_index, contract,
 *      token_id) means inserting a duplicate is a no-op. We use the rowCount
 *      to learn whether a sale was new (1) or already-seen (0).
 *   2. Floor snapshots — every poll cycle we record the current floor. The
 *      "24h ago" baseline is the most recent snapshot taken at least 24h ago.
 */
export class AlertBotDb {
  private readonly pool: Pool;

  public constructor(databaseUrl: string) {
    this.pool = new Pool({ connectionString: databaseUrl });
  }

  public async ping(): Promise<void> {
    await this.pool.query("SELECT 1");
  }

  public async close(): Promise<void> {
    await this.pool.end();
  }

  /**
   * Returns true if this is the first time we've seen the event (newly inserted),
   * false if it was already in the dedupe table.
   */
  public async upsertSaleEvent(event: CanonicalSaleEvent): Promise<boolean> {
    const result = await this.pool.query(
      `
      INSERT INTO nft_sale_alert_events (
        chain_id, contract, token_id, tx_hash, log_index, block_number, event_timestamp,
        marketplace, buyer, seller, price_eth, price_usd, asset_url, tx_url,
        collection_slug, event_id, payload
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7,
        $8, $9, $10, $11, $12, $13, $14, $15, $16, $17::jsonb
      )
      ON CONFLICT (chain_id, tx_hash, log_index, contract, token_id) DO NOTHING
      `,
      [
        event.chainId,
        event.contract,
        event.tokenId,
        event.txHash,
        event.logIndex,
        event.blockNumber.toString(),
        event.timestamp,
        event.marketplace,
        event.buyer,
        event.seller,
        event.priceEth,
        event.priceUsd,
        event.assetUrl,
        event.txUrl,
        event.collectionSlug,
        event.eventId,
        JSON.stringify(event.payload ?? {}),
      ],
    );
    return result.rowCount === 1;
  }

  /**
   * Remove a sale from the dedupe table so it is retried next cycle.
   * Used when the X post fails with a transient error (rate limit) — without
   * this, a sale that 429s is marked seen and silently never posted.
   */
  public async releaseSaleEvent(event: CanonicalSaleEvent): Promise<void> {
    await this.pool.query(
      `
      DELETE FROM nft_sale_alert_events
      WHERE chain_id = $1 AND tx_hash = $2 AND log_index = $3 AND contract = $4 AND token_id = $5
      `,
      [event.chainId, event.txHash, event.logIndex, event.contract, event.tokenId],
    );
  }

  public async recordFloorSnapshot(collectionSlug: string, floorPriceEth: number): Promise<void> {
    if (!Number.isFinite(floorPriceEth) || floorPriceEth < 0) return;
    await this.pool.query(
      `INSERT INTO nft_alert_floor_snapshots (collection_slug, floor_price_eth) VALUES ($1, $2)`,
      [collectionSlug, floorPriceEth],
    );
  }

  /**
   * Best-available baseline floor for a collection.
   *   1. Prefer the most recent snapshot taken at least 24h ago (true rolling 24h delta).
   *   2. If we don't yet have 24h of history, fall back to the OLDEST snapshot we have
   *      so day-1 still produces a meaningful (early-baseline-flagged) value. The
   *      caller is responsible for suppressing the line until ageHours >= 24.
   *   3. If we have no snapshots at all (or only one taken just now), return null.
   */
  public async getFloorBaseline(collectionSlug: string): Promise<{
    floorPriceEth: number;
    takenAt: Date;
    ageHours: number;
  } | null> {
    const preferred = await this.pool.query<{ floor_price_eth: string; taken_at: Date }>(
      `
      SELECT floor_price_eth, taken_at
      FROM nft_alert_floor_snapshots
      WHERE collection_slug = $1
        AND taken_at <= NOW() - INTERVAL '24 hours'
      ORDER BY taken_at DESC
      LIMIT 1
      `,
      [collectionSlug],
    );

    let row: { floor_price_eth: string; taken_at: Date } | undefined = preferred.rows[0];
    if (!row) {
      const oldest = await this.pool.query<{ floor_price_eth: string; taken_at: Date }>(
        `
        SELECT floor_price_eth, taken_at
        FROM nft_alert_floor_snapshots
        WHERE collection_slug = $1
        ORDER BY taken_at ASC
        LIMIT 1
        `,
        [collectionSlug],
      );
      row = oldest.rows[0];
    }
    if (!row) return null;

    const value = Number(row.floor_price_eth);
    if (!Number.isFinite(value) || value <= 0) return null;
    const ageMs = Date.now() - row.taken_at.getTime();
    if (ageMs <= 0) return null;
    return {
      floorPriceEth: value,
      takenAt: row.taken_at,
      ageHours: ageMs / (60 * 60 * 1000),
    };
  }

  /** Housekeeping: delete snapshots older than `days` days. */
  public async pruneFloorSnapshotsOlderThan(days: number): Promise<void> {
    if (!Number.isFinite(days) || days < 1) return;
    await this.pool.query(
      `DELETE FROM nft_alert_floor_snapshots WHERE taken_at < NOW() - ($1 || ' days')::INTERVAL`,
      [String(Math.floor(days))],
    );
  }
}
