import { Pool } from "pg";
import type { CanonicalSaleEvent } from "./types.js";

/**
 * Postgres-backed store for two things only:
 *   1. Dedupe + post status — UNIQUE on (chain_id, tx_hash, log_index, contract,
 *      token_id). `posted=true` means we successfully tweeted; `posted=false`
 *      means claim/retry (e.g. prior X failure).
 *   2. Floor snapshots — every poll cycle we record the current floor.
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
   * One-shot: mark legacy Seaport-RH rows as unposted so a single failed
   * pre-fix insert can be retried. Safe across restarts (bot_meta gate).
   */
  public async unstickSeaportRhOnce(): Promise<number> {
    const gate = await this.pool.query<{ value: string }>(
      `SELECT value FROM bot_meta WHERE key = 'seaport_unstick_v1'`,
    );
    if (gate.rows[0]?.value === "done") return 0;

    // Legacy rows (everything currently in the table) were inserted under the
    // old mark-before-post model. Non-Seaport collections already tweeted
    // successfully in production — leave them alone. Seaport-RH rows are the
    // ones stuck as dedupe_skip with no tweet.
    await this.pool.query(
      `
      UPDATE nft_sale_alert_events
      SET posted = true
      WHERE event_id NOT LIKE '%:seaport-rh:%'
      `,
    );
    const released = await this.pool.query(
      `
      UPDATE nft_sale_alert_events
      SET posted = false
      WHERE event_id LIKE '%:seaport-rh:%'
      `,
    );

    await this.pool.query(
      `
      INSERT INTO bot_meta (key, value, updated_at) VALUES ('seaport_unstick_v1', 'done', NOW())
      ON CONFLICT (key) DO UPDATE SET value = 'done', updated_at = NOW()
      `,
    );

    return released.rowCount ?? 0;
  }

  /**
   * One-shot: release Seaport-RH rows for retry after they were marked done
   * by the 401/403 give-up path without a tweet actually landing. Only rows
   * still inside the provider lookback window become candidates again.
   */
  public async unstickSeaportRhV2(): Promise<number> {
    // v3: v2 released the rows but posts still 403'd on the multi-cashtag
    // footer and were re-marked done. Re-release now that the footer is fixed.
    const gate = await this.pool.query<{ value: string }>(
      `SELECT value FROM bot_meta WHERE key = 'seaport_unstick_v3'`,
    );
    if (gate.rows[0]?.value === "done") return 0;

    const released = await this.pool.query(
      `
      UPDATE nft_sale_alert_events
      SET posted = false
      WHERE event_id LIKE '%:seaport-rh:%'
        AND event_timestamp > NOW() - INTERVAL '6 hours'
      `,
    );

    await this.pool.query(
      `
      INSERT INTO bot_meta (key, value, updated_at) VALUES ('seaport_unstick_v3', 'done', NOW())
      ON CONFLICT (key) DO UPDATE SET value = 'done', updated_at = NOW()
      `,
    );

    return released.rowCount ?? 0;
  }

  /**
   * One-shot: repost the most recent Seaport-RH sale (token 2439, tweeted in
   * the old format before ETH price / venue-line cleanup shipped).
   */
  public async repostLatestSaleOnce(): Promise<number> {
    const gate = await this.pool.query<{ value: string }>(
      `SELECT value FROM bot_meta WHERE key = 'seaport_repost_2439'`,
    );
    if (gate.rows[0]?.value === "done") return 0;

    const released = await this.pool.query(
      `
      UPDATE nft_sale_alert_events
      SET posted = false
      WHERE tx_hash = '0x9d3cdf09107eeac41510eafb83b979c2ee9f3a5caeac3c84bbb0cf116ce4d2c3'
        AND event_id LIKE '%:seaport-rh:%'
      `,
    );

    await this.pool.query(
      `
      INSERT INTO bot_meta (key, value, updated_at) VALUES ('seaport_repost_2439', 'done', NOW())
      ON CONFLICT (key) DO UPDATE SET value = 'done', updated_at = NOW()
      `,
    );

    return released.rowCount ?? 0;
  }

  /**
   * Claim a sale for posting.
   *   - `claim`  — new row or prior failed attempt (posted=false); caller should post
   *   - `done`   — already tweeted successfully; skip
   */
  public async claimSaleEvent(event: CanonicalSaleEvent): Promise<"claim" | "done"> {
    const inserted = await this.pool.query(
      `
      INSERT INTO nft_sale_alert_events (
        chain_id, contract, token_id, tx_hash, log_index, block_number, event_timestamp,
        marketplace, buyer, seller, price_eth, price_usd, asset_url, tx_url,
        collection_slug, event_id, payload, posted
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7,
        $8, $9, $10, $11, $12, $13, $14, $15, $16, $17::jsonb, false
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

    if (inserted.rowCount === 1) return "claim";

    const existing = await this.pool.query<{ posted: boolean }>(
      `
      SELECT posted FROM nft_sale_alert_events
      WHERE chain_id = $1 AND tx_hash = $2 AND log_index = $3 AND contract = $4 AND token_id = $5
      `,
      [event.chainId, event.txHash, event.logIndex, event.contract, event.tokenId],
    );
    if (existing.rows[0]?.posted === true) return "done";
    return "claim";
  }

  public async markSalePosted(event: CanonicalSaleEvent): Promise<void> {
    await this.pool.query(
      `
      UPDATE nft_sale_alert_events
      SET posted = true
      WHERE chain_id = $1 AND tx_hash = $2 AND log_index = $3 AND contract = $4 AND token_id = $5
      `,
      [event.chainId, event.txHash, event.logIndex, event.contract, event.tokenId],
    );
  }

  /** @deprecated prefer claimSaleEvent + markSalePosted */
  public async upsertSaleEvent(event: CanonicalSaleEvent): Promise<boolean> {
    return (await this.claimSaleEvent(event)) === "claim";
  }

  /**
   * Remove a sale from the dedupe table so it is retried next cycle.
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

  public async pruneFloorSnapshotsOlderThan(days: number): Promise<void> {
    if (!Number.isFinite(days) || days < 1) return;
    await this.pool.query(
      `DELETE FROM nft_alert_floor_snapshots WHERE taken_at < NOW() - ($1 || ' days')::INTERVAL`,
      [String(Math.floor(days))],
    );
  }
}
